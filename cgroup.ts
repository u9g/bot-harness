// Places the daemon in a systemd scope of its own, so its limits bind the bot and nothing else.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

/** systemd takes a CPU quota per second, in microseconds. */
const USEC_PER_SEC = 1_000_000

export interface Limits {
  /** Hard: crossing it is an OOM kill inside the scope. */
  memoryMax: string
  /** Soft: crossing it throttles and reclaims, and never kills. */
  memoryHigh: string
  /** Counted separately from `memoryMax`, not against it. */
  memorySwapMax: string
  /** Share of one core, so '400%' is four cores. */
  cpuMax: string
  /** Counts threads as well as processes. */
  tasksMax: string
}

export const DEFAULT_LIMITS: Limits = {
  memoryMax: process.env.MCBOT_MEMORY_MAX ?? '4G',
  memoryHigh: process.env.MCBOT_MEMORY_HIGH ?? '3G',
  memorySwapMax: process.env.MCBOT_SWAP_MAX ?? '1G',
  cpuMax: process.env.MCBOT_CPU_MAX ?? '400%',
  tasksMax: process.env.MCBOT_TASKS_MAX ?? '512'
}

const SUFFIXES: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }

/** '4G' -> 4294967296. 'max' -> null, which leaves the limit unset rather than infinite. */
function bytes (v: string): number | null {
  if (v === 'max') return null
  const m = /^(\d+(?:\.\d+)?)([KMG])?$/i.exec(v.trim())
  if (m === null) throw new Error(`bad byte value: ${v}`)
  return Math.round(Number(m[1]) * (m[2] === undefined ? 1 : SUFFIXES[m[2].toUpperCase()]))
}

/** '400%' -> 4000000. 'max' -> null. */
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

/** StartTransientUnit only queues a job, so placement lands after the call returns. */
function awaitPlacement (unit: string, timeoutMs = 5_000): boolean {
  const deadline = Date.now() + timeoutMs
  const idle = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    if (fs.readFileSync('/proc/self/cgroup', 'utf8').includes(unit)) return true
    if (Date.now() >= deadline) return false
    Atomics.wait(idle, 0, 0, 20)
  }
}

/** Unit names take a restricted alphabet; bot names arrive from the command line. */
const unitName = (name: string): string => `mcbot-${name.replace(/[^\w:.-]/g, '_')}.scope`

/**
 * Moves this process into a new systemd scope with `limits` applied, returning the scope's name,
 * or null where there is no user systemd to ask.
 *
 * The pid is unchanged, so mcbot.ts's pidfile stays valid. Processes spawned afterwards inherit
 * the scope. systemd releases it once its last process exits.
 */
export function placeInOwnCgroup (name: string, limits: Limits = DEFAULT_LIMITS): string | null {
  const unit = unitName(name)
  const props: Array<[string, number]> = ([
    ['MemoryMax', bytes(limits.memoryMax)],
    ['MemoryHigh', bytes(limits.memoryHigh)],
    ['MemorySwapMax', bytes(limits.memorySwapMax)],
    ['CPUQuotaPerSecUSec', cpuQuota(limits.cpuMax)],
    ['TasksMax', count(limits.tasksMax)]
  ] as Array<[string, number | null]>).filter((p): p is [string, number] => p[1] !== null)

  // StartTransientUnit(name, mode, properties, aux); PIDs adopts this process instead of starting one.
  const args = [
    '--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))',
    unit, 'fail', String(props.length + 1),
    'PIDs', 'au', '1', String(process.pid),
    ...props.flatMap(([k, v]) => [k, 't', String(v)]),
    '0'
  ]

  // A scope left loaded by an earlier failure holds the name; a live one still refuses below.
  spawnSync('systemctl', ['--user', 'reset-failed', unit], { encoding: 'utf8' })

  const r = spawnSync('busctl', args, { encoding: 'utf8' })
  if (r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return null
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'busctl failed').trim())
  if (!awaitPlacement(unit)) throw new Error(`systemd accepted ${unit} but did not move us into it`)
  return unit
}
