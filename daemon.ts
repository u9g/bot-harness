// Runs in the detached process. Owns one bot and a unix socket that evals code against it.
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { createRequire } from 'node:module'
import mineflayer, { type Bot, type BotOptions } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { DaemonOpts, ExecRequest, ExecReply } from './protocol.ts'
import { startRecording, type RecordOpts, type Recording } from './record.ts'
import { createHuman, type Human } from './human.ts'

const require = createRequire(import.meta.url)
const { pathfinder, Movements, goals } = pathfinderPkg

const opts: DaemonOpts = JSON.parse(process.env.MCBOT_OPTS!)
const botOpts = opts.bot as BotOptions

const log = (...a: unknown[]): void => console.log(new Date().toISOString(), ...a)

/** Persists across exec calls; scripts can stash anything here. */
const state: Record<string, unknown> = {}
let human: Human | null = null
let bot: Bot = createBot()

function createBot (): Bot {
  const b = mineflayer.createBot(botOpts)
  b.loadPlugin(pathfinder)
  b.on('login', () => log('login', b.username))
  b.on('spawn', () => log('spawn', b.entity.position))
  b.on('kicked', r => log('kicked', typeof r === 'string' ? r : JSON.stringify(r)))
  b.on('error', e => log('error', e.stack ?? e))
  b.on('end', r => log('end', r))
  b.on('messagestr', m => log('chat', m))
  human = null
  return b
}

function reconnect (newOpts: Partial<BotOptions> = {}): string {
  if (recording) void record.stop()
  try { bot.end('reconnect') } catch {}
  Object.assign(botOpts, newOpts)
  bot = createBot()
  return 'reconnecting'
}

// At most one recording per bot at a time.
let recording: Recording | null = null
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const record = {
  async start (file = path.join(opts.dir, `${opts.name}-${stamp()}.mp4`), recordOpts?: RecordOpts): Promise<string> {
    if (recording) throw new Error(`already recording to ${recording.file}`)
    recording = await startRecording(bot, path.resolve(file), recordOpts)
    log('recording', recording.file)
    return recording.file
  },
  snapshot (file = path.join(opts.dir, `${opts.name}-${stamp()}.png`)): Promise<string> {
    if (!recording) throw new Error('not recording')
    return recording.snapshot(path.resolve(file))
  },
  async stop (): Promise<string> {
    if (!recording) throw new Error('not recording')
    const r = recording
    recording = null
    const file = await r.stop()
    log('recorded', file)
    return file
  }
}

/** Names visible inside exec'd code, in order. Keep in sync with `usage()` in mcbot.ts. */
const SCOPE = { bot: () => bot, human: () => human ??= createHuman(bot), mineflayer, Vec3, goals, Movements, record, require, state, reconnect, log }
const SCOPE_NAMES = Object.keys(SCOPE)

type ExecFn = (...args: unknown[]) => Promise<unknown>
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => ExecFn

function compile (code: string): ExecFn {
  try { return new AsyncFunction(...SCOPE_NAMES, `return (${code}\n)`) } catch {}
  return new AsyncFunction(...SCOPE_NAMES, code)
}

async function run ({ code, timeout = 30_000 }: ExecRequest): Promise<unknown> {
  const fn = compile(code)
  const args = SCOPE_NAMES.map(k => k === 'bot' || k === 'human' ? (SCOPE[k] as () => unknown)() : SCOPE[k as keyof typeof SCOPE])
  let timer: NodeJS.Timeout
  const timedOut = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`exec timed out after ${timeout}ms (still running in daemon)`)), timeout)
  })
  try { return await Promise.race([fn(...args), timedOut]) } finally { clearTimeout(timer!) }
}

function serialize (v: unknown): string {
  if (typeof v === 'string') return v
  return util.inspect(v, { depth: 4, breakLength: 100, maxArrayLength: 200 })
}

try { fs.unlinkSync(opts.sock) } catch {}
const server = net.createServer(conn => {
  const send = (r: ExecReply): void => { conn.write(JSON.stringify(r) + '\n') }
  let buf = ''
  conn.on('data', d => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let req: ExecRequest
      try { req = JSON.parse(line) } catch { send({ id: -1, ok: false, error: 'bad json' }); continue }
      run(req).then(
        value => send({ id: req.id, ok: true, value: serialize(value) }),
        (err: unknown) => send({ id: req.id, ok: false, error: err instanceof Error ? err.stack ?? err.message : String(err) })
      ).catch(() => {})
    }
  })
  conn.on('error', () => {})
})
server.listen(opts.sock, () => log('listening', opts.sock))

function shutdown (sig: string): void {
  log('shutdown', sig)
  try { bot.end('shutdown') } catch {}
  try { fs.unlinkSync(opts.sock) } catch {}
  try { fs.unlinkSync(opts.pidFile) } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', e => log('uncaughtException', e.stack ?? e))
process.on('unhandledRejection', e => log('unhandledRejection', e instanceof Error ? e.stack : e))
