#!/usr/bin/env node
// Differential check of node-minecraft-protocol against the packets produced by
// the Lean generator.  For every packet line:
//   1. serialize `params` with nmp            -> must equal the Lean bytes
//   2. parse the Lean bytes with nmp           -> must consume every byte
//   3. re-serialize what nmp parsed            -> must give the same bytes again
//
// usage: node harness/validate.js <mc version> [packetgen options...]
//   e.g. node harness/validate.js 1.21.4 --size 2 --limit 200
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const { spawn } = require('child_process')
const mcData = require('minecraft-data')
const { createSerializer, createDeserializer } = require('minecraft-protocol')

const [version, ...genArgs] = process.argv.slice(2)
if (!version) {
  console.error('usage: node harness/validate.js <mc version> [packetgen options...]')
  process.exit(2)
}
const data = mcData(version)
if (!data) throw new Error(`no minecraft-data for ${version}`)

const protoFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'packetgen-')), 'protocol.json')
fs.writeFileSync(protoFile, JSON.stringify(data.protocol))
const bin = path.join(__dirname, '..', '.lake', 'build', 'bin', 'packetgen')

function revive (v) {
  if (Array.isArray(v)) return v.map(revive)
  if (v === null || typeof v !== 'object') return v
  const keys = Object.keys(v)
  if (keys.length === 1) {
    const k = keys[0]
    if (k === '$bigint') return BigInt(v[k])
    // nmp takes varlong as a JS number (a BigInt makes it throw); use one when exact
    if (k === '$varlong') return Number.isSafeInteger(Number(v[k])) ? Number(v[k]) : BigInt(v[k])
    if (k === '$buffer') return Buffer.from(v[k], 'hex')
    if (k === '$f32') { const b = Buffer.alloc(4); b.writeUInt32BE(v[k]); return b.readFloatBE() }
    if (k === '$f64') { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v[k])); return b.readDoubleBE() }
  }
  const out = {}
  for (const k of keys) out[k] = revive(v[k])
  return out
}

const codecs = {}
function codec (state, direction) {
  const key = state + direction
  if (!codecs[key]) {
    const isServer = direction === 'toClient'
    codecs[key] = {
      ser: createSerializer({ state, isServer, version }),
      de: createDeserializer({ state, isServer: !isServer, version, noErrorLogging: true })
    }
  }
  return codecs[key]
}

const failures = new Map() // packet -> first failure
const counts = new Map()
let total = 0
let failed = 0

function fail (p, kind, detail) {
  failed++
  const key = `${p.state}.${p.direction}.${p.name}`
  if (!failures.has(key)) failures.set(key, { kind, size: p.size, params: p.params, expected: p.hex, detail })
}

function check (p) {
  total++
  const key = `${p.state}.${p.direction}.${p.name}`
  counts.set(key, (counts.get(key) || 0) + 1)
  const { ser, de } = codec(p.state, p.direction)
  let written
  try {
    written = ser.createPacketBuffer({ name: p.name, params: revive(p.params) }).toString('hex')
  } catch (e) {
    return fail(p, 'serialize threw', e.message)
  }
  if (written !== p.hex) return fail(p, 'serialize mismatch', `nmp wrote ${written}`)
  let parsed
  try {
    parsed = de.parsePacketBuffer(Buffer.from(p.hex, 'hex'))
  } catch (e) {
    return fail(p, 'parse threw', e.message)
  }
  if (parsed.metadata.size !== p.hex.length / 2) {
    return fail(p, 'parse length', `nmp consumed ${parsed.metadata.size} of ${p.hex.length / 2} bytes`)
  }
  let rewritten
  try {
    rewritten = ser.createPacketBuffer(parsed.data).toString('hex')
  } catch (e) {
    return fail(p, 're-serialize threw', e.message)
  }
  if (rewritten !== p.hex) return fail(p, 'round trip mismatch', `nmp re-wrote ${rewritten}`)
}

const gen = spawn(bin, [protoFile, ...genArgs], { stdio: ['ignore', 'pipe', 'inherit'] })
const rl = readline.createInterface({ input: gen.stdout })
rl.on('line', line => check(JSON.parse(line)))
gen.on('close', code => {
  if (code !== 0) { console.error(`packetgen exited with ${code}`); process.exit(code) }
  for (const [key, f] of failures) {
    console.log(`FAIL ${key} (${f.kind})`)
    console.log(`  params:   ${JSON.stringify(f.params)}`)
    console.log(`  expected: ${f.expected}`)
    console.log(`  ${f.detail}`)
  }
  const bad = new Set(failures.keys())
  console.log(`\n${total} packets checked across ${counts.size} packet types, ${failed} failed (${bad.size} packet types)`)
  process.exit(failed ? 1 : 0)
})
