// Artwork loading, accent extraction and CD rendering.
const TAU = Math.PI * 2
const artCache = new Map() // key -> { image, accent, backdrop, ready }

function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

// Deterministic generated covers for demo mode.
function seeded(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

function generateCover(track) {
  const size = 512
  const c = makeCanvas(size, size)
  const ctx = c.getContext('2d')
  const rnd = seeded(track.id)
  const h1 = track.hue ?? Math.floor(rnd() * 360)
  const h2 = (h1 + 40 + rnd() * 120) % 360

  const g = ctx.createLinearGradient(0, 0, size, size)
  g.addColorStop(0, `hsl(${h1} 70% 22%)`)
  g.addColorStop(1, `hsl(${h2} 75% 48%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  for (let i = 0; i < 7; i++) {
    const x = rnd() * size
    const y = rnd() * size
    const r = 40 + rnd() * 220
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r)
    const hue = rnd() > 0.5 ? h1 : h2
    rg.addColorStop(0, `hsla(${(hue + rnd() * 40) % 360} 90% ${55 + rnd() * 25}% / ${0.35 + rnd() * 0.4})`)
    rg.addColorStop(1, `hsla(${hue} 90% 50% / 0)`)
    ctx.fillStyle = rg
    ctx.fillRect(0, 0, size, size)
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 3
  for (let i = 0; i < 5; i++) {
    ctx.beginPath()
    const y = size * (0.2 + rnd() * 0.6)
    ctx.moveTo(0, y)
    ctx.bezierCurveTo(size * 0.3, y - 90 * rnd(), size * 0.7, y + 90 * rnd(), size, y - 40 + 80 * rnd())
    ctx.stroke()
  }

  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = '700 46px "Segoe UI Variable Display", "Segoe UI", system-ui'
  ctx.textBaseline = 'bottom'
  ctx.fillText(track.title.toUpperCase(), 34, size - 34)
  return c
}

function extractAccent(image) {
  const s = 24
  const c = makeCanvas(s, s)
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, s, s)
  const data = ctx.getImageData(0, 0, s, s).data
  const bins = new Array(36).fill(0)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255
    const g = data[i + 1] / 255
    const b = data[i + 2] / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const l = (max + min) / 2
    const d = max - min
    if (d < 0.08) continue
    const sat = d / (1 - Math.abs(2 * l - 1))
    let h
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
    bins[Math.floor(h / 10)] += sat * (1 - Math.abs(l - 0.55))
  }
  let best = -1
  let bestScore = 0
  bins.forEach((v, i) => {
    // smooth with neighbours so one noisy bin doesn't win
    const score = v + 0.5 * (bins[(i + 35) % 36] + bins[(i + 1) % 36])
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  })
  const hue = best < 0 ? 350 : best * 10 + 5
  const sat = best < 0 ? 0 : 82
  return { hue, css: `hsl(${hue} ${sat}% 60%)`, rgb: hslToRgb(hue / 360, sat / 100, 0.6) }
}

function hslToRgb(h, s, l) {
  const f = n => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
  }
  return [f(0), f(8), f(4)]
}

function makeBackdrop(image, w, h) {
  const scale = 0.5
  const c = makeCanvas(Math.ceil(w * scale), Math.ceil(h * scale))
  const ctx = c.getContext('2d')
  ctx.filter = 'blur(28px) saturate(1.5)'
  const side = Math.max(c.width, c.height) * 1.4
  ctx.globalAlpha = 0.9
  ctx.drawImage(image, (c.width - side) / 2, (c.height - side) / 2 - c.height * 0.15, side, side)
  return c
}

const SCENE_SIZE = { w: 480, h: 420 }

function artEntry(key) {
  let entry = artCache.get(key)
  if (!entry) {
    entry = { ready: false }
    artCache.set(key, entry)
    if (artCache.size > 40) artCache.delete(artCache.keys().next().value)
  }
  return entry
}

function finishArt(key, image) {
  const entry = artEntry(key)
  entry.image = image
  entry.accent = extractAccent(image)
  entry.backdrop = makeBackdrop(image, SCENE_SIZE.w, SCENE_SIZE.h)
  entry.ready = true
  entry.readyAt = performance.now()
  document.dispatchEvent(new CustomEvent('art-ready', { detail: key }))
}

// Called by sources when artwork bytes arrive.
function provideArtData(key, dataUrl) {
  if (!key || !dataUrl) return
  const img = new Image()
  img.onload = () => finishArt(key, cropToSquare(img))
  img.src = dataUrl
}

// Video thumbnails (e.g. YouTube) are 16:9; Spotify sometimes pads art.
// Centre-crop to a square so the disc print is never stretched.
function cropToSquare(img) {
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (Math.abs(w - h) < 2) return img
  const s = Math.min(w, h)
  const c = makeCanvas(s, s)
  c.getContext('2d').drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, s, s)
  return c
}

function loadArt(track) {
  const key = track?.artKey
  if (!key) return null
  const entry = artEntry(key)
  if (!entry.ready && track.generated && !entry.generating) {
    entry.generating = true
    finishArt(key, generateCover(track))
    entry.readyAt = 0 // demo art is instant, no fade
  }
  return entry
}

// Static grooves texture shared by all discs.
let grooveCache = null
function grooves(size) {
  if (grooveCache && grooveCache.width === size) return grooveCache
  const c = makeCanvas(size, size)
  const ctx = c.getContext('2d')
  const r = size / 2
  const rnd = seeded('grooves')
  for (let i = 0; i < 70; i++) {
    const rr = r * (0.24 + rnd() * 0.75)
    ctx.beginPath()
    ctx.arc(r, r, rr, 0, TAU)
    ctx.strokeStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)'
    ctx.lineWidth = 0.6 + rnd()
    ctx.stroke()
  }
  grooveCache = c
  return c
}

/**
 * Draw one CD. The printed art rotates with the disc, while the light
 * (iridescent sheen + specular streak) stays fixed, which is what sells
 * the spin.
 */
function drawDisc(ctx, x, y, r, rotation, art, dim = 0) {
  const hole = r * 0.075
  const clear = r * 0.2

  const ring = new Path2D()
  ring.arc(0, 0, r, 0, TAU)
  ring.arc(0, 0, hole, 0, TAU)

  ctx.save()
  ctx.translate(x, y)

  // Drop shadow (ring only so the spindle hole stays see-through)
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = r * 0.28
  ctx.shadowOffsetY = r * 0.1
  ctx.fillStyle = '#111'
  ctx.fill(ring, 'evenodd')
  ctx.restore()

  ctx.save()
  ctx.clip(ring, 'evenodd')

  // Printed artwork, rotating
  ctx.save()
  ctx.rotate(rotation)
  // Blank silver disc underneath; art "prints" onto it when it arrives.
  const g = ctx.createRadialGradient(0, 0, hole, 0, 0, r)
  g.addColorStop(0, '#3a3b42')
  g.addColorStop(0.6, '#24252b')
  g.addColorStop(1, '#18181d')
  ctx.fillStyle = g
  ctx.fillRect(-r, -r, r * 2, r * 2)
  if (art && art.ready) {
    const img = art.image
    const iw = img.naturalWidth || img.width
    const ih = img.naturalHeight || img.height
    const s = Math.min(iw, ih)
    ctx.globalAlpha = art.readyAt ? Math.min(1, (performance.now() - art.readyAt) / 320) : 1
    ctx.drawImage(img, (iw - s) / 2, (ih - s) / 2, s, s, -r, -r, r * 2, r * 2)
    ctx.globalAlpha = 1
  }
  const gr = grooves(256)
  ctx.globalAlpha = 0.9
  ctx.drawImage(gr, -r, -r, r * 2, r * 2)
  ctx.globalAlpha = 1
  ctx.restore()

  // Iridescent data-side sheen (fixed to the light, not the disc)
  if (ctx.createConicGradient) {
    const cg = ctx.createConicGradient(-0.6, 0, 0)
    const stops = [
      [0, 'rgba(255,255,255,0)'],
      [0.06, 'rgba(120,200,255,0.30)'],
      [0.1, 'rgba(255,120,220,0.25)'],
      [0.14, 'rgba(255,255,255,0)'],
      [0.5, 'rgba(255,255,255,0)'],
      [0.56, 'rgba(255,220,120,0.22)'],
      [0.6, 'rgba(120,255,200,0.22)'],
      [0.64, 'rgba(255,255,255,0)'],
      [1, 'rgba(255,255,255,0)']
    ]
    stops.forEach(([o, c]) => cg.addColorStop(o, c))
    ctx.globalCompositeOperation = 'screen'
    ctx.fillStyle = cg
    ctx.fillRect(-r, -r, r * 2, r * 2)
  }

  // Specular streak
  const lg = ctx.createLinearGradient(-r, -r, r, r)
  lg.addColorStop(0.28, 'rgba(255,255,255,0)')
  lg.addColorStop(0.4, 'rgba(255,255,255,0.16)')
  lg.addColorStop(0.46, 'rgba(255,255,255,0)')
  ctx.fillStyle = lg
  ctx.fillRect(-r, -r, r * 2, r * 2)
  ctx.globalCompositeOperation = 'source-over'

  // Clear polycarbonate hub
  ctx.beginPath()
  ctx.arc(0, 0, clear, 0, TAU)
  ctx.arc(0, 0, hole, 0, TAU)
  ctx.fillStyle = 'rgba(14,14,18,0.62)'
  ctx.fill('evenodd')
  ctx.beginPath()
  ctx.arc(0, 0, clear * 0.72, 0, TAU)
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 1
  ctx.stroke()

  if (dim > 0) {
    ctx.fillStyle = `rgba(6,6,9,${dim})`
    ctx.fillRect(-r, -r, r * 2, r * 2)
  }
  ctx.restore()

  // Edges
  ctx.beginPath()
  ctx.arc(0, 0, r - 0.5, 0, TAU)
  ctx.strokeStyle = 'rgba(255,255,255,0.20)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(0, 0, clear, 0, TAU)
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(0, 0, hole + 0.5, 0, TAU)
  ctx.strokeStyle = 'rgba(255,255,255,0.28)'
  ctx.stroke()

  ctx.restore()
}
