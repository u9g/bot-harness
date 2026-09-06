// Player-like locomotion over mineflayer-pathfinder routes. Rotation is sent only inside a mouse gesture,
// the body follows the string-pulled route by pure pursuit, and a walk ends by coasting, never by a snap
// to the block centre.
//
// Calibration targets (48 Jartex lobby players, 2026-09-06, spawn -> NPC row):
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
// Yaw/pitch per mouse count at the default 50% sensitivity; every rotation sent is a multiple of it.
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
  // A gesture is a fixed-duration minimum-jerk sweep from the head's start to the target's position at
  // gesture start. The head does not move outside a gesture.
  interface Gesture { ticks: number, total: number, y0: number, p0: number, ay: number, ap: number }
  let gesture: Gesture | null = null
  let glanceUntil = 0
  let glanceOffset = 0

  interface Walk {
    goal: Vec3
    route: Vec3[]     // waypoints at block centres, y = feet level
    idx: number       // next waypoint
    complete: boolean // the route ends at the goal rather than at the closest reachable point
    radius: number
    startedAt: number
    firstStepAt: number
    lastProgressAt: number
    bestDist: number
    sprintAt: number
    faceAt?: Vec3
    replans: number
    replanning: boolean
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

  // Waypoints are block centres. A waypoint is dropped only when the segment skipping it is flat, floored
  // under every sample, and clear at feet and head across the body width.
  // Feet in the goal's block column, within a block of its level.
  class GoalBlock extends goals.Goal {
    private readonly x: number
    private readonly y: number
    private readonly z: number
    constructor (x: number, y: number, z: number) { super(); this.x = x; this.y = y; this.z = z }
    heuristic (node: { x: number, y: number, z: number }): number { return Math.hypot(this.x - node.x, this.z - node.z) + Math.abs(this.y - node.y) }
    isEnd (node: { x: number, y: number, z: number }): boolean { return node.x === this.x && node.z === this.z && Math.abs(node.y - this.y) <= 1 }
  }

  interface Plan { route: Vec3[], complete: boolean }

  // Each search slice holds the event loop for at most one tick's thinking. A search that ends without
  // reaching the goal yields the route to its closest node; the walk fails at that route's end.
  async function planRoute (goal: Vec3): Promise<Plan | null> {
    const goalNode = new GoalBlock(Math.floor(goal.x), Math.floor(goal.y), Math.floor(goal.z))
    const search = bot.pathfinder.getPathFromTo(movements(), bot.entity.position, goalNode, { timeout: 5000, tickTimeout: 40 })
    let res: any = null
    for (;;) {
      const step = search.next()
      if (step.value) res = step.value.result
      if (step.done || res.status !== 'partial') break
      await new Promise(resolve => setImmediate(resolve))
    }
    if (res === null || res.path.length === 0) return null
    const complete = res.status === 'success'
    const start = bot.entity.position.clone()
    const pts: Vec3[] = [start]
    for (const m of res.path as Array<{ x: number, y: number, z: number }>) {
      const p = new Vec3(Math.floor(m.x) + 0.5, m.y, Math.floor(m.z) + 0.5)
      if (p.y === start.y && horiz(p.minus(start)) < 0.8) continue
      pts.push(p)
    }
    if (complete) pts.push(goal.clone())
    const out: Vec3[] = [pts[0]]
    let i = 0
    while (i < pts.length - 1) {
      let j = pts.length - 1
      while (j > i + 1 && !straightWalkable(pts[i], pts[j])) j--
      out.push(pts[j])
      i = j
    }
    return { route: out, complete }
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

  // No rotation is sent while there is no target.
  function stepHead (moving: boolean): void {
    const ty = targetYaw === null ? yaw : targetYaw + (Date.now() < glanceUntil ? glanceOffset : 0)
    const tp = targetPitch === null ? pitch : targetPitch + pitchNoise
    if (gesture === null) {
      const yawErr = wrapAngle(ty - yaw)
      const pitchErr = tp - pitch
      // A look order and the final approach tolerate 0.2°; steering while walking tolerates `deadband`.
      const tol = walk !== null && targetYaw !== null && !(walk.faceAt && walkDistance(walk) < 2.5) ? personality.deadband : 0.2 * DEG
      if (Math.abs(yawErr) < tol && Math.abs(pitchErr) < Math.max(tol, 0.2 * DEG)) { lastRotationDelta = 0; return }
      const amp = Math.max(Math.abs(yawErr), Math.abs(pitchErr))
      // Duration grows with the square root of the amplitude; a standing turn takes 0.6x a walking one.
      const secs = (0.08 + 0.3 * Math.sqrt(amp / (90 * DEG))) * (moving ? 1 : 0.6) * personality.turnTime
      // A gesture lands up to 6% of its yaw off the mark.
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
    // Ornstein-Uhlenbeck pitch noise applies only while walking.
    if (walk) pitchNoise += (-pitchNoise / 2.5) * TICK + 2 * DEG * Math.sqrt(TICK) * (r() * 2 - 1) * 1.7
    // Jitter applies only during a gesture and stays below one mouse count most ticks.
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
    // A waypoint is passed within 0.6 blocks, or within 1.2 blocks once the bot is beyond it along the next segment.
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
      if (speed < 0.02) {
        if (w.complete || horiz(w.goal.minus(pos)) <= w.radius + 1) finishWalk(w)
        else failWalk(w, new Error(`no path to ${w.goal}`))
      }
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
    // Forward is held only while the heading error is under 50° (75° while moving).
    const canWalk = aerr < (speed > 0.1 ? 75 : 50) * DEG
    let left = false
    let right = false
    if (canWalk && aerr > 20 * DEG && personality.strafe > 0 && r() < personality.strafe * TICK * 4) {
      // A strafe holds for 250-550 ms through strafeUntil.
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

    // No progress for 1.5 s hops; 4 s re-plans, one in flight at a time; more than three re-plans fails the walk.
    if (now - w.lastProgressAt > 1500 && now - stuckJumpAt > 1200 && bot.entity.onGround) { stuckJumpAt = now; jump() }
    if (now - w.lastProgressAt > 4000 && !w.replanning) {
      if (++w.replans > 3) { failWalk(w, new Error('stuck')); return }
      w.replanning = true
      void planRoute(w.goal).then(plan => {
        w.replanning = false
        if (walk !== w) return
        if (!plan) { failWalk(w, new Error('no path on re-plan')); return }
        w.route = plan.route; w.complete = plan.complete; w.idx = 0; w.lastProgressAt = Date.now(); w.bestDist = Infinity
        human.route = plan.route
        sprintReleaseUntil = Date.now() + 600
      })
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

  let planSeq = 0

  async function walkTo (goal: Vec3, o: WalkOpts = {}): Promise<void> {
    if (walk) failWalk(walk, new Error('superseded'))
    const seq = ++planSeq
    const plan = await planRoute(goal)
    if (seq !== planSeq) throw new Error('superseded')
    if (!plan) throw new Error(`no path to ${goal}`)
    const { route, complete } = plan
    return await new Promise<void>((resolve, reject) => {
      const now = Date.now()
      const w: Walk = {
        goal: goal.clone(),
        route,
        idx: 0,
        complete,
        radius: o.radius ?? personality.stopRadius,
        startedAt: now,
        firstStepAt: 0,
        lastProgressAt: now + personality.reaction * 1000,
        bestDist: Infinity,
        sprintAt: Infinity,
        faceAt: o.faceAt,
        replans: 0,
        replanning: false,
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
  // A server teleport sets the head to the entity's rotation and cancels the gesture.
  bot.on('forcedMove', () => { yaw = bot.entity.yaw; pitch = bot.entity.pitch; gesture = null })
  return human
}
