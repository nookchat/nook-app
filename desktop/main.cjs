// Nook for the desktop. The window loads the web app from its home, so invite
// links point at the same place as on the web and the service worker works.
// The shell adds what a browser tab cannot: a picker for a screen or a window,
// the system sound on Windows, the game you are playing, the unread count on
// its icon, and updates of itself. It also lists your game recordings, to share one.

const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  session,
  shell,
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { watchGames } = require('./games.cjs')
const { editMenu } = require('./edit-menu.cjs')
const { pickerBounds, restoreBounds, screenOf } = require('./placement.cjs')
const { watchUpdates } = require('./updates.cjs')
const recordings = require('./recordings.cjs')

app.setName('Nook')

// Windows shows a notification only for an app whose id matches its Start menu shortcut, and the
// installer names that shortcut with the appId in package.json. Without this, every one is dropped.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'app.nook.desktop' : process.execPath)

// The page plays a recording from a nook-rec:// link. The scheme needs its rights before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'nook-rec',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true },
  },
])

const HOME = process.env.NOOK_URL || 'https://cathode.video/'
const ALLOWED = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])

let main = null

/** The page colour of the Nook brand (surface-0), shown before the page paints. */
const pageColour = () => (nativeTheme.shouldUseDarkColors ? '#0D0D0F' : '#FBF7EF')
/** A link the OS gave before the window was there. */
let pendingLink = null

/** The site, with or without www, since the host sends one to the other. */
function siteKey(url) {
  const u = new URL(url)
  return `${u.protocol}//${u.host.replace(/^www\./, '')}`
}

const HOME_KEY = siteKey(HOME)

function isHome(url) {
  try {
    return siteKey(url) === HOME_KEY
  } catch {
    return false
  }
}

/** Turns a nook:// link into the same link on the home site. */
function fromScheme(url) {
  if (typeof url !== 'string' || !url.toLowerCase().startsWith('nook://')) return null
  const hash = url.indexOf('#')
  return hash === -1 ? HOME : `${HOME.split('#')[0]}${url.slice(hash)}`
}

/** A link the window should open: a home site link, or a nook:// one. */
function appLink(url) {
  if (isHome(url)) return url
  return fromScheme(url)
}

function openOutside(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url)
}

/** Opens an invite link, from the command line or from the OS, in the window. */
function openLink(url) {
  const link = appLink(url)
  if (!main || !link) return
  main.loadURL(link)
  if (main.isMinimized()) main.restore()
  main.focus()
}

const MIN_SIZE = { width: 380, height: 500 }
/** Where the window was when it last closed: its place, its screen, and whether it filled it. */
const PLACE_FILE = () => path.join(app.getPath('userData'), 'window.json')
const PLACE_SAVE_MS = 600

function readPlace() {
  try {
    return JSON.parse(fs.readFileSync(PLACE_FILE(), 'utf8'))
  } catch {
    return null
  }
}

function writePlace(place) {
  try {
    fs.writeFileSync(PLACE_FILE(), JSON.stringify(place))
  } catch {
    /* no place to keep it: the next start picks, as on a first start */
  }
}

/**
 * Keeps the window's place as it moves, so a quit of any kind finds it. The place is the
 * size it has when not maximized or full screen; the screen is the one it is on now.
 */
function rememberPlace(win, saved) {
  let normal = saved?.bounds ?? win.getBounds()
  let timer = null
  const now = () => {
    if (win.isDestroyed()) return null
    const plain = !win.isMaximized() && !win.isFullScreen() && !win.isMinimized()
    if (plain) normal = win.getBounds()
    const on = screen.getDisplayMatching(win.getBounds())
    // Maximized on another screen than its plain place: that screen is where it opens next.
    const bounds = screenOf(normal, [on]) ? normal : { ...normal, x: on.workArea.x, y: on.workArea.y }
    return { bounds, displayId: on.id, maximized: win.isMaximized() }
  }
  const save = () => {
    const place = now()
    if (place) writePlace(place)
  }
  const soon = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, PLACE_SAVE_MS)
  }
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'leave-full-screen']) win.on(ev, soon)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    save()
  })
}

