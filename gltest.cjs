const createContext = require('gl')
const t0 = Date.now()
const gl = createContext(854, 480, { preserveDrawingBuffer: true })
if (!gl) { console.log(process.env.DISPLAY, 'FAILED to create context'); process.exit(1) }
console.log('DISPLAY=' + process.env.DISPLAY, '|', gl.getParameter(gl.VENDOR), '|', gl.getParameter(gl.RENDERER), '| create', Date.now() - t0, 'ms')
