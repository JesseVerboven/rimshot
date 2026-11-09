// Rimshot: main process. Frameless glass window + a bridge to Windows' media
// controls (System Media Transport Controls), which Spotify desktop publishes to.
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')
const fs = require('node:fs')

const APP_NAME = 'Rimshot'
const APP_ID = 'com.rimshot.player'
app.setName(APP_NAME)
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME))

// ---------- settings ----------
const SIZES = {
  compact: { width: 480, height: 420 },
  wide: { width: 880, height: 440 }
}
const DEFAULTS = { size: 'compact', onTop: false, spin: true, glow: true, x: null, y: null }
let settings = { ...DEFAULTS }
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')

// The app was called "CD Wheel" before; pick up settings saved under that name.
const legacySettingsPath = () => path.join(app.getPath('appData'), 'cd-wheel-player', 'settings.json')

function loadSettings() {
  settings = { ...DEFAULTS }
  for (const file of [settingsPath(), legacySettingsPath()]) {
    try {
      settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
      if (file !== settingsPath()) saveSettings()
      break
    } catch {}
  }
  if (!SIZES[settings.size]) settings.size = 'compact'
}

let saveTimer = null
function saveSettings() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
    } catch (err) {
      console.error('Could not save settings', err)
    }
  }, 200)
}

function publicSettings() {
  return { size: settings.size, onTop: settings.onTop, spin: settings.spin, glow: settings.glow, fullscreen: isFull }
}

// Electron's full-screen events are unreliable for transparent, non-resizable
// windows on Windows, so track the state ourselves and restore bounds by hand.
let isFull = false
let restoreBounds = null
function setFull(on) {
  if (!win || on === isFull) return
  isFull = on
  if (on) {
    restoreBounds = win.getBounds()
    win.setFullScreen(true)
  } else {
    win.setFullScreen(false)
    const around = restoreBounds
    setTimeout(() => {
      if (!isFull && win) applySize(settings.size, around || win.getBounds())
    }, 60)
  }
  send('settings', publicSettings())
}

function applyOnTop() {
  // 'screen-saver' keeps us above other always-on-top windows too.
  win.setAlwaysOnTop(settings.onTop, 'screen-saver')
}

// Resize around the window's current centre, kept inside the work area.
function applySize(name, b = win.getBounds()) {
  const { width, height } = SIZES[name]
  const area = screen.getDisplayMatching(b).workArea
  const x = Math.round(Math.min(Math.max(b.x + b.width / 2 - width / 2, area.x), area.x + area.width - width))
  const y = Math.round(Math.min(Math.max(b.y + b.height / 2 - height / 2, area.y), area.y + area.height - height))
  win.setBounds({ x, y, width, height })
}

function initialBounds() {
  const { width, height } = SIZES[settings.size]
  if (settings.x === null || settings.y === null) return { width, height }
  const area = screen.getDisplayMatching({ x: settings.x, y: settings.y, width, height }).workArea
  const visible =
    settings.x + width > area.x + 40 && settings.x < area.x + area.width - 40 && settings.y >= area.y - 10 && settings.y < area.y + area.height - 40
  return visible ? { x: settings.x, y: settings.y, width, height } : { width, height }
}

let win = null
let bridge = null
let quitting = false
let lastState = null
const arts = new Map() // key -> data URL (small LRU)

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function startBridge() {
  // In the installed app the script is unpacked next to app.asar, since
  // PowerShell can't read files inside the archive.
  const script = path.join(__dirname, 'native', 'media-bridge.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  bridge = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true
  })

  readline.createInterface({ input: bridge.stdout }).on('line', line => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.type === 'art') {
      arts.set(msg.key, msg.data)
      if (arts.size > 24) arts.delete(arts.keys().next().value)
    } else if (msg.type === 'state') {
      lastState = msg
    }
    send('media', msg)
  })
  bridge.stderr.on('data', d => console.error('[media-bridge]', String(d).trim()))
  bridge.on('exit', () => {
    bridge = null
    if (!quitting) setTimeout(startBridge, 1500)
  })
}

const COMMANDS = new Set(['next', 'prev', 'play', 'pause', 'toggle'])
ipcMain.on('media:cmd', (_e, cmd, arg) => {
  if (!bridge) return
  if (COMMANDS.has(cmd)) bridge.stdin.write(cmd + '\n')
  else if (cmd === 'seek' && Number.isFinite(arg) && arg >= 0) bridge.stdin.write(`seek ${Math.round(arg)}\n`)
})
ipcMain.handle('media:snapshot', () => ({ state: lastState, arts: Object.fromEntries(arts) }))

ipcMain.on('win:close', () => win?.close())
ipcMain.on('win:minimize', () => win?.minimize())
ipcMain.handle('settings:get', () => publicSettings())
ipcMain.handle('settings:set', (_e, patch = {}) => {
  if (!win) return publicSettings()
  if (typeof patch.onTop === 'boolean') {
    settings.onTop = patch.onTop
    applyOnTop()
  }
  if (typeof patch.spin === 'boolean') settings.spin = patch.spin
  if (typeof patch.glow === 'boolean') settings.glow = patch.glow
  if (SIZES[patch.size]) {
    const changed = settings.size !== patch.size
    settings.size = patch.size
    if (isFull) setFull(false) // restores at the newly chosen size
    else if (changed) applySize(patch.size)
  }
  if (typeof patch.fullscreen === 'boolean') setFull(patch.fullscreen)
  saveSettings()
  return publicSettings()
})

function createWindow() {
  win = new BrowserWindow({
    ...initialBounds(),
    useContentSize: true,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: true,
    backgroundColor: '#00000000',
    show: false,
    title: 'Rimshot',
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.loadFile(path.join(__dirname, 'src', 'index.html'))
  if (process.platform === 'win32') {
    // The taskbar right-click menu and "Pin to taskbar" read these. Without
    // them Windows falls back to electron.exe's own name and icon.
    const devRun = process.defaultApp // launched as `electron .`
    win.setAppDetails({
      appId: APP_ID,
      // Installed: Rimshot.exe carries the icon. From source: use the .ico file.
      appIconPath: devRun ? path.join(__dirname, 'build', 'icon.ico') : process.execPath,
      appIconIndex: 0,
      relaunchCommand: devRun ? `"${process.execPath}" "${app.getAppPath()}"` : `"${process.execPath}"`,
      relaunchDisplayName: APP_NAME
    })
  }
  win.once('ready-to-show', () => {
    applyOnTop()
    win.show()
  })
  // If Windows itself takes us out of full screen, follow along.
  win.on('leave-full-screen', () => setFull(false))
  win.on('moved', () => {
    if (isFull) return
    const b = win.getBounds()
    settings.x = b.x
    settings.y = b.y
    saveSettings()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', e => e.preventDefault())
}

// Own taskbar identity, so Windows shows our icon instead of Electron's.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

app.whenReady().then(() => {
  loadSettings()
  startBridge()
  createWindow()
})

app.on('before-quit', () => {
  quitting = true
  bridge?.stdin.end()
  bridge?.kill()
})

app.on('window-all-closed', () => app.quit())
