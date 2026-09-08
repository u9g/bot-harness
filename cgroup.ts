// Puts the daemon in a cgroup of its own, so a runaway bot is capped where it runs. A bot that
// leaks -- a recorder nobody stopped, a world that never unloads -- used to grow until the kernel
// ran the whole machine out of memory and picked a victim by heuristic. Inside its own cgroup it
// meets a local limit and dies alone.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

/** cpu.max is a quota over a period; systemd takes the quota per second, in microseconds. */
const USEC_PER_SEC = 1_000_000

export interface Limits {
  /** Hard ceiling; the kernel OOM-kills inside the group when it is crossed. */
  memoryMax: string
  /** Soft ceiling; crossing it throttles the group and forces reclaim, but kills nothing. */
  memoryHigh: string
  /** Swap the group may use, counted separately from `memoryMax`. */
  memorySwapMax: string
  /** Share of one core, so '400%' is four cores' worth. */
  cpuMax: string
  /** Ceiling on processes plus threads, which is what catches a spawn loop. */
  tasksMax: string
}

/** Healthy daemons peak under 1G; the leak that prompted this reached 10.8G. */
export const DEFAULT_LIMITS: Limits = {
  memoryMax: process.env.MCBOT_MEMORY_MAX ?? '4G',
  memoryHigh: process.env.MCBOT_MEMORY_HIGH ?? '3G',
  memorySwapMax: process.env.MCBOT_SWAP_MAX ?? '1G',
  cpuMax: process.env.MCBOT_CPU_MAX ?? '400%',
  tasksMax: process.env.MCBOT_TASKS_MAX ?? '512'
}

const SUFFIXES: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }

/** '4G' -> 4294967296. 'max' -> null, which drops the limit rather than setting it to infinity. */
function bytes (v: string): number | null {
  if (v === 'max') return null
  const m = /^(\d+(?:\.\d+)?)([KMG])?$/i.exec(v.trim())
  if (m === null) throw new Error(`bad byte value: ${v}`)
  return Math.round(Number(m[1]) * (m[2] === undefined ? 1 : SUFFIXES[m[2].toUpperCase()]))
}

/** '400%' -> 4000000us of cpu per second, i.e. four cores. 'max' -> null. */
function cpuQuota (v: string): number | null {
  if (v === 'max') return null
  const m = /^(\d+(?:\.\d+)?)%$/.exec(v.trim())
  if (m === null) throw new Error(`bad cpu value: ${v}`)
  return Math.round(Number(m[1]) / 100 * USEC_PER_SEC)
}

/** '512' -> 512. 'max' -> null. */
function count (v: string): number | null {
  if (v === 'max') return null
  if (!/^\d+$/.test(v.trim())) throw new Error(`bad count: ${v}`)
  return Number(v)
}

/**
 * StartTransientUnit only queues a job, so the move lands a moment after the call returns.
 * Blocks until this process is actually inside `unit`, because reporting a scope we are not in
 * yet would claim limits that are not applied.
 */
function awaitPlacement (unit: string, timeoutMs = 5_000): boolean {
  const deadline = Date.now() + timeoutMs
  const idle = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    if (fs.readFileSync('/proc/self/cgroup', 'utf8').includes(unit)) return true
    if (Date.now() >= deadline) return false
    Atomics.wait(idle, 0, 0, 20)
  }
}

/** systemd unit names take a restricted alphabet, and bot names arrive from the command line. */
const unitName = (name: string): string => `mcbot-${name.replace(/[^\w:.-]/g, '_')}.scope`

/**
 * Moves this process into a new systemd scope with `limits` applied, and returns the scope's name.
 * Returns null when there is no user systemd to ask.
 *
 * The scope adopts the running process rather than wrapping it, so the daemon keeps the pid that
 * mcbot.ts wrote to its pidfile. Anything it spawns afterwards -- ffmpeg for a recording, above
 * all -- is created inside the scope too, so one set of limits covers the bot and its helpers
 * together. systemd releases the scope once the last process in it exits, so nothing is left
 * behind to clean up.
 */
export function placeInOwnCgroup (name: string, limits: Limits = DEFAULT_LIMITS): string | null {
  const unit = unitName(name)
  // Anything left null is a limit the caller turned off, and is left unset rather than sent as
  // an explicit infinity.
  const props: Array<[string, number]> = ([
    ['MemoryMax', bytes(limits.memoryMax)],
    ['MemoryHigh', bytes(limits.memoryHigh)],
    ['MemorySwapMax', bytes(limits.memorySwapMax)],
    ['CPUQuotaPerSecUSec', cpuQuota(limits.cpuMax)],
    ['TasksMax', count(limits.tasksMax)]
  ] as Array<[string, number | null]>).filter((p): p is [string, number] => p[1] !== null)

  // StartTransientUnit(name, mode, properties, aux). Every property is a (string, variant) pair;
  // PIDs is the one that makes systemd adopt us instead of starting something new.
  const args = [
    '--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))',
    unit, 'fail', String(props.length + 1),
    'PIDs', 'au', '1', String(process.pid),
    ...props.flatMap(([k, v]) => [k, 't', String(v)]),
    '0'
  ]

  // A scope whose process died before systemd finished adopting it stays loaded and holds the
  // name, so a bot that restarts under it would be refused. Clearing it is a no-op when the name
  // is free, and still fails below if a live bot is genuinely using it.
  spawnSync('systemctl', ['--user', 'reset-failed', unit], { encoding: 'utf8' })

  const r = spawnSync('busctl', args, { encoding: 'utf8' })
  if (r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return null
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'busctl failed').trim())
  if (!awaitPlacement(unit)) throw new Error(`systemd accepted ${unit} but did not move us into it`)
  return unit
}
