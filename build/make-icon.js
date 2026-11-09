// Renders the app icon (a glossy CD) at every size Windows wants and writes
// build/icon.png + build/icon.ico.   Run:  npm run icon
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// Runs inside the page. Keep it self-contained.
function drawIcon(size) {
  const TAU = Math.PI * 2
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const cx = size / 2
  const cy = size / 2
  const r = size * (size <= 24 ? 0.48 : 0.44)
  const hole = r * (size <= 24 ? 0.16 : 0.1)
  const hub = r * (size <= 24 ? 0.3 : 0.24)

  // soft drop shadow (only where it can be seen)
  if (size >= 48) {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = size * 0.05
    ctx.shadowOffsetY = size * 0.02
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, TAU)
    ctx.fillStyle = '#000'
    ctx.fill()
    ctx.restore()
  }

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, TAU)
  ctx.clip()

  // printed "album art"
  const base = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r)
  base.addColorStop(0, '#ff2e6e')
  base.addColorStop(0.5, '#c23cff')
  base.addColorStop(1, '#3b2bd6')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)
  const warm = ctx.createRadialGradient(cx - r * 0.45, cy - r * 0.5, 0, cx - r * 0.45, cy - r * 0.5, r * 1.1)
  warm.addColorStop(0, 'rgba(255,170,80,0.85)')
  warm.addColorStop(1, 'rgba(255,170,80,0)')
  ctx.fillStyle = warm
  ctx.fillRect(0, 0, size, size)

  // grooves
  if (size >= 64) {
    for (let i = 0; i < 26; i++) {
      ctx.beginPath()
      ctx.arc(cx, cy, hub + (r - hub) * (i / 26), 0, TAU)
      ctx.strokeStyle = i % 2 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)'
      ctx.lineWidth = Math.max(0.5, size / 512)
      ctx.stroke()
    }
  }

  // iridescent data-side sheen
  const cg = ctx.createConicGradient(-0.7, cx, cy)
  ;[
    [0, 'rgba(255,255,255,0)'],
    [0.05, 'rgba(140,220,255,0.55)'],
    [0.1, 'rgba(255,140,230,0.45)'],
    [0.16, 'rgba(255,255,255,0)'],
    [0.5, 'rgba(255,255,255,0)'],
    [0.55, 'rgba(255,230,140,0.4)'],
    [0.6, 'rgba(140,255,210,0.4)'],
    [0.66, 'rgba(255,255,255,0)'],
    [1, 'rgba(255,255,255,0)']
  ].forEach(([o, col]) => cg.addColorStop(o, col))
  ctx.globalCompositeOperation = 'screen'
  ctx.fillStyle = cg
  ctx.fillRect(0, 0, size, size)

  // glassy specular streak
  const spec = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r)
  spec.addColorStop(0.22, 'rgba(255,255,255,0)')
  spec.addColorStop(0.34, 'rgba(255,255,255,0.35)')
  spec.addColorStop(0.42, 'rgba(255,255,255,0)')
  ctx.fillStyle = spec
  ctx.fillRect(0, 0, size, size)
  ctx.globalCompositeOperation = 'source-over'

  // clear polycarbonate hub
  ctx.beginPath()
  ctx.arc(cx, cy, hub, 0, TAU)
  ctx.fillStyle = 'rgba(20,16,30,0.6)'
  ctx.fill()
  ctx.restore()

  // rims
  const line = Math.max(1, size / 128)
  ctx.lineWidth = line
  ctx.beginPath()
  ctx.arc(cx, cy, r - line / 2, 0, TAU)
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.stroke()
  if (size >= 32) {
    ctx.beginPath()
    ctx.arc(cx, cy, hub, 0, TAU)
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    ctx.stroke()
  }

  // spindle hole: truly transparent
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.arc(cx, cy, hole, 0, TAU)
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
  ctx.beginPath()
  ctx.arc(cx, cy, hole + line / 2, 0, TAU)
  ctx.strokeStyle = 'rgba(255,255,255,0.45)'
  ctx.stroke()

  return c.toDataURL('image/png')
}

// ICO with PNG-compressed entries (supported since Windows Vista).
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach(({ size, png }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...entries.map(e => e.png)])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<!doctype html><title>icon</title>')
  const render = async size => {
    const url = await win.webContents.executeJavaScript(`(${drawIcon.toString()})(${size})`)
    return Buffer.from(url.split(',')[1], 'base64')
  }

  const out = __dirname
  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const entries = []
  for (const size of icoSizes) entries.push({ size, png: await render(size) })
  fs.writeFileSync(path.join(out, 'icon.ico'), buildIco(entries))
  fs.writeFileSync(path.join(out, 'icon.png'), await render(512))
  console.log('wrote build/icon.ico and build/icon.png')
  app.quit()
})
