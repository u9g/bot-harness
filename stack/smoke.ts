// Loads every vendored package the way the harness does.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
// Transitive packages resolve only from a workspace package that depends on them.
const fromMineflayer = createRequire(require.resolve('mineflayer/package.json'))

const mcData = fromMineflayer('minecraft-data')
const data = mcData('26.1')
if (!data?.blocksByName?.stone) throw new Error('minecraft-data 26.1 did not load')
fromMineflayer('protodef')
fromMineflayer('minecraft-protocol')
fromMineflayer('prismarine-item')('26.1')
fromMineflayer('prismarine-physics')
const mineflayer = require('mineflayer')
if (typeof mineflayer.createBot !== 'function') throw new Error('mineflayer has no createBot')
const pathfinder = require('mineflayer-pathfinder')
if (typeof pathfinder.pathfinder !== 'function') throw new Error('mineflayer-pathfinder has no plugin')
const viewer = require('prismarine-viewer/viewer')
if (typeof viewer.Viewer !== 'function') throw new Error('prismarine-viewer/viewer is missing Viewer')
if (typeof viewer.createNodeHost !== 'function') console.warn('warning: prismarine-viewer/viewer has no createNodeHost, so `mcbot record` will not work; the host PR (PrismarineJS/prismarine-viewer#503) is not in the stack')
console.log(`ok: minecraft-data ${fromMineflayer('minecraft-data/package.json').version}, mineflayer ${require('mineflayer/package.json').version}, viewer ${require('prismarine-viewer/package.json').version}, ${viewer.supportedVersions?.length ?? '?'} viewer versions`)
