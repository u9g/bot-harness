import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'

const require = createRequire(import.meta.url)

export interface RecordOpts {
  width?: number
  height?: number
  fps?: number
  // Chunk radius meshed around the bot.
  viewDistance?: number
  numWorkers?: number
}

export interface Recording {
  file: string
  snapshot: (file: string) => Promise<string>
  stop: () => Promise<string>
}

// node-canvas-webgl's GL context comes through GLX, so an X display is required even with software Mesa.
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

export async function startRecording (bot: Bot, file: string, opts: RecordOpts = {}): Promise<Recording> {
  const { width = 640, height = 360, fps = 20, viewDistance = 4, numWorkers = 1 } = opts
  await ensureDisplay(width, height)
  if (!bot.entity) await new Promise<void>(resolve => bot.once('spawn', resolve))

  const { headless } = require('prismarine-viewer')
  const { supportedVersions } = require('prismarine-viewer/viewer')
  const recording = headless(bot, { output: file, width, height, fps, viewDistance, numWorkers })
  if (!recording) throw new Error(`prismarine-viewer has no assets for ${bot.version}; start the bot with -v one of ${supportedVersions.join(', ')}`)
  await recording.ready

  return {
    file,
    async snapshot (out) {
      writeFileSync(out, recording.canvas.toBuffer('image/png'))
      return out
    },
    async stop () {
      await recording.stop()
      return file
    }
  }
}
