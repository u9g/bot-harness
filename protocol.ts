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
  /** Where recordings land when a script gives no path. */
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

export type ExecReply =
  | { id: number, ok: true, value: string }
  | { id: number, ok: false, error: string }
