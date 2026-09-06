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
./mcbot.ts stop
```

Exec'd code has these names in scope: `bot`, `mineflayer`, `Vec3`, `require`, `state` (object that persists across execs), `reconnect(opts?)` (end the bot and create a new one, optionally overriding options), `log`.

`start` runs in the foreground so you can keep it open in a spare terminal; its output also goes to the log file. With `-d` it detaches and only the log file gets output.

Multiple bots: `-n NAME` on every command. Extra `--key=value` flags on `start` are passed straight into `createBot` options. Files (pid, socket, log) live in `~/.mcbot`, override with `MCBOT_DIR`.

`-t MS` sets the per-exec timeout (default 30s). A timeout only stops waiting; the code keeps running in the daemon.

Layout: `mcbot.ts` is the CLI, `daemon.ts` is the detached process (bot + unix socket eval server), `protocol.ts` is the newline-delimited JSON wire format between them.
