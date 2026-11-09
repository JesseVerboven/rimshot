'use strict'

const $ = sel => document.querySelector(sel)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
// Opened in a plain browser (design preview) there is no Electron bridge: run the demo.
const inElectron = Boolean(window.native)
if (!inElectron) {
  const local = { size: 'compact', onTop: false, spin: true, glow: true, fullscreen: false }
  window.native = {
    onMedia() {},
    snapshot: async () => ({}),
    command() {},
    close() {},
    minimize() {},
    getSettings: async () => ({ ...local }),
    setSettings: async patch => ({ ...Object.assign(local, patch) })
  }
}

let W = window.innerWidth || 480
let H = window.innerHeight || 420

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const reduceTransparency = matchMedia('(prefers-reduced-transparency: reduce)')

// ---------------------------------------------------------------------------
// Wheel geometry. The discs sit on the rim of a huge wheel whose hub is far
// above the window, so we only ever see the bottom of it. Skipping forward
// turns the wheel: the current disc rolls off to the right (and up, following
// the rim) while the next one rolls in from the left.
// ---------------------------------------------------------------------------
const G = { cx: 240, cy: 168, r: 118, R: 760, step: 0.4, reach: 3 }
let SPACING = 304 // arc length between discs, in px
let ROLL = 2.6 // disc self-rotation per wheel step (rolling without slip)
const SPIN_SPEED = 0.55 // rad/s while playing
const prefs = { spin: true, glow: true, size: 'compact', onTop: false, fullscreen: false }

// Fit the wheel to the window: the focused disc sits between the title bar
// and the glass panel, dipping just under the panel's top edge.
function layoutWheel() {
  W = window.innerWidth
  H = window.innerHeight
  SCENE_SIZE.w = W
  SCENE_SIZE.h = H
  const panelTop = document.querySelector('#panel').getBoundingClientRect().top
  const top = prefs.fullscreen ? H * 0.07 : 50
  const r = Math.max(80, Math.min((panelTop + 28 - top) / 2, W * 0.3, 420))
  G.r = r
  G.cx = W / 2
  G.cy = top + r
  G.R = r * 6.4
  SPACING = r * 2.6
  G.step = SPACING / G.R
  ROLL = SPACING / r
  // how many neighbours can be on screen either side
  G.reach = Math.ceil(W / 2 / SPACING) + 1
}

const IDLE = { id: '__idle', title: 'Nothing playing', artist: 'Play something in Spotify', durationMs: 0, idle: true }
let pendingSeq = 0
const makePending = fromId => ({ id: `__pending-${++pendingSeq}`, pending: true, fromId, title: '', artist: '', durationMs: 0 })

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let timeline = [IDLE]
let cursor = 0
const wheel = new Spring(0, { damping: 1, response: 0.6 })
let spinVel = 0 // rad/s of the focused disc
let spinOwner = null // slot id of the disc currently spinning
let slotSeq = 0
let source = null
let state = null
let holdRemoteUntil = 0 // ignore track changes from the player while a skip lands
let holdClockUntil = 0
let shownId = null
const clock = { ms: 0, at: 0, playing: false, duration: 0 }

let bgFrom = null
let bgTo = null
let bgMix = 1
const accent = { cur: [0.96, 0.33, 0.45], target: [0.96, 0.33, 0.45] }
let reducedFade = 1
let dirty = true

// ---------------------------------------------------------------------------
// Canvas + glass setup
// ---------------------------------------------------------------------------
const scene = $('#scene')
const sctx = scene.getContext('2d')
let dpr = window.devicePixelRatio || 1
let glass = null
try {
  if (!reduceTransparency.matches) glass = new GlassLayer($('#glass'), scene)
} catch (err) {
  console.warn('Glass disabled:', err)
}
if (!glass) document.body.classList.add('no-glass')

function resize() {
  layoutWheel()
  dpr = window.devicePixelRatio || 1
  scene.width = Math.round(W * dpr)
  scene.height = Math.round(H * dpr)
  glass?.resize(W, H, dpr)
  dirty = true
}
resize()
// Covers window size changes (compact/wide/full screen) and late first layout.
new ResizeObserver(() => resize()).observe(document.querySelector('#app'))

