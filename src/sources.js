// Playback sources. Both emit the same state shape:
// { current: Track|null, queue: Track[], history?: Track[], isPlaying, progressMs, receivedAt, app }
// Track: { id, title, artist, durationMs, artKey, generated? }

const DEMO_TRACKS = [
  { title: 'Neon Tides', artist: 'Halcyon Drive', durationMs: 214000, hue: 330 },
  { title: 'Paper Satellites', artist: 'Mira Vale', durationMs: 187000, hue: 205 },
  { title: 'Slow Orbit', artist: 'The Quiet Hours', durationMs: 241000, hue: 265 },
  { title: 'Glasshouse', artist: 'Juno Park', durationMs: 199000, hue: 160 },
  { title: 'Afterglow FM', artist: 'Low Static', durationMs: 226000, hue: 25 },
  { title: 'Cinder Bloom', artist: 'Ovra', durationMs: 173000, hue: 0 },
  { title: 'Northbound', artist: 'Aster & Field', durationMs: 258000, hue: 190 },
  { title: 'Velvet Signal', artist: 'Kaito Rain', durationMs: 205000, hue: 290 }
].map((t, i) => ({ ...t, id: `demo-${i}`, artKey: `demo-${i}`, generated: true }))

class DemoSource {
  constructor() {
    this.kind = 'demo'
    this.knowsQueue = true
    this.index = 0
    this.progress = 47000
    this.playing = true
    this.startedAt = performance.now()
  }

  start(onState) {
    this.onState = onState
    this.emit(true)
    this.timer = setInterval(() => {
      if (this.progressNow() >= DEMO_TRACKS[this.index].durationMs) this.next()
    }, 500)
  }

  stop() {
    clearInterval(this.timer)
    this.onState = null
  }

  progressNow() {
    return this.playing ? this.progress + (performance.now() - this.startedAt) : this.progress
  }

  emit(withHistory = false) {
    const n = DEMO_TRACKS.length
    const at = k => DEMO_TRACKS[(((this.index + k) % n) + n) % n]
    this.onState?.({
      current: at(0),
      queue: [1, 2, 3, 4].map(at),
      history: withHistory ? [at(-3), at(-2), at(-1)] : undefined,
      isPlaying: this.playing,
      progressMs: this.progressNow(),
      receivedAt: performance.now(),
      app: 'Demo',
      canSeek: true,
      canNext: true,
      canPrev: true
    })
  }

  setProgress(ms) {
    this.progress = ms
    this.startedAt = performance.now()
  }

  next() {
    this.index = (this.index + 1) % DEMO_TRACKS.length
    this.setProgress(0)
    this.emit()
  }

  previous() {
    this.index = (this.index - 1 + DEMO_TRACKS.length) % DEMO_TRACKS.length
    this.setProgress(0)
    this.emit()
  }

  setPlaying(play) {
    this.setProgress(this.progressNow())
    this.playing = play
    this.emit()
  }

  seek(ms) {
    this.setProgress(ms)
    this.emit()
  }
}

function friendlyAppName(id = '') {
  if (/spotify/i.test(id)) return 'Spotify'
  const base = id.split('!').pop().replace(/\.exe$/i, '')
  return base.split('.').pop() || 'Media'
}

// Windows System Media Transport Controls, via main process bridge.
// No queue information is available here, so upcoming discs are unknown.
class WindowsMediaSource {
  constructor() {
    this.kind = 'windows'
    this.knowsQueue = false
    this.state = null
    this.listening = false
  }

  start(onState, onError) {
    this.onState = onState
    this.onError = onError
    if (!WindowsMediaSource.subscribed) {
      // ipc listeners can't be removed through the bridge, so register once and route.
      WindowsMediaSource.subscribed = true
      window.native.onMedia(msg => WindowsMediaSource.active?.handle(msg))
    }
    WindowsMediaSource.active = this
    window.native.snapshot().then(({ state, arts }) => {
      for (const [key, data] of Object.entries(arts || {})) provideArtData(key, data)
      if (state && !this.state) this.handle(state)
    })
  }

  stop() {
    if (WindowsMediaSource.active === this) WindowsMediaSource.active = null
    this.onState = null
  }

  handle(msg) {
    if (msg.type === 'art') return provideArtData(msg.key, msg.data)
    if (msg.type === 'error') return this.onError?.(msg.message)
    if (msg.type !== 'state') return

    const app = friendlyAppName(msg.app)
    const current =
      msg.active && msg.title
        ? {
            id: msg.key,
            artKey: msg.key,
            title: msg.title,
            artist: msg.artist || app,
            album: msg.album,
            durationMs: msg.durationMs || 0
          }
        : null

    this.state = {
      current,
      queue: [],
      isPlaying: Boolean(msg.playing),
      progressMs: msg.positionMs || 0,
      receivedAt: performance.now(),
      app: msg.active ? app : null,
      canSeek: Boolean(msg.canSeek),
      canNext: Boolean(msg.canNext),
      canPrev: Boolean(msg.canPrev)
    }
    this.onState?.(this.state)
  }

  next() {
    window.native.command('next')
  }

  previous() {
    window.native.command('prev')
  }

  setPlaying(play) {
    window.native.command(play ? 'play' : 'pause')
  }

  seek(ms) {
    window.native.command('seek', ms)
  }
}
