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

function loadImage (basePath, name) {
  const img = new Image()
  img.src = 'data:image/png;base64,' + readTexture(basePath, name)
  return img
}

// Tiles keep their native resolution (26.1 ships 32x32 block textures);
// each atlas entry carries its own u/v/su/sv extents, so consumers such as
// modelsBuilder are resolution-agnostic.
function makeTextureAtlas (mcAssets) {
  const blocksTexturePath = path.join(mcAssets.directory, '/blocks')
  const textureFiles = fs.readdirSync(blocksTexturePath).filter(file => file.endsWith('.png'))
  textureFiles.unshift('missing_texture.png')

  const tileSize = 16

  const tiles = textureFiles.map(file => {
    const img = loadImage(blocksTexturePath, file)
    const animation = readAnimation(blocksTexturePath, file, img)
    return {
      name: file.split('.')[0],
      img,
      animation,
      frames: animation ? animation.frames : [0],
      w: img.width,
      // animated textures are vertical filmstrips (e.g. 16x512 = 32 frames)
      // of native-width square frames; all frames are baked into the atlas
      // (see readAnimation) and a model's UVs address a single frame
      frameHeight: animation ? animation.frameHeight : img.height,
      h: animation ? animation.frames.length * animation.frameHeight : img.height
    }
  })

  // shelf-pack: sort by height, lay out rows, then round the atlas up to a
  // power of two. Each texture — including a full vertical run of animation
  // frames — is placed as a single rectangle, so runs never straddle rows.
  const totalArea = tiles.reduce((a, t) => a + t.w * t.h, 0)
  const maxWidth = Math.max(...tiles.map(t => t.w))
  const width = nextPowerOfTwo(Math.max(maxWidth, Math.ceil(Math.sqrt(totalArea))))
  tiles.sort((a, b) => b.h - a.h)

  let shelfX = 0
  let shelfY = 0
  let shelfH = 0
  let packedHeight = 0
  const texturesIndex = {}
  for (const tile of tiles) {
    if (shelfX + tile.w > width) {
      shelfX = 0
      shelfY += shelfH
      shelfH = 0
    }
    tile.x = shelfX
    tile.y = shelfY
    shelfX += tile.w
    shelfH = Math.max(shelfH, tile.h)
    packedHeight = Math.max(packedHeight, shelfY + tile.h)
  }
  const height = nextPowerOfTwo(packedHeight)

  for (const tile of tiles) {
    texturesIndex[tile.name] = { u: tile.x / width, v: tile.y / height, su: tile.w / width, sv: tile.frameHeight / height }
    if (tile.animation) {
      texturesIndex[tile.name].frames = tile.frames.length
      texturesIndex[tile.name].frametime = tile.animation.frametime
    }
  }

  const canvas = new Canvas(width, height, 'png')
  const g = canvas.getContext('2d')
  for (const tile of tiles) {
    tile.frames.forEach((frame, i) => {
      g.drawImage(tile.img, 0, frame * tile.frameHeight, tile.w, tile.frameHeight, tile.x, tile.y + i * tile.frameHeight, tile.w, tile.frameHeight)
    })
  }

  return { image: canvas.toBuffer(), canvas, json: { tileSize, width, height, textures: texturesIndex } }
}

module.exports = {
  makeTextureAtlas
}