// ---------------------------------------------------------------------------
// Timeline reconciliation
// ---------------------------------------------------------------------------
function place(i, track) {
  // keep the disc's print orientation when a slot's data is refreshed
  const prev = timeline[i]
  if (prev && prev !== track) {
    track.rot0 = prev.rot0
    track.slot = prev.slot // same physical disc, new data
  }
  timeline[i] = track
}

function roll(opts = { damping: 0.9, response: 0.65 }) {
  if (reduceMotion.matches) {
    wheel.jump(cursor)
    reducedFade = 0
  } else {
    wheel.to(cursor, opts)
  }
  dirty = true
}

function reconcile(s) {
  state = s
  const cur = s.current || IDLE
  const now = performance.now()

  if (!timeline.length) {
    const hist = (s.history || []).filter(t => t.id !== cur.id)
    timeline = [...hist, cur]
    cursor = hist.length
    wheel.jump(cursor)
    showTrack(0)
  } else {
    const shown = timeline[cursor]
    if (shown.id === cur.id) {
      holdRemoteUntil = 0
      place(cursor, cur)
      if (shownId !== cur.id) showTrack(0)
    } else if (shown.pending && !cur.idle && cur.id !== shown.fromId) {
      // The blank disc we optimistically rolled in now learns what it is.
      holdRemoteUntil = 0
      place(cursor, cur)
      showTrack(0, true)
    } else if (now < holdRemoteUntil) {
      // Player hasn't caught up with our skip yet.
      updatePlayingUI()
      return
    } else {
      let found = -1
      for (const d of [1, -1, 2, -2, 3, -3]) {
        if (timeline[cursor + d]?.id === cur.id) {
          found = cursor + d
          break
        }
      }
      if (found < 0) {
        const slot = timeline[cursor + 1]
        timeline = timeline.slice(0, cursor + 1)
        timeline.push(cur)
        if (slot?.pending) cur.rot0 = slot.rot0
        found = cursor + 1
      } else {
        place(found, cur)
      }
      const dir = Math.sign(found - cursor)
      cursor = found
      roll({ damping: 0.9, response: 0.7 })
      showTrack(dir)
    }
  }

  // Upcoming discs
  if (source.knowsQueue) {
    if (s.current) timeline = timeline.slice(0, cursor + 1).concat(s.queue)
  } else {
    const slot = timeline[cursor + 1]
    timeline = timeline.slice(0, cursor + 1)
    if (!cur.idle) timeline.push(slot?.pending ? slot : makePending())
  }
  trimHistory()
  syncClock(s)
  updateSourceLabel()
  dirty = true
}