function createWindow() {
  const saved = readPlace()
  const place = restoreBounds(saved, screen.getAllDisplays(), MIN_SIZE)
  main = new BrowserWindow({
    width: 1280,
    height: 800,
    ...(place ?? {}),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    backgroundColor: pageColour(),
    title: 'Nook',
    autoHideMenuBar: true,
    // The page draws its own title bar. macOS keeps its three buttons over it.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 10 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // A call joined again after a web update's reload has had no click, and must still be heard.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  // A Nook link, such as an invite in a chat, opens here. Anything else opens outside.
  main.webContents.setWindowOpenHandler(({ url }) => {
    if (isHome(url)) main.loadURL(url)
    else openOutside(url)
    return { action: 'deny' }
  })
  // A right click in a text box, on a selection, a link or a picture gets the menu a browser
  // gives, with spelling. The page's own menus cancel the right click, so they never come here.
  main.webContents.on('context-menu', (_ev, params) => {
    const win = main
    if (!win) return
    const wc = win.webContents
    const items = editMenu(params, {
      replace: (word) => wc.replaceMisspelling(word),
      learn: (word) => wc.session.addWordToSpellCheckerDictionary(word),
      open: (url) => (isHome(url) ? win.loadURL(url) : openOutside(url)),
      copyText: (text) => clipboard.writeText(text),
      copyImage: (x, y) => wc.copyImageAt(x, y),
    })
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })
  main.webContents.on('will-navigate', (ev, url) => {
    if (isHome(url)) return
    ev.preventDefault()
    openOutside(url)
  })
  if (place && saved.maximized) main.maximize()
  rememberPlace(main, place ? { ...saved, bounds: place } : null)
  main.on('closed', () => {
    main = null
  })
  // The page holds the window open during a call. A restart into an update it asked for goes anyway.
  main.webContents.on('will-prevent-unload', (ev) => {
    if (installing) ev.preventDefault()
  })
  const tell = (channel, value) => main && main.webContents.send(channel, value)
  main.on('maximize', () => tell('window:maximized', true))
  main.on('unmaximize', () => tell('window:maximized', false))
  main.on('enter-full-screen', () => tell('window:fullscreen', true))
  main.on('leave-full-screen', () => tell('window:fullscreen', false))
  main.webContents.on('did-finish-load', () => {
    tell('window:maximized', main.isMaximized())
    tell('window:fullscreen', main.isFullScreen())
  })

  const start = pendingLink || process.argv.map(appLink).find(Boolean)
  pendingLink = null
  main.loadURL(start || HOME)
}

/** The clear space round the picker for its shadow, the same as the margin in picker.html. */
const PICKER_MARGIN = 24

/** Shows the picker window and resolves with the chosen source, or null. */
async function pickSource(parent) {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    // Twice the size a card shows them at, so they are sharp on a high density screen.
    thumbnailSize: { width: 640, height: 360 },
    fetchWindowIcons: true,
  })
  if (sources.length === 0) return null
  if (sources.length === 1) return { source: sources[0], audio: false }

  const size = { width: 880 + PICKER_MARGIN * 2, height: 640 + PICKER_MARGIN * 2 }
  // Over the main window, on its screen: with Nook on a second screen, the picker is there too.
  const at = parent && !parent.isDestroyed() ? pickerBounds(parent.getBounds(), screen.getAllDisplays(), size.width, size.height) : null
  const picker = new BrowserWindow({
    parent,
    modal: true,
    // The page draws the window: rounded like a Nook dialog, with its own shadow in a clear margin.
    ...size,
    ...(at ?? {}),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Share your screen',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'picker-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })

  const list = sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumb: s.thumbnail.toDataURL(),
    icon: s.appIcon ? s.appIcon.toDataURL() : null,
  }))

  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      ipcMain.removeHandler('picker:list')
      ipcMain.removeAllListeners('picker:choose')
      if (!picker.isDestroyed()) picker.close()
      resolve(value)
    }
    ipcMain.handle('picker:list', () => ({ sources: list, canShareAudio: process.platform === 'win32' }))
    ipcMain.on('picker:choose', (_ev, choice) => {
      const source = choice && sources.find((s) => s.id === choice.id)
      finish(source ? { source, audio: !!choice.audio } : null)
    })
    picker.on('closed', () => finish(null))
    picker.once('ready-to-show', () => picker.show())
    picker.loadFile(path.join(__dirname, 'picker.html'))
  })
}

// The page asks for the game while you let it show what you are playing.
let games = null

function tellGame(now) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (isHome(win.webContents.getURL())) win.webContents.send('games:playing', now)
  }
}

ipcMain.on('games:watch', (ev, on) => {
  if (!isHome(ev.sender.getURL())) return
  if (on && !games) games = watchGames(tellGame)
  else if (on) ev.sender.send('games:playing', games.now())
  else if (games) {
    games.stop()
    games = null
  }
})

// A newer desktop app: the page offers it, and says when to restart into it.
let updates = null
let installing = false

function tellUpdate(offer) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (isHome(win.webContents.getURL())) win.webContents.send('update:offer', offer)
  }
}

