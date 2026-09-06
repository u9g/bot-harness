// First-person recording of the bot's view: prismarine-viewer's core rendered
// through headless-gl into a three.js renderer with a stub canvas (no
// node-canvas, no DOM), frames piped raw into ffmpeg as an mp4.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'

const require = createRequire(import.meta.url)

export interface RecordOpts {
  width?: number
  height?: number
  fps?: number
  /** Chunk radius kept meshed around the bot. */
  viewDistance?: number
  /** Mesher worker threads; 0 meshes inline on the daemon's thread (no extra copy of the block data, but the bot stalls while meshing). */
  numWorkers?: number
}

export interface Recording {
  file: string
  /** Write the frame most recently sent to the video as a PNG. */
  snapshot: (file: string) => Promise<string>
  /** Finish the video; resolves to its path once ffmpeg has exited. */
  stop: () => Promise<string>
}

// headless-gl creates its GL context through GLX, so it needs an X server even
// with software Mesa. Start an Xvfb on :99 when there is no DISPLAY.
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
  const { width = 640, height = 360, fps = 20, viewDistance = 4, numWorkers = 1 } = opts
  await ensureDisplay(width, height)
  if (!bot.entity) await new Promise<void>(resolve => bot.once('spawn', resolve))

  const THREE = require('three')
  const createContext = require('gl')
  const { Viewer, WorldView, createNodeHost, supportedVersions } = require('prismarine-viewer/viewer')

  const gl = createContext(width, height, { preserveDrawingBuffer: true })
  if (!gl) throw new Error('headless-gl could not create a GL context (needs Mesa and an X display)')
  // three reads gl.canvas.width in WebGLState; headless-gl has no canvas
  const canvas = { width, height, addEventListener () {}, removeEventListener () {} }
  gl.canvas = canvas
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl })
  renderer.setSize(width, height, false)
  const destroyGl = (): void => {
    // renderer.dispose() drives three's animation.stop(), which calls
    // cancelAnimationFrame on a null context headless; the STACKGL destroy below
    // frees the whole GL context regardless, so a throw here is harmless.
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

  // Set the camera directly: setFirstPersonCamera tweens it, and the tween
  // never advances here.
  const follow = (): void => {
    const p = bot.entity.position
    viewer.camera.position.set(p.x, p.y + 1.6, p.z)
    viewer.camera.rotation.set(bot.entity.pitch, bot.entity.yaw, 0, 'ZYX')
    worldView.updatePosition(p)
  }
  follow()
  bot.on('move', follow)

  // Warm up before the first frame: prismarine-viewer meshes chunks and uploads
  // the block atlas asynchronously, so a recording that starts at t0 opens on
  // blank sky with untextured entity boxes and missing-texture markers. Render
  // in a loop until the atlas is up, some sections are meshed and none are still
  // outstanding, then settle a moment for entity skins, before piping any frame.
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
  const w = viewer.world as { material: { map: unknown }, sectionMeshs: Record<string, unknown>, sectionsOutstanding?: Set<unknown> }
  const warmupDeadline = performance.now() + 10_000
  while (performance.now() < warmupDeadline) {
    viewer.update()
    renderer.render(viewer.scene, viewer.camera)
    const outstanding = w.sectionsOutstanding ? w.sectionsOutstanding.size : 0
    if (w.material.map && Object.keys(w.sectionMeshs).length > 0 && outstanding === 0) break
    await sleep(50)
  }
  // A few more ticks give entity textures (player skins fetched over http) and
  // the atlas a moment to land before recording starts.
  for (let i = 0; i < 12; i++) { viewer.update(); renderer.render(viewer.scene, viewer.camera); await sleep(40) }

  const raw = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`]
  const video = ffmpeg([...raw, '-r', String(fps), '-i', 'pipe:0', '-vf', 'vflip', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file])

  const pixels = Buffer.alloc(width * height * 4)
  let last: Buffer | null = null
  const frameMs = 1000 / fps
  const t0 = performance.now()
  let written = 0
  let timer: NodeJS.Timeout | null = null
  const tick = (): void => {
    viewer.update()
    renderer.render(viewer.scene, viewer.camera)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    // The video runs at wall-clock speed: every frame slot that elapsed since
    // the last tick gets this frame, so a slow render repeats rather than
    // shortens the video.
    last = Buffer.from(pixels)
    const due = Math.floor((performance.now() - t0) / frameMs) + 1
    for (; written < due; written++) video.proc.stdin!.write(last)
    timer = setTimeout(tick, Math.max(0, t0 + written * frameMs - performance.now()))
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
      // Finalize the video before tearing anything down: closing ffmpeg's stdin
      // is what writes the moov atom, so it must happen even if GL teardown throws.
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