function trimHistory() {
  const extra = cursor - 6
  if (extra > 0) {
    timeline.splice(0, extra)
    cursor -= extra
    wheel.value -= extra
    wheel.target -= extra
    if (drag) drag.startP -= extra
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
function progressNow() {
  const v = clock.playing ? clock.ms + (performance.now() - clock.at) : clock.ms
  return clock.duration ? Math.min(v, clock.duration) : v
}

function syncClock(s) {
  const now = performance.now()
  const shown = timeline[cursor]
  clock.duration = shown?.durationMs || 0
  if (shown?.id !== s.current?.id) return // still showing an optimistic skip
  if (now < holdClockUntil) return
  const remote = s.isPlaying ? s.progressMs + (now - s.receivedAt) : s.progressMs
  const changed = s.isPlaying !== clock.playing
  if (changed || Math.abs(remote - progressNow()) > 1500) {
    clock.ms = remote
    clock.at = now
  }
  clock.playing = s.isPlaying
  updatePlayingUI()
}

function setClock(ms, playing = clock.playing, holdMs = 1800) {
  clock.ms = ms
  clock.at = performance.now()
  clock.playing = playing
  holdClockUntil = performance.now() + holdMs
  updatePlayingUI()
}

function skip(delta, opts = { damping: 0.86, response: 0.62 }, { button = false } = {}) {
  if (!state?.current || delta === 0) return
  if (delta > 0 && state.canNext === false) return toast("This player doesn't support skipping")
  if (delta < 0 && state.canPrev === false) return toast("This player doesn't support going back")

  const restartFirst = source.kind !== 'demo' && progressNow() > 3000
  if (delta === -1 && button && restartFirst) {
    // Like every player: "previous" late in a song restarts it.
    source.previous()
    setClock(0)
    return
  }

  const from = timeline[cursor]
  if (delta > 0) {
    for (let k = 0; k < delta; k++) {
      if (!timeline[cursor + 1]) timeline.push(makePending())
      cursor++
    }
    if (timeline[cursor].pending) timeline[cursor].fromId = from.id
  } else {
    cursor = Math.max(0, cursor + delta)
  }

  holdRemoteUntil = performance.now() + 2500
  roll(opts)
  showTrack(Math.sign(delta))
  clock.duration = timeline[cursor].durationMs || 0
  setClock(0, clock.playing, 0)

  const times = delta > 0 ? delta : -delta + (restartFirst ? 1 : 0)
  for (let k = 0; k < times; k++) delta > 0 ? source.next() : source.previous()
  if (!source.knowsQueue) {
    const slot = timeline[cursor + 1]
    timeline = timeline.slice(0, cursor + 1)
    timeline.push(slot?.pending ? slot : makePending())
  }
}

function togglePlay() {
  if (!state?.current) return
  const play = !clock.playing
  setClock(progressNow(), play)
  source.setPlaying(play)
}

// ---------------------------------------------------------------------------
// Meta text
// ---------------------------------------------------------------------------
const metaEl = $('#meta')
const titleEl = $('#title')
const artistEl = $('#artist')
const eyebrowEl = $('#eyebrow')
const miniArt = $('#mini-art')
const miniCtx = miniArt.getContext('2d')

function showTrack(dir, quiet = false) {
  const t = timeline[cursor]
  shownId = t.id
  if (t.pending) {
    eyebrowEl.textContent = 'Up next'
    titleEl.textContent = ' '
    artistEl.textContent = ' '
  } else {
    eyebrowEl.textContent = t.idle ? 'Idle' : clock.playing || !state ? 'Now playing' : 'Paused'
    titleEl.textContent = t.title
    artistEl.textContent = t.artist
  }
  titleEl.title = t.title || ''
  drawMiniArt()
  document.title = t.idle || t.pending ? 'Rimshot' : `${t.title} · ${t.artist}`

  if (reduceMotion.matches || (dir === 0 && !quiet)) return
  metaEl.animate(
    quiet
      ? [{ opacity: 0.2 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: `translateX(${-dir * 16}px)`, filter: 'blur(3px)' },
          { opacity: 1, transform: 'none', filter: 'blur(0)' }
        ],
    { duration: quiet ? 220 : 380, easing: 'cubic-bezier(.2,.8,.2,1)' }
  )
}

function drawMiniArt() {
  const art = loadArt(timeline[cursor])
  miniCtx.clearRect(0, 0, 40, 40)
  if (art?.ready) miniCtx.drawImage(art.image, 0, 0, 40, 40)
}

document.addEventListener('art-ready', e => {
  dirty = true
  if (timeline[cursor]?.artKey === e.detail) drawMiniArt()
})

function updatePlayingUI() {
  document.body.classList.toggle('playing', clock.playing)
  $('#btn-play').setAttribute('aria-label', clock.playing ? 'Pause' : 'Play')
  const t = timeline[cursor]
  if (t && !t.pending && !t.idle) eyebrowEl.textContent = clock.playing ? 'Now playing' : 'Paused'
}

function updateSourceLabel() {
  const el = $('#source')
  const label = $('#source-label')
  if (source?.kind === 'demo') {
    label.textContent = 'Demo · press D to leave'
    el.classList.add('live')
  } else if (state?.app) {
    label.textContent = state.app
    el.classList.add('live')
  } else {
    label.textContent = 'Waiting for media'
    el.classList.remove('live')
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const easeInOut = t => t * t * (3 - 2 * t)

function hashAngle(id = '') {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return ((h >>> 0) % 628) / 100
}

function drawScene() {
  const ctx = sctx
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = '#07070a'
  ctx.fillRect(0, 0, W, H)

  if (prefs.glow) {
    // Ambient wash from the album art
    const k = easeInOut(clamp(bgMix, 0, 1))
    if (bgFrom?.backdrop && k < 1) {
      ctx.globalAlpha = 0.62 * (1 - k)
      ctx.drawImage(bgFrom.backdrop, 0, 0, W, H)
    }
    if (bgTo?.backdrop) {
      ctx.globalAlpha = 0.62 * k
      ctx.drawImage(bgTo.backdrop, 0, 0, W, H)
    }
    ctx.globalAlpha = 1

    const [ar, ag, ab] = accent.cur.map(v => Math.round(v * 255))
    const halo = ctx.createRadialGradient(G.cx, G.cy - 10, G.r * 0.5, G.cx, G.cy, G.r * 2.1)
    halo.addColorStop(0, `rgba(${ar},${ag},${ab},0.26)`)
    halo.addColorStop(1, `rgba(${ar},${ag},${ab},0)`)
    ctx.fillStyle = halo
    ctx.fillRect(0, 0, W, H)
  }

  const vig = ctx.createRadialGradient(G.cx, G.cy, G.r * 0.8, G.cx, G.cy + 60, Math.max(W, H) * 0.95)
  vig.addColorStop(0, 'rgba(7,7,10,0)')
  vig.addColorStop(1, 'rgba(7,7,10,0.88)')
  ctx.fillStyle = vig
  ctx.fillRect(0, 0, W, H)

  // Discs on the rim. Farthest first so the focused one sits on top.
  const p = wheel.value
  const discs = []
  for (let i = Math.floor(p) - G.reach; i <= Math.ceil(p) + G.reach; i++) {
    const item = timeline[i]
    if (!item) continue
    const a = (i - p) * G.step
    const x = G.cx - G.R * Math.sin(a)
    const y = G.cy - G.R + G.R * Math.cos(a)
    if (x < -G.r - 30 || x > W + G.r + 30) continue
    discs.push({ item, x, y, d: Math.abs(i - p) })
  }
  discs.sort((a, b) => b.d - a.d)

  ctx.globalAlpha = reducedFade
  for (const { item, x, y, d } of discs) {
    if (item.rot0 === undefined) item.rot0 = hashAngle(item.id)
    const rotation = item.rot0 + p * ROLL
    drawDisc(ctx, x, y, G.r, rotation, loadArt(item), Math.min(1, d) * 0.5)
  }
  ctx.globalAlpha = 1
}

const glassEls = [...document.querySelectorAll('[data-glass]')]
function collectShapes() {
  const shapes = []
  for (const el of glassEls) {
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden') continue
    // opacity multiplies down the tree (e.g. the title bar fading in full screen)
    let alpha = parseFloat(cs.opacity)
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) alpha *= parseFloat(getComputedStyle(p).opacity)
    if (alpha < 0.01) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1) continue
    shapes.push({
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      radius: el.dataset.radius === 'pill' ? Math.min(r.width, r.height) / 2 : parseFloat(cs.borderTopLeftRadius) || 0,
      tint: parseFloat(el.dataset.tint ?? '0.45'),
      alpha,
      strength: parseFloat(el.dataset.strength ?? '1'),
      color: el.dataset.color === 'accent' ? [...accent.cur, 0.6] : null
    })
  }
  return shapes
}

let lastShapeSig = ''
let lastFrame = performance.now()
let lastSecond = -1

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000)
  lastFrame = now
  let active = false

  if (wheel.step(dt)) active = true
  // Only the disc "in the drive" spins. It spins up when it arrives and
  // winds down on pause; the others just roll along with the wheel.
  const focused = timeline[cursor]
  if (focused && focused.slot === undefined) focused.slot = ++slotSeq
  if (focused?.slot !== spinOwner) {
    spinOwner = focused?.slot
    spinVel = 0
  }
  const spinTarget = prefs.spin && clock.playing && !reduceMotion.matches && state?.current ? SPIN_SPEED : 0
  spinVel += (spinTarget - spinVel) * Math.min(1, dt * 2.2)
  if (Math.abs(spinVel) < 1e-3 && spinTarget === 0) spinVel = 0
  if (spinVel !== 0 && focused) {
    if (focused.rot0 === undefined) focused.rot0 = hashAngle(focused.id)
    focused.rot0 += spinVel * dt
    active = true
  }
  if (reducedFade < 1) {
    reducedFade = Math.min(1, reducedFade + dt / 0.22)
    active = true
  }

  // Background + accent follow whichever disc is in focus
  const art = loadArt(timeline[cursor])
  const want = art?.ready ? art : null
  if (want !== bgTo) {
    bgFrom = bgTo
    bgTo = want
    bgMix = 0
    if (want) accent.target = want.accent.rgb
  }
  if (bgMix < 1) {
    bgMix = Math.min(1, bgMix + dt / 0.8)
    active = true
  }
  let accentMoving = false
  accent.cur = accent.cur.map((v, i) => {
    const d = accent.target[i] - v
    if (Math.abs(d) > 0.002) accentMoving = true
    return v + d * Math.min(1, dt * 6)
  })
  if (accentMoving) {
    const [r, g, b] = accent.cur.map(v => Math.round(v * 255))
    document.documentElement.style.setProperty('--accent', `rgb(${r} ${g} ${b})`)
    active = true
  }
  if (art?.readyAt && now - art.readyAt < 400) active = true

  updateProgress()

  const shapes = glass ? collectShapes() : null
  const sig = shapes ? JSON.stringify(shapes.map(s => [s.x, s.y, s.w, s.h, s.alpha])) : ''
  if (sig !== lastShapeSig) {
    lastShapeSig = sig
    active = true
  }

  if (active || dirty) {
    drawScene()
    glass?.render(shapes)
    dirty = false
  }
  requestAnimationFrame(frame)
}

