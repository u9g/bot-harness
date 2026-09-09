// Runs in the detached process. Owns one bot and a unix socket that evals code against it.
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { createRequire } from 'node:module'
import mineflayer, { type Bot, type BotOptions } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { BotStatus, DaemonOpts, ExecRequest, ExecReply, Request, StatusRequest, TaskInfo } from './protocol.ts'
import { startRecording, type RecordOpts, type Recording } from './record.ts'
import { placeInOwnCgroup } from './cgroup.ts'

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

// Must precede the bot: the scope only binds allocations made after the move.
try {
  const scope = placeInOwnCgroup(opts.name)
  log(scope === null ? 'no user systemd, running uncapped' : `cgroup ${scope}`)
} catch (e) {
  log('could not create cgroup, running uncapped:', e instanceof Error ? e.message : e)
}

/** Persists across exec calls; scripts can stash anything here. */
const state: Record<string, unknown> = {}
// One human controller per bot, built on first use; a new bot needs a new one.
let human: ReturnType<typeof createHuman> | null = null
/** Why the current bot's connection ended, null while it is connected. A dead bot still answers
 *  exec (its `state` and packet history are the point of asking), so the reason rides along. */
let disconnected: string | null = null
/** Aborted when that bot's connection ends; every exec's `signal` derives from its bot's. */
const ended = new WeakMap<Bot, AbortSignal>()
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
    disconnected = `kicked: ${reason}`
    log('kicked', reason)
  })
  b.on('error', e => { health.lastError = { at: now(), message: e.message ?? String(e) }; log('error', e.stack ?? e) })
  b.on('end', r => {
    health.connected = false
    health.lastEnd = { at: now(), reason: String(r) }
    disconnected ??= `ended: ${r}`
    log('end', r)
    // The recorder draws the bot's view; with the connection gone there is nothing left to draw, and
    // a renderer left running holds its share of the event loop and grows the file until someone
    // remembers to stop it.
    void stopRecording('bot ended')
  })
  b.on('messagestr', m => log('chat', m))
  // Execs started against this bot get a signal that aborts with its connection, so a controller
  // loop has something to stop on instead of driving the dead entity.
  const gone = new AbortController()
  ended.set(b, gone.signal)
  let why: string | null = null
  b.on('kicked', r => { why = `kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}` })
  b.on('end', r => gone.abort(new Error(`bot ${why ?? `ended: ${r}`}`)))
  human = null
  disconnected = null
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
    lastError: health.lastError,
    recording: recording === null ? undefined : { file: recording.file, ...recording.stats() }
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
  bot = createBot()
  await new Promise<void>(resolve => bot.once('spawn', () => { resolve() }))
  return `reconnected as ${bot.username}`
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
    const { dropped } = r.stats()
    const file = await r.stop()
    log('recorded', file, ...(dropped === 0 ? [] : [`(${dropped} frames dropped)`]))
    return file
  }
}

/** Ends a recording that is still running, for a reason other than someone asking for the file. */
async function stopRecording (why: string): Promise<void> {
  if (!recording) return
  try { await record.stop() } catch (e) { log('recording did not stop cleanly after', why, e) }
}

interface Task {
  n: number
  code: string
  startedAt: number
  signal: AbortSignal
  abortedAt: number | null
  cancel: (reason: string) => void
  /** Settles with the exec, never rejects. */
  done: Promise<void>
}
/** Execs that have not settled yet, in start order. */
const running = new Map<number, Task>()
/** Numbers execs across the daemon's life; the CLI sends every request as id 1. */
let execSeq = 0

