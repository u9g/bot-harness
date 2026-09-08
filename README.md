# bot-harness

Start a mineflayer bot as a detached background process, then run code against it from the shell.

Runs directly on Node 24 (type stripping), no build step. Defaults to Minecraft 26.1 (`-v` to override). The Minecraft libraries it runs on live in `packages/` and are rebuilt by a bot (see [The stack](#the-stack)); edit them upstream, not here.

```sh
pnpm install
./mcbot.ts start t1 --host localhost --port 25565 -u Tester   # stays attached until the bot exits; ctrl-c stops it
./mcbot.ts start t1 -d ...                                            # or detach; then use `logs t1 -f` to watch
./mcbot.ts exec t1 'bot.entity.position'                              # expression -> printed with util.inspect
./mcbot.ts exec t1 'bot.chat("hi"); await bot.waitForTicks(20); return bot.health'   # async fn body
./mcbot.ts exec t1 -f script.js                                       # or `-` for stdin
./mcbot.ts exec t1 'await bot.pathfinder.goto(new goals.GoalNear(10, 64, -5, 1))'   # mineflayer-pathfinder is loaded
./mcbot.ts exec t1 'await human.walkTo(new Vec3(10, 64, -5))'         # ...or walk it the way a player would
./mcbot.ts record t1 start                                            # first-person mp4 of what the bot sees
./mcbot.ts record t1 snapshot -o now.png                              # PNG of the latest frame
./mcbot.ts record t1 stop                                             # prints the mp4 path
./mcbot.ts stop t1
```

Exec'd code has these names in scope: `bot`, `human` (mineflayer-pathfinder's `createHuman(bot)` controller, built on first use: `human.walkTo(goal, { radius, faceAt, timeout })`, `human.lookAt(point)`, `human.stop()`), `mineflayer`, `Vec3`, `goals` and `Movements` (from mineflayer-pathfinder, which is loaded into every bot; `bot.pathfinder.setMovements(new Movements(bot))` to customise), `record` (`record.start(file?, opts?)`, `record.snapshot(file?)`, `record.stop()`; see below), `require` (resolves the harness's own dependencies first, then whatever mineflayer can see, so `require('prismarine-chat')(bot.registry)` and friends work; `require.resolve(id, { paths })` follows the same fallback), `state` (object that persists across execs), `reconnect(opts?)` (end the bot and create a new one, optionally overriding options; awaits the new bot's spawn, and `bot` in the same exec keeps naming the old one), `log`.

`start` runs in the foreground so you can keep it open in a spare terminal; its output also goes to the log file. With `-d` it detaches and only the log file gets output.

`status` reports the daemon and then the bot, because the two come apart: a kicked bot keeps its daemon, its `bot.entity` and its `physicsEnabled` flag and only stops sending packets, so a control loop can drive it for minutes without noticing. It prints `connected` with the login time, position and health, or `DISCONNECTED` with the last kick, end and error the daemon saw, and exits non-zero unless the bot is connected.

## Recording

`record start` renders the bot's first-person view with prismarine-viewer's core through headless-gl (no browser, no node-canvas) and pipes the frames to ffmpeg as an mp4; `record stop` finishes the file. Defaults are 640x360 at 20 fps with a 4-chunk view distance (`--width`, `--height`, `--fps`, `--dist`), one mesher worker thread (`--workers 0` meshes on the bot's own thread instead), and a 25% render duty cycle (`--duty`). Files default to `~/.mcbot/NAME-TIMESTAMP.mp4` (`-o` to choose). The video runs at wall-clock speed: a frame that renders late is repeated, not dropped. A recording ends with the bot's connection: a kick or a timeout finishes the file and logs `recorded <path>`, so a dead bot never leaves the renderer running or the mp4 without its index.

Rendering is synchronous, so every frame stops the bot for as long as it takes to draw. The recorder therefore idles for `cost / duty - cost` after each frame, holding the renderer to `--duty` of wall-clock (25% by default) and leaving the rest to the bot's physics and packet handling. Raising the resolution or view distance past what the machine can draw in a few milliseconds costs frame rate rather than the bot's timing: at 854x480 with `--dist 5` on llvmpipe a frame takes 30-90 ms, and a recorder that rendered back to back there desynced the bot enough for a server anticheat to kick it.

Needs `ffmpeg` on PATH and, on Linux, an X display for headless-gl. `DISPLAY` is used when set, otherwise the lowest X server socket already in `/tmp/.X11-unix` (so a desktop session's `:0` reaches the real GPU driver), and only failing that is an Xvfb started on `:99` (`apt install xvfb libgl1-mesa-dri`). Xvfb has no GPU driver, so it renders with llvmpipe: 14.6 ms for a frame that the host display draws in 0.28 ms on this machine. The viewer is the host-object build of prismarine-viewer (PrismarineJS/prismarine-viewer#502, packed as a release tarball on u9g/prismarine-viewer) and ships assets up to 26.1 (tarball `v1.33.0-host26.1`, which also carries PrismarineJS/prismarine-viewer#484 for 26.1), so the default `-v 26.1` records as is; `record start` names the supported versions when asked for one it lacks.

For a local test server: grab the 26.1 server jar from Mojang's version manifest, set `online-mode=false` and `eula=true`, and run it with Java 25 or newer.

Every command except `list` takes the bot's ID first: `start` requires one (1-29 characters, letters, digits, `_`, `-`) and the other commands use it to pick which bot they talk to, so there is no default that two shells could both mean. The in-game username defaults to the ID. `mcbot list` shows every bot in the directory with its server. Extra `--key=value` flags on `start` are passed straight into `createBot` options. Files (pid, socket, log, json info) live in `~/.mcbot`, override with `MCBOT_DIR`.

Once the bot's connection is gone it keeps answering `exec` with whatever state it still holds, so `state` and the packet history stay readable; every reply then carries the reason on stderr (`t1 is disconnected (kicked: ...)`). `reconnect()` clears it.

`-t MS` sets the per-exec timeout (default 30s). A timeout only stops waiting; the code keeps running in the daemon.

Layout: `mcbot.ts` is the CLI, `daemon.ts` is the detached process (bot + unix socket eval server), `protocol.ts` is the newline-delimited JSON wire format between them.

## The stack

`packages/` holds the libraries the harness runs on (mineflayer, minecraft-data with its data submodule inlined, minecraft-protocol, protodef with its ProtoDef schemas inlined, prismarine-item, prismarine-physics, prismarine-viewer, mineflayer-pathfinder). Each is upstream `master` plus every open PR by the author in `stack/config.json`, applied as one squash per PR. The `stack` workflow rebuilds them every 5 minutes (GitHub runs the schedule late at busy times) and commits one change per package, so `git log -- packages/mineflayer` reads as the history of those PRs and `stack/lock.json` says which PR heads are in and how each went in. Root `pnpm-workspace.yaml` overrides every one of those names to `workspace:*`, so transitive requires resolve to `packages/` too.

Anything in `packages/` is overwritten by the next rebuild; changes go upstream as PRs and arrive here on their own. A PR that stops applying cleanly is cherry-picked in a scratch worktree instead: `git rerere` replays a resolution recorded in `stack/rr-cache/`, and a new conflict is handed to the [pi coding agent](https://github.com/badlogic/pi-mono) running in that worktree against a Z.ai GLM model (`ZAI_API_KEY` secret, `ZAI_MODEL` repository variable, default `glm-5.3`). The agent may only edit the unmerged paths, because rerere replays only those; an edit elsewhere, a leftover marker, a file that stops parsing, or an answer starting with `CANNOT:` drops the PR instead of committing it. Without a key, or when the agent fails, the PR is dropped for that cycle and listed in the lock file and the run summary; it is retried on the next cycle once a key is present. After a change the workflow refreshes `pnpm-lock.yaml`, runs `pnpm typecheck` and `node stack/smoke.ts` (loads every package), and only then pushes.

`node stack/build.ts` does the same locally (`--dry-run` to only report, `--only=mineflayer,prismarine-viewer` to limit); it needs a clean tree, `gh auth` or `GH_TOKEN`, and keeps the upstream objects in `.stack-mirror/`, which is safe to delete.
