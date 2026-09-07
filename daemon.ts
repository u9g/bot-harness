// Runs in the detached process. Owns one bot and a unix socket that evals code against it.
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { createRequire } from 'node:module'
import mineflayer, { type Bot, type BotOptions } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { BotStatus, DaemonOpts, ExecRequest, ExecReply, Request, StatusRequest } from './protocol.ts'
import { startRecording, type RecordOpts, type Recording } from './record.ts'

const ownRequire = createRequire(import.meta.url)
// pnpm gives the harness a strict node_modules, so a bare createRequire here reaches only the
// harness's own dependencies. Exec'd code wants the Minecraft libraries the bot is built out of
// (prismarine-chat, prismarine-nbt, minecraft-data, ...), so fall back to mineflayer's resolution.
const stackRequire = createRequire(ownRequire.resolve('mineflayer'))
const require = (id: string): unknown => {
  try {
    return ownRequire(id)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw e
    return stackRequire(id)
  }
}
const { pathfinder, Movements, goals, createHuman } = pathfinderPkg

const opts: DaemonOpts = JSON.parse(process.env.MCBOT_OPTS!)
const botOpts = opts.bot as BotOptions

const log = (...a: unknown[]): void => console.log(new Date().toISOString(), ...a)

/** Persists across exec calls; scripts can stash anything here. */
const state: Record<string, unknown> = {}
// One human controller per bot, built on first use; a new bot needs a new one.
let human: ReturnType<typeof createHuman> | null = null
let bot: Bot = createBot()

// What the bot is doing, as opposed to whether this process is alive: a kicked bot keeps its
// daemon, its entity and its physicsEnabled flag, and only stops sending packets.
const health: {
  connected: boolean
  loginAt?: string
  lastKick?: { at: string, reason: string }
  lastEnd?: { at: string, reason: string }
  lastError?: { at: string, message: string }
} = { connected: false }
const now = (): string => new Date().toISOString()

function createBot (): Bot {
  const b = mineflayer.createBot(botOpts)
  b.loadPlugin(pathfinder)
  b.on('login', () => { health.connected = true; health.loginAt = now(); log('login', b.username) })
  b.on('spawn', () => log('spawn', b.entity.position))
  b.on('kicked', r => {
    const reason = typeof r === 'string' ? r : JSON.stringify(r)
    health.lastKick = { at: now(), reason }
    log('kicked', reason)
  })
  b.on('error', e => { health.lastError = { at: now(), message: e.message ?? String(e) }; log('error', e.stack ?? e) })
  b.on('end', r => {
    health.connected = false
    health.lastEnd = { at: now(), reason: String(r) }
    log('end', r)
    // The recorder draws the bot's view; with the connection gone there is nothing left to draw, and
    // a renderer left running holds its share of the event loop and grows the file until someone
    // remembers to stop it.
    void stopRecording('bot ended')
  })
  b.on('messagestr', m => log('chat', m))
  human = null
  return b
}

const isStatus = (r: Request): r is StatusRequest => (r as StatusRequest).status === true

function status (): BotStatus {
  const pos = bot.entity?.position
  return {
    connected: health.connected,
    username: bot.username ?? opts.bot.username,
    host: botOpts.host ?? opts.bot.host,
    port: botOpts.port ?? opts.bot.port,
    version: botOpts.version ?? opts.bot.version,
    loginAt: health.loginAt,
    position: pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined,
    health: bot.health,
    lastKick: health.lastKick,
    lastEnd: health.lastEnd,
    lastError: health.lastError
  }
}

/**
 * Ends the bot and creates a new one, resolving once it has spawned. The `bot` name in the
 * calling exec keeps pointing at the old bot, so wait on this rather than on `bot`.
 */
async function reconnect (newOpts: Partial<BotOptions> = {}): Promise<string> {
  void stopRecording('reconnect')
  try { bot.end('reconnect') } catch {}
  Object.assign(botOpts, newOpts)
  const b = bot = createBot()
  await new Promise<void>(resolve => b.once('spawn', () => { resolve() }))
  return `reconnected as ${b.username}`
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

/** Ends a recording that is still running, for a reason other than someone asking for the file. */
async function stopRecording (why: string): Promise<void> {
  if (!recording) return
  try { await record.stop() } catch (e) { log('recording did not stop cleanly after', why, e) }
}

/** Names visible inside exec'd code, in order. Keep in sync with `usage()` in mcbot.ts. */
const SCOPE = { bot: () => bot, human: () => (human ??= createHuman(bot)), mineflayer, Vec3, goals, Movements, record, require, state, reconnect, log }
/** Thunked names are resolved once per exec, so a reconnect is only visible to the next one. */
const LAZY = new Set(['bot', 'human'])
const SCOPE_NAMES = Object.keys(SCOPE)

type ExecFn = (...args: unknown[]) => Promise<unknown>
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => ExecFn

function compile (code: string): ExecFn {
  try { return new AsyncFunction(...SCOPE_NAMES, `return (${code}\n)`) } catch {}
  return new AsyncFunction(...SCOPE_NAMES, code)
}

async function run ({ code, timeout = 30_000 }: ExecRequest): Promise<unknown> {
  const fn = compile(code)
  const args = SCOPE_NAMES.map(k => LAZY.has(k) ? (SCOPE[k as 'bot' | 'human'])() : SCOPE[k as keyof typeof SCOPE])
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
      let req: Request
      try { req = JSON.parse(line) } catch { send({ id: -1, ok: false, error: 'bad json' }); continue }
      if (isStatus(req)) { send({ id: req.id, ok: true, value: JSON.stringify(status()) }); continue }
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
