import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
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

export interface Recording {
  file: string
  snapshot: (file: string) => Promise<string>
  stop: () => Promise<string>
}

// headless-gl's context comes through GLX, so an X display is required even with software Mesa.
async function ensureDisplay (width: number, height: number): Promise<void> {
  if (process.platform !== 'linux' || process.env.DISPLAY) return
  process.env.DISPLAY = ':99'
  if (existsSync('/tmp/.X11-unix/X99')) return
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

export async function startRecording (bot: Bot, file: string, opts: RecordOpts = {}): Promise<Recording> {
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

  const pixels = Buffer.alloc(width * height * 4)
  let last: Buffer | null = null
  const frameMs = 1000 / fps
  const t0 = performance.now()
  let written = 0
  let timer: NodeJS.Timeout | null = null
  const tick = (): void => {
    const start = performance.now()
    viewer.update()
    renderer.render(viewer.scene, viewer.camera)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const cost = performance.now() - start
    // Output runs at wall-clock rate: every frame slot elapsed since t0 gets the latest render.
    last = Buffer.from(pixels)
    const due = Math.floor((performance.now() - t0) / frameMs) + 1
    for (; written < due; written++) video.proc.stdin!.write(last)
    // A render blocks the daemon's only thread, so the bot's physics and packet handling stop for
    // `cost`. The next render waits at least gap(cost), capping that share at `duty` and keeping
    // the bot's movement close enough to real time that servers do not see it teleport-desync.
    const next = Math.max(t0 + written * frameMs - performance.now(), gap(cost))
    timer = setTimeout(tick, Math.max(0, next))
  }
  tick()

  return {
    file,
    async snapshot (out) {
      if (!last) throw new Error('no frame yet')
      const png = ffmpeg([...raw, '-i', 'pipe:0', '-vf', 'vflip', '-frames:v', '1', out])
      png.proc.stdin!.end(last)
      await png.done
      return out
    },
    async stop () {
      if (timer) clearTimeout(timer)
      timer = null
      bot.off('move', follow)
      worldView.removeListenersFromBot(bot)
      // Closing ffmpeg's stdin writes the moov atom; it must run even if GL teardown throws.
      video.proc.stdin!.end()
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
