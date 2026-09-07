// Wire protocol between mcbot.ts and daemon.ts: newline-delimited JSON over a unix socket.
export interface BotOpts {
  host: string
  port: number
  username: string
  auth: 'offline' | 'microsoft'
  version: string
  [k: string]: unknown
}

export interface DaemonOpts {
  name: string
  // Default directory for recordings when a script gives no path.
  dir: string
  bot: BotOpts
  sock: string
  pidFile: string
}

export interface ExecRequest {
  id: number
  code: string
  timeout?: number
}

/** Asks the daemon what the bot itself is doing, without running any user code. */
export interface StatusRequest {
  id: number
  status: true
}

export type Request = ExecRequest | StatusRequest

export interface BotStatus {
  connected: boolean
  username: string
  host: string
  port: number
  version: string
  loginAt?: string
  position?: { x: number, y: number, z: number }
  health?: number
  lastKick?: { at: string, reason: string }
  lastEnd?: { at: string, reason: string }
  lastError?: { at: string, message: string }
}

export type ExecReply =
  | { id: number, ok: true, value: string }
  | { id: number, ok: false, error: string }
