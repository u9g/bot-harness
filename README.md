# bot-harness

Start a mineflayer bot as a detached background process, then run code against it from the shell.

Runs directly on Node 24 (type stripping), no build step. Defaults to Minecraft 26.1 (`-v` to override). To hack on mineflayer itself, `pnpm link ../mineflayer`.

```sh
pnpm install
./mcbot.ts start --host localhost --port 25565 -u Tester   # stays attached until the bot exits; ctrl-c stops it
./mcbot.ts start -d ...                                               # or detach; then use `logs -f` to watch
./mcbot.ts exec 'bot.entity.position'                                 # expression -> printed with util.inspect
./mcbot.ts exec 'bot.chat("hi"); await bot.waitForTicks(20); return bot.health'   # async fn body
./mcbot.ts exec -f script.js                                          # or `-` for stdin
./mcbot.ts exec 'await bot.pathfinder.goto(new goals.GoalNear(10, 64, -5, 1))'   # mineflayer-pathfinder is loaded
./mcbot.ts record start                                               # first-person mp4 of what the bot sees
./mcbot.ts record snapshot -o now.png                                 # PNG of the latest frame
./mcbot.ts record stop                                                # prints the mp4 path
./mcbot.ts stop
```

Exec'd code has these names in scope: `bot`, `mineflayer`, `Vec3`, `goals` and `Movements` (from mineflayer-pathfinder, which is loaded into every bot; `bot.pathfinder.setMovements(new Movements(bot))` to customise), `record` (`record.start(file?, opts?)`, `record.snapshot(file?)`, `record.stop()`; see below), `require`, `state` (object that persists across execs), `reconnect(opts?)` (end the bot and create a new one, optionally overriding options), `log`.

`human` walks like a player instead of like the pathfinder's executor: `await human.walkTo(new Vec3(x, y, z), { faceAt: npcEyes })` plans the route with mineflayer-pathfinder, string-pulls it, then steers by pure pursuit while the head turns in discrete mouse-like gestures, sprints after a human delay, sprint-jumps at a personal rate and coasts to a stop; `human.lookAt(point)` is one such gesture. Each bot gets a random `human.personality` (seedable through `createHuman(bot, { seed })`), calibrated on players recorded in a Jartex lobby; see the top of `human.ts` for the numbers.

`start` runs in the foreground so you can keep it open in a spare terminal; its output also goes to the log file. With `-d` it detaches and only the log file gets output.

## Recording

`record start` renders the bot's first-person view with prismarine-viewer's core through headless-gl (no browser, no node-canvas) and pipes the frames to ffmpeg as an mp4; `record stop` finishes the file. Defaults are 640x360 at 20 fps with a 4-chunk view distance (`--width`, `--height`, `--fps`, `--dist`), one mesher worker thread (`--workers 0` meshes on the bot's own thread instead). Files default to `~/.mcbot/NAME-TIMESTAMP.mp4` (`-o` to choose). The video runs at wall-clock speed: a frame that renders late is repeated, not dropped.

Needs `ffmpeg` on PATH and, on Linux, an X display for headless-gl (an Xvfb is started on `:99` when `DISPLAY` is unset; `apt install xvfb libgl1-mesa-dri`). The viewer is the host-object build of prismarine-viewer (PrismarineJS/prismarine-viewer#502, packed as a release tarball on u9g/prismarine-viewer) and ships assets up to 1.21.4, so start the bot with `-v 1.21.4` (or another version it supports) when you want to record; `record start` names the supported versions when asked for one it lacks.

For a local test server: grab the 26.1 server jar from Mojang's version manifest, set `online-mode=false` and `eula=true`, and run it with Java 25 or newer.

Multiple bots: `-n NAME` on every command. Extra `--key=value` flags on `start` are passed straight into `createBot` options. Files (pid, socket, log) live in `~/.mcbot`, override with `MCBOT_DIR`.

`-t MS` sets the per-exec timeout (default 30s). A timeout only stops waiting; the code keeps running in the daemon.

Layout: `mcbot.ts` is the CLI, `daemon.ts` is the detached process (bot + unix socket eval server), `protocol.ts` is the newline-delimited JSON wire format between them.