// ---------------------------------------------------------------------------
// Progress + scrubbing
// ---------------------------------------------------------------------------
const fmt = ms => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const scrubEl = $('#scrub')
const fillEl = $('#fill')
const thumbEl = $('#thumb')
const bubbleEl = $('#bubble')
let scrubbing = false
let scrubFrac = 0

function setBar(frac) {
  fillEl.style.transform = `scaleX(${frac})`
  thumbEl.style.left = `${frac * 100}%`
}

function updateProgress() {
  const dur = clock.duration
  const ms = progressNow()
  if (!scrubbing) setBar(dur ? clamp(ms / dur, 0, 1) : 0)
  const sec = Math.floor((scrubbing ? scrubFrac * dur : ms) / 1000) * 10000 + Math.floor(dur / 1000)
  if (sec !== lastSecond) {
    lastSecond = sec
    const shown = scrubbing ? scrubFrac * dur : ms
    $('#elapsed').textContent = fmt(shown)
    $('#remaining').textContent = dur ? `-${fmt(dur - shown)}` : '--:--'
    scrubEl.setAttribute('aria-valuemax', String(Math.round(dur / 1000)))
    scrubEl.setAttribute('aria-valuenow', String(Math.round(shown / 1000)))
  }
  scrubEl.classList.toggle('disabled', !dur || state?.canSeek === false)
}

