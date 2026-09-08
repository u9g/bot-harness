// Records the first packet the protocol definitions cannot read, then stays silent.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Bot } from 'mineflayer'

const FILE = 'bad-packet.json'
/** At most one file per process; `wx` below makes it at most one per directory across processes. */
let done = false

export interface BotInfo { name: string, host: string, port: number, username: string, version: string }

export interface Fingerprint {
  at: string
  bot: BotInfo
  state: string
  packet: { id: number, name: string | null }
  /** 'partial-read': the definitions expect more bytes than arrived. 'trailing-bytes': fewer. */
  problem: 'partial-read' | 'trailing-bytes'
  length: number
  /** Bytes the definitions consumed before they stopped; only for 'trailing-bytes'. */
  read?: number
  sha256: string
  bytes: string
  error?: { name: string, message: string, stack?: string }
}

interface Parsed { data: { name: string }, metadata: { size: number } }
interface Deserializer {
  noErrorLogging: boolean
  parsePacketBuffer: (buffer: Buffer) => Parsed
}

/** A packet buffer starts with its id as a varint. */
function packetId (b: Buffer): number {
  let v = 0
  for (let i = 0, shift = 0; i < b.length && i < 5; i++, shift += 7) {
    v |= (b[i] & 0x7f) << shift
    if ((b[i] & 0x80) === 0) break
  }
  return v
}

const isPartialRead = (e: unknown): e is Error => (e as { partialReadError?: boolean })?.partialReadError === true

function drop (fp: Fingerprint, onWrite: (file: string) => void): void {
  if (done) return
  done = true
  const file = path.join(process.cwd(), FILE)
  try {
    fs.writeFileSync(file, JSON.stringify(fp, null, 2) + '\n', { flag: 'wx' })
    onWrite(file)
  } catch {}
}

/**
 * Wraps one deserializer. Must be applied per protocol state: nmp builds a new deserializer for
 * each one.
 */
function wrap (d: Deserializer, info: BotInfo, state: () => string, onWrite: (file: string) => void): void {
  d.noErrorLogging = true
  const parse = d.parsePacketBuffer.bind(d)
  const base = (buffer: Buffer): Omit<Fingerprint, 'packet' | 'problem'> => ({
    at: new Date().toISOString(),
    bot: info,
    state: state(),
    length: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.toString('hex')
  })
  d.parsePacketBuffer = (buffer) => {
    let packet: Parsed
    try {
      packet = parse(buffer)
    } catch (e) {
      if (isPartialRead(e)) {
        drop({
          ...base(buffer),
          // The failing reader is the innermost packet_* frame.
          packet: { id: packetId(buffer), name: /packet_(\w+)/.exec(e.stack ?? '')?.[1] ?? null },
          problem: 'partial-read',
          error: { name: e.name, message: e.message, stack: e.stack }
        }, onWrite)
      }
      throw e
    }
    if (packet.metadata.size !== buffer.length) {
      drop({
        ...base(buffer),
        packet: { id: packetId(buffer), name: packet.data.name },
        problem: 'trailing-bytes',
        read: packet.metadata.size
      }, onWrite)
    }
    return packet
  }
}

/** Installs on the bot's current deserializer and on every one nmp builds after it. */
export function fingerprintBadPackets (bot: Bot, info: BotInfo, onWrite: (file: string) => void): void {
  const client = bot._client
  const hook = (): void => { wrap(client.deserializer as unknown as Deserializer, info, () => client.state, onWrite) }
  hook()
  client.on('state', hook)
}