/** The first line of a script, for log lines and listings. */
function head (code: string): string {
  const line = code.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  return line.length > 80 ? line.slice(0, 79) + '…' : line
}
const errText = (e: unknown): string => e instanceof Error ? e.stack ?? e.message : String(e)
const reasonText = (signal: AbortSignal): string => signal.reason instanceof Error ? signal.reason.message : String(signal.reason)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const tasks = {
  list (): TaskInfo[] {
    return [...running.values()].map(t => ({
      exec: t.n,
      startedAt: new Date(t.startedAt).toISOString(),
      aborted: t.abortedAt === null ? null : { at: new Date(t.abortedAt).toISOString(), reason: reasonText(t.signal) },
      code: head(t.code)
    }))
  },
  /** Aborts the exec's `signal`; the code stops when it next looks. Waits `wait` ms to say whether it did. */
  async cancel (n: number, reason = 'cancelled', wait = 5000): Promise<string> {
    const t = running.get(n)
    if (t === undefined) throw new Error(`no running exec ${n}`)
    t.cancel(reason)
    const exited = await Promise.race([t.done.then(() => true), sleep(wait).then(() => false)])
    return exited ? `exec ${n} stopped` : `exec ${n} signalled, still running after ${wait}ms (it stops when its code next checks signal)`
  }
}

/** Names visible inside exec'd code, in order. Keep in sync with `usage()` in mcbot.ts. */
const SCOPE = { bot: null, human: null, signal: null, mineflayer, Vec3, goals, Movements, record, require, state, reconnect, tasks, log }
const SCOPE_NAMES = Object.keys(SCOPE)
/** `bot`, `human` and `signal` are fixed per exec, so a reconnect is only visible to the next one. */
function scopeArgs (signal: AbortSignal): unknown[] {
  const perExec: Record<string, unknown> = { bot, human: (human ??= createHuman(bot)), signal }
  return SCOPE_NAMES.map(k => k in perExec ? perExec[k] : SCOPE[k as keyof typeof SCOPE])
}

type ExecFn = (...args: unknown[]) => Promise<unknown>
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => ExecFn

// The scope names are the function's parameters, which a body may not redeclare at its top level;
// inside a block the same declaration is a legal shadow.
function compile (code: string): ExecFn {
  try { return new AsyncFunction(...SCOPE_NAMES, `return (${code}\n)`) } catch {}
  try {
    return new AsyncFunction(...SCOPE_NAMES, `{\n${code}\n}`)
  } catch (e) {
    // The stack below a compile error is the daemon's, not the code's.
    if (e instanceof SyntaxError) e.stack = `${e.name}: ${e.message}`
    throw e
  }
}

async function run ({ code, timeout = 30_000, detach = false }: ExecRequest): Promise<unknown> {
  const n = ++execSeq
  const fn = compile(code)
  const ctl = new AbortController()
  const signal = AbortSignal.any([ended.get(bot)!, ctl.signal])
  const result = fn(...scopeArgs(signal)).finally(() => running.delete(n))
  const startedAt = Date.now()
  const task: Task = {
    n, code, signal, startedAt, abortedAt: signal.aborted ? startedAt : null,
    cancel: reason => ctl.abort(new Error(reason)),
    done: result.then(() => {}, () => {})
  }
  signal.addEventListener('abort', () => { task.abortedAt = Date.now() }, { once: true })
  running.set(n, task)
  // Once the caller stops waiting (timeout or detach), whatever the code settles to goes to the log.
  let waiting = true
  result.then(
    v => { if (!waiting) log(`exec ${n} finished:`, serialize(v)) },
    (e: unknown) => { if (!waiting) log(`exec ${n} failed:`, errText(e)) })
  let timer: NodeJS.Timeout
  // A detached exec is one nobody waits for: the code gets one turn of the event loop, so a body
  // that dies on its first line is still reported to the caller, and then runs on as a task.
  const stopWaiting = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      waiting = false
      if (detach) {
        log(`exec ${n} running in background:`, head(code))
        resolve(`exec ${n} running in background (mcbot tasks ${opts.name} lists it)`)
      } else {
        reject(new Error(`exec ${n} timed out after ${timeout}ms (still running: mcbot tasks ${opts.name} lists it, and its result will be logged as "exec ${n} finished")`))
      }
    }, detach ? 0 : timeout)
  })
  try { return await Promise.race([result, stopWaiting]) } finally { clearTimeout(timer!) }
}

const note = (): { disconnected?: string } => (disconnected === null ? {} : { disconnected })

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
        value => send({ id: req.id, ok: true, value: serialize(value), ...note() }),
        (err: unknown) => send({ id: req.id, ok: false, error: errText(err), ...note() })
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
