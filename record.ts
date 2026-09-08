import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'

const require = createRequire(import.meta.url)

export interface RecordOpts {
  width?: number
  height?: number
  fps?: number
  // Chunk radius meshed around the bot.
  viewDistance?: number
  // 0 meshes inline on the daemon thread instead of on a worker.
  numWorkers?: number
  // Share of wall-clock the renderer may hold the daemon's event loop (0-1).
  duty?: number
}

export interface RecordingStats {
  /** Frame slots not in the file: ffmpeg had not taken the previous frame when they came due. */
  dropped: number
  /** Bytes handed to ffmpeg's stdin and not yet taken. */
  queued: number
  /** Set once ffmpeg has exited: null after stop(), the reason after an exit on its own. */
  ended: string | null
}

export interface Recording {
  file: string
  stats: () => RecordingStats
  snapshot: (file: string) => Promise<string>
  stop: () => Promise<string>
}

// headless-gl's context comes through GLX, so an X display is required even with software Mesa. An
// Xvfb has no GPU driver, so it renders with llvmpipe; a host X server on the same machine reaches
// the real driver and is an order of magnitude faster. Prefer any display that already exists.
function hostDisplay (): string | null {
  let sockets: string[]
  try { sockets = readdirSync('/tmp/.X11-unix') } catch { return null }
  const numbers = sockets.filter(n => /^X\d+$/.test(n)).map(n => Number(n.slice(1))).sort((a, b) => a - b)
  // :99 is this module's own Xvfb, so it is the last resort rather than a host display.
  return numbers.length === 0 ? null : ':' + (numbers.find(n => n !== 99) ?? numbers[0])
}

async function ensureDisplay (width: number, height: number): Promise<void> {
  if (process.platform !== 'linux' || process.env.DISPLAY) return
  const host = hostDisplay()
  if (host !== null) { process.env.DISPLAY = host; return }
  process.env.DISPLAY = ':99'
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', `${width}x${height}x24`], { stdio: 'ignore', detached: true })
  xvfb.on('error', () => {})
  xvfb.unref()
  for (let i = 0; i < 100 && !existsSync('/tmp/.X11-unix/X99'); i++) await new Promise(r => setTimeout(r, 50))
  if (!existsSync('/tmp/.X11-unix/X99')) throw new Error('no X display and Xvfb failed to start (apt install xvfb)')
}

function ffmpeg (args: string[]): { proc: ChildProcess, done: Promise<void> } {
  const proc = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr!.on('data', d => { stderr += d })
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)))
  })
  done.catch(() => {})
  return { proc, done }
}

