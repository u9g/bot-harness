const createContext = require('gl')
const THREE = require('three')
const W = 854, H = 480
const gl = createContext(W, H, { preserveDrawingBuffer: true })
if (!gl) { console.log(process.env.DISPLAY, 'no context'); process.exit(1) }
const canvas = { width: W, height: H, addEventListener () {}, removeEventListener () {} }
gl.canvas = canvas
const renderer = new THREE.WebGLRenderer({ canvas, context: gl })
renderer.setSize(W, H, false)
const scene = new THREE.Scene()
const cam = new THREE.PerspectiveCamera(70, W / H, 0.1, 1000)
cam.position.set(0, 0, 60)
// A chunk-ish amount of geometry: 4000 textured cubes.
const geo = new THREE.BoxGeometry(1, 1, 1)
const mat = new THREE.MeshBasicMaterial({ color: 0x88aa55 })
const mesh = new THREE.InstancedMesh(geo, mat, 4000)
const m = new THREE.Matrix4()
for (let i = 0; i < 4000; i++) { m.setPosition((i % 40) - 20, ((i / 40) | 0) % 40 - 20, -((i / 1600) | 0)); mesh.setMatrixAt(i, m) }
scene.add(mesh)
const px = Buffer.alloc(W * H * 4)
for (let i = 0; i < 5; i++) { renderer.render(scene, cam); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px) }
const N = 60
const t0 = process.hrtime.bigint()
for (let i = 0; i < N; i++) { renderer.render(scene, cam); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px) }
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N
console.log(`DISPLAY=${process.env.DISPLAY}  ${ms.toFixed(2)} ms/frame`)