ipcMain.handle('update:now', (ev) => (isHome(ev.sender.getURL()) ? (updates?.now() ?? null) : null))
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('update:check', (ev) => (isHome(ev.sender.getURL()) && updates ? updates.check() : { state: 'failed' }))
ipcMain.on('update:install', (ev) => {
  if (!isHome(ev.sender.getURL()) || !updates) return
  if (updates.now()?.ready) installing = true
  updates.install()
})

// The unread count: a number on the Dock on macOS, and on Linux where the launcher
// shows one; a small red circle over the taskbar button on Windows.
ipcMain.on('badge:set', (ev, count, overlay) => {
  if (!isHome(ev.sender.getURL())) return
  const n = Number.isInteger(count) && count > 0 ? Math.min(count, 9999) : 0
  if (process.platform === 'win32') {
    const win = BrowserWindow.fromWebContents(ev.sender)
    if (!win) return
    const ok = n > 0 && typeof overlay === 'string' && overlay.startsWith('data:image/png;base64,') && overlay.length < 20_000
    win.setOverlayIcon(ok ? nativeImage.createFromDataURL(overlay) : null, ok ? `${n} unread` : '')
    return
  }
  app.setBadgeCount(n)
})

// Your game recordings: the folders to look in, what is in them, and where each part of a Steam one is.
/** Where the folders list is kept, and the system's own videos folder. */
function recordingPlaces() {
  let videos = null
  try {
    videos = app.getPath('videos')
  } catch {
    /* this system has no videos folder */
  }
  return { file: path.join(app.getPath('userData'), 'recordings.json'), videos }
}

ipcMain.handle('recordings:folders', (ev) => (isHome(ev.sender.getURL()) ? recordings.folders(recordingPlaces()) : []))
ipcMain.handle('recordings:add', async (ev) => {
  if (!isHome(ev.sender.getURL())) return null
  const win = BrowserWindow.fromWebContents(ev.sender)
  const options = { properties: ['openDirectory'] }
  const picked = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
  if (picked.canceled || !picked.filePaths[0]) return null
  return recordings.addFolder(recordingPlaces(), picked.filePaths[0])
})
ipcMain.handle('recordings:remove', (ev, folder) =>
  isHome(ev.sender.getURL()) && typeof folder === 'string' ? recordings.removeFolder(recordingPlaces(), folder) : [],
)
ipcMain.handle('recordings:restore', (ev) => (isHome(ev.sender.getURL()) ? recordings.restoreFolders(recordingPlaces()) : []))
ipcMain.handle('recordings:list', (ev) => (isHome(ev.sender.getURL()) ? recordings.list(recordingPlaces()) : []))
ipcMain.handle('recordings:index', (ev, id) => (isHome(ev.sender.getURL()) && typeof id === 'string' ? recordings.index(id) : null))
ipcMain.on('recordings:show', (ev, id) => {
  if (!isHome(ev.sender.getURL()) || typeof id !== 'string') return
  const where = recordings.place(id)
  if (where) shell.showItemInFolder(where)
})

ipcMain.on('window:control', (ev, action) => {
  const win = BrowserWindow.fromWebContents(ev.sender)
  if (!win) return
  if (action === 'minimize') win.minimize()
  if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
  if (action === 'close') win.close()
})

function setUpSession() {
  const ses = session.defaultSession

  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(isHome(wc.getURL()) && ALLOWED.has(permission))
  })
  ses.setPermissionCheckHandler((wc, permission) => !!wc && isHome(wc.getURL()) && ALLOWED.has(permission))

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const picked = await pickSource(main)
      if (!picked) return callback({})
      const wantAudio = request.audioRequested && picked.audio && process.platform === 'win32'
      callback(wantAudio ? { video: picked.source, audio: 'loopback' } : { video: picked.source })
    } catch {
      callback({})
    }
  })

  // Only a page from home can read a recording with fetch. A video element plays it without that.
  protocol.handle('nook-rec', (request) => recordings.respond(request, { isHome }))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAsDefaultProtocolClient('nook')

  // macOS hands a nook:// link to the running app with this event.
  app.on('open-url', (ev, url) => {
    ev.preventDefault()
    if (main) openLink(url)
    else pendingLink = fromScheme(url)
  })

  app.on('second-instance', (_ev, argv) => {
    const link = argv.find((a) => appLink(a))
    if (link) openLink(link)
    else if (main) {
      if (main.isMinimized()) main.restore()
      main.focus()
    }
  })

  app.whenReady().then(() => {
    setUpSession()
    createWindow()
    updates = watchUpdates(tellUpdate)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // A quit from outside, as a shutdown sends, is a quit like any other: an update goes in on it.
  process.on('SIGTERM', () => app.quit())

  app.on('window-all-closed', () => {
    games?.stop()
    games = null
    if (process.platform !== 'darwin') app.quit()
  })
}
