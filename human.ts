// Human-like locomotion. mineflayer-pathfinder plans the route; a per-tick controller decides how it is
// walked: the head turns with a mouse-like velocity profile, the body steers by pure pursuit along the
// smoothed route, sprint and sprint-jumps come in with human delays and rates, and the final approach
// coasts to a stop instead of snapping to the block centre.
//
// Calibrated against Jartex lobby players (2026-09-06, 48 players walking spawn -> NPC row):
//   head turn per 100 ms while moving: p25 8°, med 14°, p75 24°, p90 44°, p99 107°
//   head turn per 100 ms while still:  med 20°, p90 354° (snap turns)
//   spawn -> first step: med 2.5 s (p10 1.2, p75 5.5); first step -> sprint: 25% immediate, med 0.2 s
//   jumps per second of sprinting: p10 0.4, med 1.0, p90 1.6; pitch: med 10° down (p25 -1°, p75 22°)
//   motion heading vs head yaw: med 4°, 21% of samples > 25° (strafing / jump landings)
import type { Bot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'

const DEG = Math.PI / 180
const TICK = 0.05
// Yaw/pitch change per mouse count at the default 50% sensitivity. Rotations stay on this grid so the
// deltas share the gcd a real mouse produces.
const SENS = 0.15 * DEG

export interface Personality {
  basePitch: number      // radians, positive is looking down (mineflayer pitch is negated at send time)
  turnTime: number        // scales how long one mouse gesture takes (1 = the measured median)
  sprints: boolean
  sprintDelay: number     // seconds between first step and sprint
  jumpRate: number        // sprint-jumps per second, 0 = never
  lookAhead: number       // pursuit distance in blocks
  stopRadius: number      // release forward this far (plus coast distance) from the goal
  reaction: number        // seconds before acting on a new order
  glanceRate: number      // sideways glances per second while walking, 0 = never
  strafe: number          // probability of strafing rather than turning for a 20-60° correction
  deadband: number        // radians of steering error tolerated while walking before the next gesture
}

export interface HumanOpts {
  seed?: number
  personality?: Partial<Personality>
}

export interface WalkOpts {
  // Stop within this distance of the goal (default: the personality's stopRadius).
  radius?: number
  // Stop and reject after this many ms (default 60000).
  timeout?: number
  // Look at this point once arrived (an NPC's eyes, a block); the walk resolves after the look settles.
  faceAt?: Vec3
}

export interface Human {
  personality: Personality
  // Waypoints of the walk in progress or the last one.
  route: Vec3[]
  walkTo: (goal: Vec3, opts?: WalkOpts) => Promise<void>
  lookAt: (point: Vec3, opts?: { settleMs?: number }) => Promise<void>
  stop: () => void
  // Set to false to suspend the controller without dropping its state.
  active: boolean
}

// Mulberry32; a seed reproduces one personality and its noise.
function rng (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makePersonality (r: () => number, over: Partial<Personality>): Personality {
  const u = (lo: number, hi: number): number => lo + (hi - lo) * r()
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
  const p: Personality = {
    basePitch: Math.min(16, Math.max(-5, 6 + 5 * gauss())) * DEG,
    turnTime: u(0.75, 1.3),
    sprints: r() < 0.8,
    sprintDelay: r() < 0.25 ? 0 : u(0.1, 0.8),
    jumpRate: r() < 0.4 ? 0 : u(0.3, 1.1),
    lookAhead: u(1.8, 3.0),
    stopRadius: u(0.25, 0.5),
    reaction: Math.max(0.08, 0.25 + 0.1 * gauss()),
    glanceRate: r() < 0.35 ? 0 : 1 / u(5, 12),
    strafe: r() < 0.5 ? 0 : u(0.2, 0.6),
    deadband: u(4, 12) * DEG
  }
  return { ...p, ...over }
}

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))
const quantize = (a: number): number => Math.round(a / SENS) * SENS
const yawTo = (from: Vec3, to: Vec3): number => Math.atan2(-(to.x - from.x), -(to.z - from.z))
const horiz = (v: Vec3): number => Math.hypot(v.x, v.z)