function fracAt(e) {
  const r = scrubEl.getBoundingClientRect()
  return clamp((e.clientX - r.left) / r.width, 0, 1)
}

function moveBubble(frac) {
  const r = scrubEl.getBoundingClientRect()
  const x = clamp(frac * r.width, 18, r.width - 18)
  bubbleEl.style.left = `${x}px`
  bubbleEl.textContent = fmt(frac * clock.duration)
}

scrubEl.addEventListener('pointerdown', e => {
  if (!clock.duration) return
  scrubEl.setPointerCapture(e.pointerId)
  scrubbing = true
  scrubFrac = fracAt(e)
  scrubEl.classList.add('active')
  setBar(scrubFrac)
  moveBubble(scrubFrac)
})
scrubEl.addEventListener('pointermove', e => {
  const f = fracAt(e)
  if (scrubbing) {
    scrubFrac = f
    setBar(f)
  }
  moveBubble(f)
})
const endScrub = commit => () => {
  if (!scrubbing) return
  scrubbing = false
  scrubEl.classList.remove('active')
  if (commit) {
    const ms = scrubFrac * clock.duration
    setClock(ms)
    source.seek(ms)
  }
}
scrubEl.addEventListener('pointerup', endScrub(true))
scrubEl.addEventListener('pointercancel', endScrub(false))
scrubEl.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  e.stopPropagation()
  const ms = clamp(progressNow() + (e.key === 'ArrowRight' ? 5000 : -5000), 0, clock.duration)
  setClock(ms)
  source.seek(ms)
})