export async function startRecording (bot: Bot, file: string, opts: RecordOpts = {}, onEnd?: (err: Error) => void): Promise<Recording> {
  const { width = 640, height = 360, fps = 20, viewDistance = 4, numWorkers = 1, duty = 0.25 } = opts
  await ensureDisplay(width, height)
  if (!bot.entity) await new Promise<void>(resolve => bot.once('spawn', resolve))

  const THREE = require('three')
  const createContext = require('gl')
  const { Viewer, WorldView, createNodeHost, supportedVersions } = require('prismarine-viewer/viewer')

  const gl = createContext(width, height, { preserveDrawingBuffer: true })
  if (!gl) throw new Error('headless-gl could not create a GL context (needs Mesa and an X display)')
  // three reads gl.canvas.width; headless-gl has no canvas, so one is stubbed.
  const canvas = { width, height, addEventListener () {}, removeEventListener () {} }
  gl.canvas = canvas
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl })
  renderer.setSize(width, height, false)
  const destroyGl = (): void => {
    // renderer.dispose() throws headless (three's animation.stop() calls cancelAnimationFrame
    // on a null context); STACKGL_destroy_context frees the context regardless.
    try { renderer.dispose() } catch {}
    gl.getExtension('STACKGL_destroy_context')?.destroy()
  }

  const host = createNodeHost({ inlineMesher: numWorkers === 0 })
  const viewer = new Viewer(renderer, { host, numWorkers: Math.max(numWorkers, 1) })
  if (!viewer.setVersion(bot.version)) {
    destroyGl()
    throw new Error(`prismarine-viewer has no assets for ${bot.version}; start the bot with -v one of ${supportedVersions.join(', ')}`)
  }

  const worldView = new WorldView(bot.world, viewDistance, bot.entity.position)
  viewer.listen(worldView)
  void worldView.init(bot.entity.position)
  worldView.listenToBot(bot)

  // The viewer's camera tween never advances headless; the camera must be set directly.
  const follow = (): void => {
    const p = bot.entity.position
    viewer.camera.position.set(p.x, p.y + 1.6, p.z)
    viewer.camera.rotation.set(bot.entity.pitch, bot.entity.yaw, 0, 'ZYX')
    worldView.updatePosition(p)
  }
  follow()
  bot.on('move', follow)

  // A server transfer or dimension change makes mineflayer unload every column of the bot's world
  // (bot.world is mutated in place, not replaced). WorldView has no chunkColumnUnload listener, so
  // it keeps the pre-transfer geometry and never meshes the new world. login precedes the swap and
  // the following spawn is when bot.entity and the new columns are ready, so resync there: drop the
  // chunks the viewer still holds and reload from the current world. (Superseded once
  // prismarine-viewer handles the unload itself.)
  let reloginPending = false
  const onLogin = (): void => { reloginPending = true }
  const onSpawn = (): void => {
    if (!reloginPending) return
    reloginPending = false
    const wv = worldView as unknown as { loadedChunks: Record<string, boolean>, unloadChunk: (p: { x: number, z: number }) => void }
    for (const key of Object.keys(wv.loadedChunks)) {
      const [x, z] = key.split(',').map(Number)
      wv.unloadChunk({ x, z })
    }
    void worldView.init(bot.entity.position)
  }
  bot.on('login', onLogin)
  bot.on('spawn', onSpawn)

  // Frames before the atlas uploads and chunks mesh are blank sky. The first frame is
  // deferred until the atlas is set, some sections are meshed, and none are outstanding.
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
  // Idle to leave after a render that took `cost`, so rendering holds at most `duty` of wall-clock.
  const gap = (cost: number): number => cost * (1 / duty - 1)
  const draw = (): number => {
    const t = performance.now()
    viewer.update()
    renderer.render(viewer.scene, viewer.camera)
    return performance.now() - t
  }
  const w = viewer.world as { material: { map: unknown }, sectionMeshs: Record<string, unknown>, sectionsOutstanding?: Set<unknown> }
  const warmupDeadline = performance.now() + 10_000
  while (performance.now() < warmupDeadline) {
    const cost = draw()
    const outstanding = w.sectionsOutstanding ? w.sectionsOutstanding.size : 0
    if (w.material.map && Object.keys(w.sectionMeshs).length > 0 && outstanding === 0) break
    await sleep(Math.max(50, gap(cost)))
  }
  for (let i = 0; i < 12; i++) await sleep(Math.max(40, gap(draw())))

  const raw = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`]
  const video = ffmpeg([...raw, '-r', String(fps), '-i', 'pipe:0', '-vf', 'vflip', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file])

  const stdin = video.proc.stdin!
  // When ffmpeg exits, a write already in flight rejects async with EPIPE; the meaningful signal is
  // video.done, so swallow the stream error rather than let it crash the daemon.
  stdin.on('error', () => {})
  // null while recording; the reason once ffmpeg has gone. Both stop() and an exit on ffmpeg's own
  // (crash, disk full, killed) route through teardown; `stopping` tells them apart.
  let ended: string | null = null
  let stopping = false
  const teardown = (): void => {
    bot.off('move', follow)
    bot.off('login', onLogin)
    bot.off('spawn', onSpawn)
    worldView.removeListenersFromBot(bot)
    try { viewer.dispose() } catch {}
    destroyGl()
  }
  // ffmpeg exiting before stop() means the file is being abandoned; there is nothing to render into
  // any more, so stop the loop and let the daemon drop the recording.
  void video.done.then(
    () => { if (!stopping) { ended = 'ffmpeg exited before the recording was stopped'; if (timer) clearTimeout(timer); teardown(); onEnd?.(new Error(ended)) } },
    (e: Error) => { if (!stopping) { ended = e.message; if (timer) clearTimeout(timer); teardown(); onEnd?.(e) } }
  )
  const pixels = Buffer.alloc(width * height * 4)
  let last: Buffer | null = null
  const frameMs = 1000 / fps
  const t0 = performance.now()
  let written = 0
  let dropped = 0
  // Frames handed to stdin that ffmpeg has not taken. At most 1: a frame is 0.9 MB, and one that
  // is queued behind a slow encoder stays queued.
  let inflight = 0
  let timer: NodeJS.Timeout | null = null
  const tick = (): void => {
    if (ended !== null || !stdin.writable) return
    const due = Math.floor((performance.now() - t0) / frameMs) + 1
    let cost = 0
    if (inflight === 0 && written < due) {
      const start = performance.now()
      viewer.update()
      renderer.render(viewer.scene, viewer.camera)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      cost = performance.now() - start
      // Output runs at wall-clock rate: every frame slot elapsed since t0 gets the latest render.
      // Repeats of one buffer share its memory.
      last = Buffer.from(pixels)
      inflight++
      for (; written < due - 1; written++) stdin.write(last)
      stdin.write(last, () => { inflight-- })
      written++
    }
    // A slot ffmpeg could not take is dropped, never queued; the file runs short of wall-clock by
    // that many frames.
    dropped += due - written
    written = due
    // A render blocks the daemon's only thread, so the bot's physics and packet handling stop for
    // `cost`. The next render waits at least gap(cost), capping that share at `duty` and keeping
    // the bot's movement close enough to real time that servers do not see it teleport-desync.
    const next = Math.max(t0 + written * frameMs - performance.now(), gap(cost))
    timer = setTimeout(tick, Math.max(0, next))
  }
  tick()

  return {
    file,
    stats: () => ({ dropped, queued: stdin.writableLength, ended }),
    async snapshot (out) {
      if (!last) throw new Error('no frame yet')
      const png = ffmpeg([...raw, '-i', 'pipe:0', '-vf', 'vflip', '-frames:v', '1', out])
      png.proc.stdin!.end(last)
      await png.done
      return out
    },
    async stop () {
      stopping = true
      if (timer) clearTimeout(timer)
      timer = null
      // ffmpeg already gone on its own: teardown ran, nothing left to close.
      if (ended !== null) return file
      bot.off('move', follow)
      bot.off('login', onLogin)
      bot.off('spawn', onSpawn)
      worldView.removeListenersFromBot(bot)
      // Closing ffmpeg's stdin writes the moov atom; it must run even if GL teardown throws.
      stdin.end()
      try {
        await video.done
      } finally {
        try { viewer.dispose() } catch {}
        destroyGl()
      }
      return file
    }
  }
}
