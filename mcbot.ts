#!/usr/bin/env node
// mcbot start|exec|record|stop|status|logs|list — see usage()
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import type { BotOpts, DaemonOpts, ExecReply, ExecRequest } from './protocol.ts'

const DIR = process.env.MCBOT_DIR ?? path.join(os.homedir(), '.mcbot')
fs.mkdirSync(DIR, { recursive: true })

function usage (): never {
  console.error(`usage:
  mcbot start ID [-d] [--host H] [--port P] [-u USERNAME] [-v VERSION=26.1] [--auth offline|microsoft] [--key=value ...]
              runs until the bot process exits (ctrl-c stops it); -d detaches instead
  mcbot exec  ID [-t TIMEOUT_MS] <code>   code is an expression or async fn body
                                          in scope: bot, human, createHuman, mineflayer, Vec3, goals, Movements, record, require, state, reconnect, log
  mcbot exec  ID -f FILE | -              read code from file / stdin
  mcbot record ID start [-o FILE.mp4] [--width 640] [--height 360] [--fps 20] [--dist 4] [--workers 1] [--duty 0.25]
  mcbot record ID snapshot [-o FILE.png]  PNG of the latest recorded frame
  mcbot record ID stop                    finish the video; prints its path
  mcbot stop   ID
  mcbot status ID
  mcbot logs   ID [-f]
  mcbot list                              every bot in ${DIR} with its server
ID names one bot: 1-29 characters from A-Z a-z 0-9 _ -, chosen at start and given to every other command.
Files live in ${DIR}.`)
  process.exit(2)
}

type Flags = Record<string, string | true | undefined>

function parse (argv: string[]): { flags: Flags, rest: string[] } {
  const flags: Flags = {}; const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a)
    if (!m) { rest.push(a); continue }
    const key = m[1]
    if (m[2] !== undefined) flags[key] = m[2]
    else if ((key === 'f' && cmd !== 'exec') || key === 'd') flags[key] = true
    else flags[key] = argv[++i]
  }
  return { flags, rest }
}

const str = (v: string | true | undefined): string | undefined => typeof v === 'string' ? v : undefined

const [cmd, ...argv] = process.argv.slice(2)
const { flags, rest } = parse(argv)
// Every command but list addresses one bot by the id given at start: several shells share DIR,
// so nothing is ever picked by default.
function botId (): string {
  const id = rest.shift()
  if (id === undefined) { console.error(`${cmd}: missing bot ID`); usage() }
  if (!/^[\w-]{1,29}$/.test(id)) { console.error(`bad bot ID ${JSON.stringify(id)}: 1-29 characters from A-Z a-z 0-9 _ -`); process.exit(2) }
  return id
}
const name = ['start', 'exec', 'record', 'stop', 'status', 'logs'].includes(cmd) ? botId() : ''
const files = filesFor(name)

function filesFor (id: string): { sock: string, pidFile: string, logFile: string, infoFile: string } {
  return {
    sock: path.join(DIR, `${id}.sock`),
    pidFile: path.join(DIR, `${id}.pid`),
    logFile: path.join(DIR, `${id}.log`),
    infoFile: path.join(DIR, `${id}.json`)
  }
}
function pidOf (id: string): number | null {
  try { return Number(fs.readFileSync(filesFor(id).pidFile, 'utf8')) } catch { return null }
}
const pid = (): number | null => pidOf(name)
function alive (p: number): boolean { try { process.kill(p, 0); return true } catch { return false } }

