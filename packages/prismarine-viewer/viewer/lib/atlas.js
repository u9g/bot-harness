const fs = require('fs')
const { Canvas, Image } = require('canvas')
const path = require('path')

function nextPowerOfTwo (n) {
  if (n === 0) return 1
  n--
  n |= n >> 1
  n |= n >> 2
  n |= n >> 4
  n |= n >> 8
  n |= n >> 16
  return n + 1
}

function readTexture (basePath, name) {
  if (name === 'missing_texture.png') {
    // grab ./missing_texture.png
    basePath = __dirname
  }
  return fs.readFileSync(path.join(basePath, name), 'base64')
}

// An animated texture is a vertical strip of square frames described by a
// .mcmeta next to it. Frame order and per-frame durations are baked into the
// atlas as repeated tiles, so the shader only needs a frame count and one
// frame time (in ticks). "interpolate" is ignored.
function readAnimation (basePath, name, img) {
  const mcmetaPath = path.join(basePath, name + '.mcmeta')
  if (img.height <= img.width || !fs.existsSync(mcmetaPath)) return null
  const { animation } = JSON.parse(fs.readFileSync(mcmetaPath, 'utf8'))
  if (!animation) return null
  const frametime = animation.frametime || 1
  const frameCount = Math.floor(img.height / img.width)
  const frames = animation.frames || [...Array(frameCount).keys()]
  return {
    frametime,
    frameHeight: img.width,
    frames: frames.flatMap(f => typeof f === 'number' ? [f] : Array(Math.max(1, Math.round(f.time / frametime))).fill(f.index))
  }
}

function makeTextureAtlas (mcAssets) {
  const blocksTexturePath = path.join(mcAssets.directory, '/blocks')
  const textureFiles = fs.readdirSync(blocksTexturePath).filter(file => file.endsWith('.png'))
  textureFiles.unshift('missing_texture.png')

  const tileSize = 16

  const textures = textureFiles.map(file => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + readTexture(blocksTexturePath, file)
    const animation = readAnimation(blocksTexturePath, file, img)
    return { name: file.split('.')[0], img, animation, frames: animation ? animation.frames : [0], frameHeight: animation ? animation.frameHeight : tileSize }
  })

  // Each texture takes a vertical run of tiles (one per frame). Tallest first,
  // each into the currently shortest column, so strips never straddle columns.
  const tileCount = textures.reduce((n, tex) => n + tex.frames.length, 0)
  const texSize = nextPowerOfTwo(Math.ceil(Math.sqrt(tileCount)))
  const columns = new Array(texSize).fill(0)
  textures.sort((a, b) => b.frames.length - a.frames.length)
  for (const tex of textures) {
    const col = columns.indexOf(Math.min(...columns))
    tex.x = col * tileSize
    tex.y = columns[col] * tileSize
    columns[col] += tex.frames.length
  }

  const imgWidth = texSize * tileSize
  const imgHeight = nextPowerOfTwo(Math.max(...columns) * tileSize)
  const canvas = new Canvas(imgWidth, imgHeight, 'png')
  const g = canvas.getContext('2d')

  const texturesIndex = {}

  for (const tex of textures) {
    texturesIndex[tex.name] = { u: tex.x / imgWidth, v: tex.y / imgHeight, su: tileSize / imgWidth, sv: tileSize / imgHeight }
    if (tex.animation) {
      texturesIndex[tex.name].frames = tex.frames.length
      texturesIndex[tex.name].frametime = tex.animation.frametime
    }
    tex.frames.forEach((frame, i) => {
      g.drawImage(tex.img, 0, frame * tex.frameHeight, tileSize, tileSize, tex.x, tex.y + i * tileSize, tileSize, tileSize)
    })
  }

  return { image: canvas.toBuffer(), canvas, json: { tileSize, width: imgWidth, height: imgHeight, textures: texturesIndex } }
}

module.exports = {
  makeTextureAtlas
}