// ---------------------------------------------------------------------------
// Wheel gesture: 1:1 drag, momentum projection, velocity hand-off
// ---------------------------------------------------------------------------
const hit = $('#wheel-hit')
let drag = null

hit.addEventListener('pointerdown', e => {
  hit.setPointerCapture(e.pointerId)
  // Grab the wheel wherever it is right now (interruptible mid-roll).
  wheel.jump(wheel.value)
  drag = { x0: e.clientX, startP: wheel.value, moved: false, samples: [{ x: e.clientX, t: e.timeStamp }] }
})

hit.addEventListener('pointermove', e => {
  if (!drag) return
  const dx = e.clientX - drag.x0
  if (!drag.moved && Math.abs(dx) < 6) return
  if (!drag.moved) {
    drag.moved = true
    hit.classList.add('dragging')
  }
  let p = drag.startP + dx / SPACING
  const min = 0
  const max = timeline.length - 1
  if (p < min) p = min - rubberband((min - p) * SPACING, W) / SPACING
  if (p > max) p = max + rubberband((p - max) * SPACING, W) / SPACING
  wheel.jump(p)
  dirty = true
  drag.samples.push({ x: e.clientX, t: e.timeStamp })
  if (drag.samples.length > 8) drag.samples.shift()
})

function releaseVelocity(samples) {
  const last = samples[samples.length - 1]
  let first = samples[0]
  for (const s of samples) if (last.t - s.t <= 90) {
    first = s
    break
  }
  const dt = (last.t - first.t) / 1000
  return dt > 0 ? (last.x - first.x) / dt : 0
}

hit.addEventListener('pointerup', e => {
  if (!drag) return
  const d = drag
  drag = null
  hit.classList.remove('dragging')

  if (!d.moved) {
    // Tap: the disc on the left is next, the one on the right is previous.
    if (e.clientX < G.cx - G.r) skip(1)
    else if (e.clientX > G.cx + G.r) skip(-1)
    else togglePlay()
    if (Math.abs(wheel.value - cursor) > 1e-3) wheel.to(cursor, { damping: 1, response: 0.4 })
    return
  }

  const v = releaseVelocity(d.samples) // px/s
  const projected = wheel.value + projectMomentum(v) / SPACING
  const target = clamp(Math.round(projected), Math.max(0, cursor - 3), Math.min(timeline.length - 1, cursor + 3))
  const opts = { damping: 0.8, response: 0.5, velocity: v / SPACING }
  if (target !== cursor && state?.current) skip(target - cursor, opts)
  else {
    wheel.to(cursor, opts)
    dirty = true
  }
})
hit.addEventListener('pointercancel', () => {
  drag = null
  hit.classList.remove('dragging')
  wheel.to(cursor, { damping: 1, response: 0.4 })
})

// ---------------------------------------------------------------------------
// Buttons, keys, toast
// ---------------------------------------------------------------------------
$('#btn-prev').addEventListener('click', () => skip(-1, undefined, { button: true }))
$('#btn-next').addEventListener('click', () => skip(1))
$('#btn-play').addEventListener('click', togglePlay)
$('#btn-close').addEventListener('click', () => window.native.close())
$('#btn-min').addEventListener('click', () => window.native.minimize())
$('#btn-pin').addEventListener('click', () => setPref({ onTop: !prefs.onTop }, true))

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const menuEl = $('#menu')
const settingsBtn = $('#btn-settings')