export function createHuman (bot: Bot, opts: HumanOpts = {}): Human {
  const r = rng(opts.seed ?? (Date.now() ^ (Math.random() * 2 ** 31)))
  const personality = makePersonality(r, opts.personality ?? {})
  const { pathfinder, Movements, goals } = pathfinderPkg
  if (!bot.pathfinder) bot.loadPlugin(pathfinder)

  // Head state, radians, mineflayer convention (yaw = atan2(-dx, -dz), pitch positive up).
  let yaw = bot.entity?.yaw ?? 0
  let pitch = bot.entity?.pitch ?? 0
  let targetYaw: number | null = null
  let targetPitch: number | null = null
  let pitchNoise = 0
  // One mouse gesture: a minimum-jerk sweep of fixed duration from where the head was to where the
  // target was when the hand started moving. Between gestures the head does not move at all.
  interface Gesture { ticks: number, total: number, y0: number, p0: number, ay: number, ap: number }
  let gesture: Gesture | null = null
  let glanceUntil = 0
  let glanceOffset = 0

  interface Walk {
    goal: Vec3
    route: Vec3[]     // waypoints at block centres, y = feet level
    idx: number       // next waypoint
    radius: number
    startedAt: number
    firstStepAt: number
    lastProgressAt: number
    bestDist: number
    sprintAt: number
    faceAt?: Vec3
    replans: number
    resolve: () => void
    reject: (e: Error) => void
    timer: NodeJS.Timeout
  }
  let walk: Walk | null = null
  let lastRotationDelta = 0

  const human: Human = { personality, route: [], walkTo, lookAt, stop, active: true }

  function movements (): any {
    const m = new Movements(bot)
    m.canDig = false
    m.allow1by1towers = false
    m.allowParkour = false
    m.allowSprinting = true
    m.scafoldingBlocks = []
    m.maxDropDown = 3
    return m
  }

  // Block-centre waypoints from the planner, then string-pulled: a waypoint is dropped when the segment
  // that skips it is flat, has floor under every sample, and is clear at feet and head for the body width.
  function planRoute (goal: Vec3): Vec3[] | null {
    const goalNode = new goals.GoalNear(goal.x, goal.y, goal.z, 0.5)
    const res = bot.pathfinder.getPathTo(movements(), goalNode, 5000)
    if (res.status === 'noPath' || res.path.length === 0) return null
    const start = bot.entity.position.clone()
    const pts: Vec3[] = [start]
    for (const m of res.path as Array<{ x: number, y: number, z: number }>) {
      const p = new Vec3(Math.floor(m.x) + 0.5, m.y, Math.floor(m.z) + 0.5)
      if (p.y === start.y && horiz(p.minus(start)) < 0.8) continue
      pts.push(p)
    }
    pts.push(goal.clone())
    const out: Vec3[] = [pts[0]]
    let i = 0
    while (i < pts.length - 1) {
      let j = pts.length - 1
      while (j > i + 1 && !straightWalkable(pts[i], pts[j])) j--
      out.push(pts[j])
      i = j
    }
    return out
  }

  function solid (p: Vec3): boolean {
    const b = bot.blockAt(p)
    return b != null && b.boundingBox === 'block'
  }
  function passable (p: Vec3): boolean {
    const b = bot.blockAt(p)
    return b != null && b.boundingBox === 'empty'
  }

  function straightWalkable (a: Vec3, b: Vec3): boolean {
    if (a.y !== b.y) return false
    const d = b.minus(a)
    const len = horiz(d)
    if (len === 0) return true
    const nx = -d.z / len
    const nz = d.x / len
    const steps = Math.ceil(len / 0.25)
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      for (const w of [-0.3, 0, 0.3]) {
        const p = new Vec3(a.x + d.x * t + nx * w, a.y, a.z + d.z * t + nz * w)
        if (!solid(p.offset(0, -1, 0)) || !passable(p) || !passable(p.offset(0, 1, 0))) return false
      }
    }
    return true
  }

  // Point on the route `lookAhead` blocks past the bot's projection onto it.
  function carrot (w: Walk, pos: Vec3): Vec3 {
    let remaining = personality.lookAhead
    let from = pos
    for (let k = w.idx; k < w.route.length; k++) {
      const to = w.route[k]
      const seg = to.minus(from)
      const len = horiz(seg)
      if (len >= remaining) {
        const t = remaining / len
        return new Vec3(from.x + seg.x * t, to.y, from.z + seg.z * t)
      }
      remaining -= len
      from = to
    }
    return w.route[w.route.length - 1]
  }

  function remainingDistance (w: Walk, pos: Vec3): number {
    let d = 0
    let from = pos
    for (let k = w.idx; k < w.route.length; k++) { d += horiz(w.route[k].minus(from)); from = w.route[k] }
    return d
  }

  // A hand on the mouse only while there is something to do: idle players send no rotation at all.
  function stepHead (moving: boolean): void {
    const ty = targetYaw === null ? yaw : targetYaw + (Date.now() < glanceUntil ? glanceOffset : 0)
    const tp = targetPitch === null ? pitch : targetPitch + pitchNoise
    if (gesture === null) {
      const yawErr = wrapAngle(ty - yaw)
      const pitchErr = tp - pitch
      // Precise aiming (a look order, the final approach) tolerates almost nothing; steering while
      // walking waits until the route has drifted a few degrees off, then corrects in one movement.
      const tol = walk !== null && targetYaw !== null && !(walk.faceAt && walkDistance(walk) < 2.5) ? personality.deadband : 0.2 * DEG
      if (Math.abs(yawErr) < tol && Math.abs(pitchErr) < Math.max(tol, 0.2 * DEG)) { lastRotationDelta = 0; return }
      const amp = Math.max(Math.abs(yawErr), Math.abs(pitchErr))
      // Duration grows with the square root of the amplitude, as hand movements do; snap turns while
      // standing are quicker than corrections while walking.
      const secs = (0.08 + 0.3 * Math.sqrt(amp / (90 * DEG))) * (moving ? 1 : 0.6) * personality.turnTime
      // Each gesture lands a little off its mark, more so for larger turns.
      const bias = (r() - 0.5) * 0.12 * yawErr
      gesture = { ticks: 0, total: Math.max(2, Math.round(secs / TICK)), y0: yaw, p0: pitch, ay: yawErr - bias, ap: pitchErr }
    }
    const g = gesture
    g.ticks++
    const t = Math.min(1, g.ticks / g.total)
    const frac = t * t * t * (10 - 15 * t + 6 * t * t)
    yaw = g.y0 + g.ay * frac
    pitch = Math.max(-89 * DEG, Math.min(89 * DEG, g.p0 + g.ap * frac))
    if (t >= 1) { gesture = null; yaw = wrapAngle(yaw) }
    // Ornstein-Uhlenbeck drift on pitch while walking: the mouse is never held perfectly still.
    if (walk) pitchNoise += (-pitchNoise / 2.5) * TICK + 2 * DEG * Math.sqrt(TICK) * (r() * 2 - 1) * 1.7
    // Hand tremor while the mouse is in motion, below one mouse count most ticks.
    const jitter = gesture !== null ? 0.08 * DEG : 0
    const qy = quantize(yaw + (r() - 0.5) * jitter)
    const qp = quantize(pitch + (r() - 0.5) * jitter)
    lastRotationDelta = Math.abs(wrapAngle(qy - bot.entity.yaw)) + Math.abs(qp - bot.entity.pitch)
    if (qy !== bot.entity.yaw || qp !== bot.entity.pitch) void bot.look(qy, qp, true)
  }

  function walkDistance (w: Walk): number {
    return horiz(w.route[w.route.length - 1].minus(bot.entity.position))
  }

  let sprintReleaseUntil = 0
  let jumpHeld = 0
  let stuckJumpAt = 0

  function tick (): void {
    if (!human.active || !bot.entity?.position) return
    const now = Date.now()
    const pos = bot.entity.position
    const vel = bot.entity.velocity
    const speed = horiz(vel)
    const moving = speed > 0.03

    if (walk) tickWalk(walk, now, pos, vel, speed)
    stepHead(moving)
    if (jumpHeld > 0 && --jumpHeld === 0) bot.setControlState('jump', false)
  }

  function tickWalk (w: Walk, now: number, pos: Vec3, vel: Vec3, speed: number): void {
    if (now - w.startedAt < personality.reaction * 1000) return
    // Advance past waypoints the bot has reached or walked beyond.
    while (w.idx < w.route.length - 1) {
      const wp = w.route[w.idx]
      const next = w.route[w.idx + 1]
      const passed = horiz(wp.minus(pos)) < 0.6 ||
        (wp.y === pos.y && next.minus(wp).dot(pos.minus(wp)) > 0 && horiz(wp.minus(pos)) < 1.2)
      if (!passed) break
      w.idx++
    }
    const last = w.route[w.route.length - 1]
    const goalDist = horiz(last.minus(pos))
    const remaining = remainingDistance(w, pos)
    if (goalDist < w.bestDist - 0.05) { w.bestDist = goalDist; w.lastProgressAt = now }

    // Coast distance: ground friction leaves 0.546 of the horizontal velocity each tick.
    const coast = speed * 0.546 / (1 - 0.546)
    const arrived = goalDist <= w.radius + coast && w.idx >= w.route.length - 1
    if (arrived) {
      bot.setControlState('forward', false)
      bot.setControlState('left', false)
      bot.setControlState('right', false)
      bot.setControlState('sprint', false)
      if (speed < 0.02) finishWalk(w)
      return
    }

    const target = carrot(w, pos)
    const wantYaw = yawTo(pos, target)
    targetYaw = wantYaw
    targetPitch = -personality.basePitch
    if (personality.glanceRate > 0 && now > glanceUntil && r() < personality.glanceRate * TICK && remaining > 6) {
      glanceOffset = (r() < 0.5 ? -1 : 1) * (15 + 25 * r()) * DEG
      glanceUntil = now + 400 + 500 * r()
    }

    const err = wrapAngle(wantYaw - yaw)
    const aerr = Math.abs(err)
    // Facing far enough off: turn first, as a player does when the target is behind them.
    const canWalk = aerr < (speed > 0.1 ? 75 : 50) * DEG
    let left = false
    let right = false
    if (canWalk && aerr > 20 * DEG && personality.strafe > 0 && r() < personality.strafe * TICK * 4) {
      // Strafe holds for a few ticks via the sticky control state below.
      strafeUntil = now + 250 + 300 * r()
      strafeDir = err > 0 ? 'left' : 'right'
    }
    if (now < strafeUntil && canWalk) { if (strafeDir === 'left') left = true; else right = true }
    bot.setControlState('forward', canWalk)
    bot.setControlState('left', left)
    bot.setControlState('right', right)
    if (canWalk && w.firstStepAt === 0) { w.firstStepAt = now; w.sprintAt = now + personality.sprintDelay * 1000 }

    const nextUp = w.idx < w.route.length && w.route[w.idx].y > pos.y + 0.5 && horiz(w.route[w.idx].minus(pos)) < 1.1
    const flatAhead = w.idx < w.route.length && w.route[w.idx].y <= pos.y + 0.5 && horiz(w.route[w.idx].minus(pos)) > 1.5
    const wantSprint = personality.sprints && canWalk && now >= w.sprintAt && remaining > 2.5 && aerr < 40 * DEG && now > sprintReleaseUntil
    bot.setControlState('sprint', wantSprint)

    if (bot.entity.onGround && jumpHeld === 0) {
      if (nextUp) jump()
      else if (wantSprint && personality.jumpRate > 0 && flatAhead && remaining > 4 && headroom(pos) && r() < personality.jumpRate * TICK / 0.55) jump()
    }

    // Stuck: no progress for 1.5 s -> hop; 4 s -> re-plan; three re-plans -> give up.
    if (now - w.lastProgressAt > 1500 && now - stuckJumpAt > 1200 && bot.entity.onGround) { stuckJumpAt = now; jump() }
    if (now - w.lastProgressAt > 4000) {
      if (++w.replans > 3) { failWalk(w, new Error('stuck')); return }
      const route = planRoute(w.goal)
      if (!route) { failWalk(w, new Error('no path on re-plan')); return }
      w.route = route; w.idx = 0; w.lastProgressAt = now; w.bestDist = Infinity
      human.route = route
      sprintReleaseUntil = now + 600
    }
  }

  let strafeUntil = 0
  let strafeDir: 'left' | 'right' = 'left'

  function headroom (pos: Vec3): boolean {
    for (let dy = 2; dy <= 3; dy++) if (!passable(pos.offset(0, dy, 0))) return false
    return true
  }

  function jump (): void {
    bot.setControlState('jump', true)
    jumpHeld = 1
  }

  function pitchTo (from: Vec3, to: Vec3): number {
    const eye = from.offset(0, (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62, 0)
    const d = to.minus(eye)
    return Math.atan2(d.y, horiz(d))
  }

  function releaseControls (): void {
    for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump'] as const) bot.setControlState(c, false)
  }

  function finishWalk (w: Walk): void {
    if (walk !== w) return
    clearTimeout(w.timer)
    walk = null
    releaseControls()
    if (w.faceAt) {
      targetYaw = yawTo(bot.entity.position, w.faceAt)
      targetPitch = pitchTo(bot.entity.position, w.faceAt)
      settled(400).then(w.resolve, w.resolve)
    } else {
      w.resolve()
    }
  }

  function failWalk (w: Walk, e: Error): void {
    if (walk !== w) return
    clearTimeout(w.timer)
    walk = null
    releaseControls()
    w.reject(e)
  }

  // Resolves once the head has stopped moving for `ms`.
  function settled (ms: number): Promise<void> {
    return new Promise(resolve => {
      let quietSince = Date.now()
      const check = (): void => {
        if (lastRotationDelta > 0.02 * DEG) quietSince = Date.now()
        if (Date.now() - quietSince >= ms) { bot.off('physicsTick', check); resolve() }
      }
      bot.on('physicsTick', check)
    })
  }

  function walkTo (goal: Vec3, o: WalkOpts = {}): Promise<void> {
    if (walk) failWalk(walk, new Error('superseded'))
    const route = planRoute(goal)
    if (!route) return Promise.reject(new Error(`no path to ${goal}`))
    return new Promise<void>((resolve, reject) => {
      const now = Date.now()
      const w: Walk = {
        goal: goal.clone(),
        route,
        idx: 0,
        radius: o.radius ?? personality.stopRadius,
        startedAt: now,
        firstStepAt: 0,
        lastProgressAt: now + personality.reaction * 1000,
        bestDist: Infinity,
        sprintAt: Infinity,
        faceAt: o.faceAt,
        replans: 0,
        resolve,
        reject,
        timer: setTimeout(() => failWalk(w, new Error('walk timed out')), o.timeout ?? 60_000)
      }
      walk = w
      human.route = route
    })
  }

  async function lookAt (point: Vec3, o: { settleMs?: number } = {}): Promise<void> {
    await new Promise(res => setTimeout(res, personality.reaction * 1000 * (0.5 + r())))
    targetYaw = yawTo(bot.entity.position, point)
    targetPitch = pitchTo(bot.entity.position, point)
    await settled(o.settleMs ?? 300)
  }

  function stop (): void {
    if (walk) failWalk(walk, new Error('stopped'))
    targetYaw = null
    targetPitch = null
  }

  bot.on('physicsTick', tick)
  // A server teleport resets the head to whatever the server chose.
  bot.on('forcedMove', () => { yaw = bot.entity.yaw; pitch = bot.entity.pitch; gesture = null })
  return human
}