function start (): void {
  const p = pid()
  if (p && alive(p)) { console.error(`${name} already running (pid ${p})`); process.exit(1) }
  const { d, host, port, u, username, v, version, auth, ...extra } = flags
  const detached = d !== undefined
  const bot: BotOpts = {
    host: str(host) ?? 'localhost',
    port: Number(str(port) ?? 25565),
    username: str(u) ?? str(username) ?? name,
    auth: (str(auth) ?? 'offline') as BotOpts['auth'],
    version: str(v) ?? str(version) ?? '26.1',
    ...extra
  }
  const daemonOpts: DaemonOpts = { name, dir: DIR, bot, sock: files.sock, pidFile: files.pidFile }
  const out = fs.openSync(files.logFile, 'a')
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'daemon.ts')], {
    detached,
    stdio: detached ? ['ignore', out, out] : ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MCBOT_OPTS: JSON.stringify(daemonOpts) }
  })
  fs.writeFileSync(files.pidFile, String(child.pid))
  fs.writeFileSync(files.infoFile, JSON.stringify({ host: bot.host, port: bot.port, username: bot.username, version: bot.version, started: new Date().toISOString() }))
  console.log(`started ${name} pid ${child.pid} -> ${bot.host}:${bot.port} as ${bot.username}\nlog: ${files.logFile}`)
  if (detached) { child.unref(); return }
  // foreground: stream daemon output here and to the log file, forward ctrl-c, exit when it exits
  const logStream = fs.createWriteStream('', { fd: out })
  for (const s of [child.stdout!, child.stderr!]) { s.pipe(process.stdout); s.pipe(logStream) }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => child.kill('SIGTERM'))
  child.on('exit', (code, sig) => { console.log(`${name} exited (${sig ?? code})`); process.exit(code ?? 0) })
}

function connect (): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(files.sock)
    c.once('connect', () => resolve(c))
    c.once('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(`cannot connect to ${name} (${e.code}); is it started? try: mcbot status ${name}`)))
  })
}

async function exec (): Promise<void> {
  let code: string
  if (str(flags.f)) code = fs.readFileSync(str(flags.f)!, 'utf8')
  else if (rest[0] === '-' || rest.length === 0) code = fs.readFileSync(0, 'utf8')
  else code = rest.join(' ')
  return send(code)
}

/** Sugar over exec for the `record` scope object. */
function record (): Promise<void> {
  const out = str(flags.o) ?? str(flags.out)
  const file = out ? JSON.stringify(path.resolve(out)) : 'undefined'
  switch (rest[0]) {
    case 'start': {
      const num = (k: string): number | undefined => str(flags[k]) ? Number(flags[k]) : undefined
      const o = { width: num('width'), height: num('height'), fps: num('fps'), viewDistance: num('dist'), numWorkers: num('workers'), duty: num('duty') }
      return send(`record.start(${file}, ${JSON.stringify(o)})`)
    }
    case 'snapshot': return send(`record.snapshot(${file})`)
    case 'stop': return send('record.stop()')
    default: usage()
  }
}

async function send (code: string): Promise<void> {
  const c = await connect()
  const req: ExecRequest = { id: 1, code, timeout: str(flags.t) ? Number(flags.t) : undefined }
  c.write(JSON.stringify(req) + '\n')
  let buf = ''
  c.on('data', d => {
    buf += d
    const i = buf.indexOf('\n')
    if (i < 0) return
    const res: ExecReply = JSON.parse(buf.slice(0, i))
    c.end()
    if (res.ok) { if (res.value !== 'undefined') console.log(res.value); process.exit(0) }
    console.error(res.error); process.exit(1)
  })
}

function stop (): void {
  const p = pid()
  if (!p || !alive(p)) { console.error(`${name} not running`); for (const f of [files.pidFile, files.infoFile]) { try { fs.unlinkSync(f) } catch {} }; process.exit(1) }
  process.kill(p, 'SIGTERM')
  console.log(`sent SIGTERM to ${name} (pid ${p})`)
}

function status (): void {
  const p = pid()
  const up = p !== null && alive(p)
  console.log(`${name}: ${up ? `running pid ${p}` : 'stopped'}  sock=${files.sock}`)
  process.exit(up ? 0 : 1)
}

function logs (): void {
  if (!fs.existsSync(files.logFile)) { console.error('no log'); process.exit(1) }
  const args = flags.f || flags.follow ? ['-n', '50', '-f', files.logFile] : ['-n', '50', files.logFile]
  spawn('tail', args, { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 0))
}

function list (): void {
  for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.pid'))) {
    const id = f.slice(0, -4); const p = pidOf(id)!
    let target = ''
    try {
      const info = JSON.parse(fs.readFileSync(filesFor(id).infoFile, 'utf8'))
      target = `  -> ${info.host}:${info.port} as ${info.username} (${info.version}, since ${info.started})`
    } catch {}
    console.log(`${id}: ${alive(p) ? `running pid ${p}` : 'stale'}${target}`)
  }
}

const commands: Record<string, () => void | Promise<void>> = { start, exec, record, stop, status, logs, list }
void (commands[cmd] ?? usage)()