function applyPrefs(s) {
  const wasFull = prefs.fullscreen
  Object.assign(prefs, s)
  document.body.classList.toggle('fullscreen', prefs.fullscreen)
  $('#btn-pin').setAttribute('aria-pressed', String(prefs.onTop))
  $('#opt-ontop').checked = prefs.onTop
  $('#opt-spin').checked = prefs.spin
  $('#opt-glow').checked = prefs.glow
  const active = prefs.fullscreen ? 'full' : prefs.size
  for (const b of menuEl.querySelectorAll('[data-size]')) b.setAttribute('aria-checked', String(b.dataset.size === active))
  if (wasFull !== prefs.fullscreen) resize()
  dirty = true
}

async function setPref(patch, announce = false) {
  applyPrefs(patch) // instant feedback; main confirms
  const s = await window.native.setSettings(patch)
  applyPrefs(s)
  if (announce && 'onTop' in patch) toast(s.onTop ? 'Keeping on top of other windows' : 'No longer on top')
}

function openMenu(open) {
  menuEl.classList.toggle('open', open)
  settingsBtn.setAttribute('aria-expanded', String(open))
  if (open) menuEl.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true })
}

settingsBtn.addEventListener('click', () => openMenu(!menuEl.classList.contains('open')))
document.addEventListener('pointerdown', e => {
  if (menuEl.classList.contains('open') && !menuEl.contains(e.target) && !settingsBtn.contains(e.target)) openMenu(false)
})
for (const b of menuEl.querySelectorAll('[data-size]')) {
  b.addEventListener('click', () => {
    const size = b.dataset.size
    setPref(size === 'full' ? { fullscreen: true } : { size, fullscreen: false })
  })
}
$('#opt-ontop').addEventListener('change', e => setPref({ onTop: e.target.checked }))
$('#opt-spin').addEventListener('change', e => setPref({ spin: e.target.checked }))
$('#opt-glow').addEventListener('change', e => setPref({ glow: e.target.checked }))

window.native.onSettings?.(applyPrefs)
window.native.getSettings?.().then(applyPrefs)

// Full screen: let the title bar and cursor fade out when the mouse rests.
let idleTimer = null
function wake() {
  document.body.classList.remove('idle-ui')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (prefs.fullscreen && !menuEl.classList.contains('open') && !drag && !scrubbing) document.body.classList.add('idle-ui')
  }, 2500)
}
window.addEventListener('pointermove', wake)
window.addEventListener('pointerdown', wake)

window.addEventListener('keydown', e => {
  wake()
  if (e.key === 'Escape') {
    if (menuEl.classList.contains('open')) openMenu(false)
    else if (prefs.fullscreen) setPref({ fullscreen: false })
    return
  }
  if (e.key === 'F11') {
    e.preventDefault()
    return setPref({ fullscreen: !prefs.fullscreen })
  }
  if (menuEl.contains(e.target)) return
  if (e.target === scrubEl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return
  if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault()
    togglePlay()
  } else if (e.key === 'ArrowRight') skip(1)
  else if (e.key === 'ArrowLeft') skip(-1, undefined, { button: true })
  else if (e.key === 'd' || e.key === 'D') useSource(source?.kind === 'demo' ? new WindowsMediaSource() : new DemoSource())
})

let toastTimer = null
function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600)
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function useSource(next) {
  source?.stop()
  source = next
  state = null
  holdRemoteUntil = 0
  holdClockUntil = 0
  timeline = next.kind === 'demo' ? [] : [IDLE]
  cursor = 0
  wheel.jump(0)
  if (next.kind !== 'demo') showTrack(0)
  updateSourceLabel()
  next.start(reconcile, () => toast("Couldn't reach the player"))
  dirty = true
}

useSource(inElectron ? new WindowsMediaSource() : new DemoSource())
requestAnimationFrame(frame)
