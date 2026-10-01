// Nook for the desktop. The window loads the web app from its home, so invite
// links point at the same place as on the web and the service worker works.
// The shell adds what a browser tab cannot: a picker for a screen or a window,
// the system sound on Windows, the game you are playing, the unread count on
// its icon, and updates of itself. It also lists your game recordings, to share one,
// and gets the sound of a YouTube video for the soundboard.

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
  Notification,
  protocol,
  screen,
  session,
  shell,
  Tray,
  WebContentsView,
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { watchGames } = require('./games.cjs')
const { watchSpotify } = require('./spotify.cjs')
const { editMenu } = require('./edit-menu.cjs')
const { trayMenuItems, trayTooltip, withDot } = require('./tray.cjs')
const { pickerBounds, restoreBounds, screenOf } = require('./placement.cjs')
const { watchUpdates } = require('./updates.cjs')
const recordings = require('./recordings.cjs')
const { youtubeAudio } = require('./youtube.cjs')

app.setName('Nook')
// Chromium keeps a key in the macOS Keychain to seal its cookies. The app is signed ad hoc, so
// every update looks like a new app to the Keychain, and it asks for your password again. Nook
// keeps nothing in cookies, so Chromium's own stand-in key does, and the Keychain is never asked.
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain')

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

/** Where the theme the page picked is kept: "light", "dark", or "" to follow the device. */
const THEME_FILE = () => path.join(app.getPath('userData'), 'theme.txt')
let theme = null

function savedTheme() {
  if (theme === null) {
    try {
      theme = fs.readFileSync(THEME_FILE(), 'utf8').trim()
    } catch {
      theme = ''
    }
    if (theme !== 'light' && theme !== 'dark') theme = ''
  }
  return theme
}

/** The page colour of the Nook brand (surface-0), shown before the page paints. */
const pageColour = () => {
  const picked = savedTheme()
  return (picked ? picked === 'dark' : nativeTheme.shouldUseDarkColors) ? '#100C0B' : '#FDF6F3'
}
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
  bringBack()
}

/** True while you look at the window: shown, not minimized, and in front. */
function lookingAt(win) {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()
}

ipcMain.on('window:looking', (ev) => {
  ev.returnValue = lookingAt(BrowserWindow.fromWebContents(ev.sender))
})

/** Shows the window again, from the tray, the Dock, or a second start. */
function bringBack() {
  if (!main) return createWindow()
  if (main.isMinimized()) main.restore()
  main.show()
  main.focus()
}

/**
 * Close puts the window away to the tray, as Discord does: a call and the messages keep going.
 * Quit, from the tray or the app menu, ends it. The choice is kept in a file, on by default.
 */
const TRAY_FILE = () => path.join(app.getPath('userData'), 'close-to-tray.txt')
let closeToTray = null
/** True once the app is on its way out: then a close is a close. */
let quitting = false
let tray = null

function keepsInTray() {
  if (closeToTray === null) {
    try {
      closeToTray = fs.readFileSync(TRAY_FILE(), 'utf8').trim() !== 'off'
    } catch {
      closeToTray = true
    }
  }
  return closeToTray
}

/** How many mentions and direct messages wait for you, as the page last said. */
let trayUnread = 0

function makeTray() {
  if (tray) return
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')))
  paintTray()
  // A click on the icon opens the window on Windows and Linux. On macOS a click opens the menu.
  if (process.platform !== 'darwin') tray.on('click', bringBack)
}

/** The tray's icon, with a red dot when something waits, at each size the icon comes in. */
function trayPicture() {
  const plain = nativeImage.createFromPath(path.join(__dirname, 'tray.png'))
  if (!(trayUnread > 0)) return plain
  const dotted = nativeImage.createEmpty()
  for (const scaleFactor of plain.getScaleFactors()) {
    const pixels = plain.toBitmap({ scaleFactor })
    const size = Math.round(Math.sqrt(pixels.length / 4))
    if (!size || size * size * 4 !== pixels.length) continue
    const png = nativeImage.createFromBitmap(withDot(pixels, size), { width: size, height: size }).toPNG()
    dotted.addRepresentation({ scaleFactor, buffer: png })
  }
  return dotted.isEmpty() ? plain : dotted
}

function paintTray() {
  if (!tray) return
  tray.setImage(trayPicture())
  tray.setToolTip(trayTooltip(trayUnread))
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuItems(trayUnread, { open: bringBack, quit: () => app.quit() })))
}

// A notification from the page, shown here, so it shows with the window put away in the tray. A
// notification the page makes itself goes through its window, which is hidden then. Kept in a set
// while it shows: one that is collected stops answering a click.
const showing = new Set()

ipcMain.on('notify:show', (ev, note) => {
  if (!isHome(ev.sender.getURL()) || !Notification.isSupported() || !note || typeof note !== 'object') return
  const options = { title: String(note.title || 'Nook').slice(0, 200), body: String(note.body || '').slice(0, 200), silent: false }
  if (typeof note.picture === 'string' && /^data:image\/(png|jpeg);base64,/.test(note.picture) && note.picture.length < 400000) {
    const picture = nativeImage.createFromDataURL(note.picture)
    if (!picture.isEmpty()) options.icon = picture
  }
  const shown = new Notification(options)
  showing.add(shown)
  const sender = ev.sender
  shown.on('click', () => {
    bringBack()
    if (!sender.isDestroyed()) sender.send('notify:click', String(note.id || ''))
  })
  const done = () => showing.delete(shown)
  shown.on('close', done)
  shown.on('failed', done)
  shown.show()
})

ipcMain.on('tray:get', (ev) => {
  ev.returnValue = keepsInTray()
})
ipcMain.on('tray:set', (ev, on) => {
  if (!isHome(ev.sender.getURL())) return
  closeToTray = !!on
  try {
    fs.writeFileSync(TRAY_FILE(), closeToTray ? 'on' : 'off')
  } catch {
    /* no place to keep it: the next start closes to the tray */
  }
})

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

/** However the page's start goes, the splash is gone by then. */
const SPLASH_MOST_MS = 20_000
/** Takes the splash away. Null when there is none. */
let hideSplash = null

/**
 * Shows desktop/splash.html over the window at once: the page's loading screen, which comes
 * from the network and needs a few seconds on a cold start. It goes when the page says it has
 * painted its own (boot:shown), when the page has loaded or failed, or after SPLASH_MOST_MS.
 */
function showSplash(win) {
  const view = new WebContentsView()
  view.setBackgroundColor(pageColour())
  const fit = () => {
    if (win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  const SIZE_EVENTS = ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']
  fit()
  for (const ev of SIZE_EVENTS) win.on(ev, fit)
  win.contentView.addChildView(view)
  const picked = savedTheme()
  view.webContents.loadFile(path.join(__dirname, 'splash.html'), picked ? { query: { theme: picked } } : undefined)

  const failed = (_ev, code, _desc, _url, mainFrame) => {
    // -3 is a load stopped by another, such as an invite link opened at the start.
    if (mainFrame && code !== -3) hide()
  }
  const hide = () => {
    if (hideSplash !== hide) return
    hideSplash = null
    clearTimeout(timer)
    if (!win.isDestroyed()) {
      for (const ev of SIZE_EVENTS) win.removeListener(ev, fit)
      win.webContents.removeListener('did-finish-load', hide)
      win.webContents.removeListener('did-fail-load', failed)
      win.contentView.removeChildView(view)
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
  const timer = setTimeout(hide, SPLASH_MOST_MS)
  win.webContents.on('did-finish-load', hide)
  win.webContents.on('did-fail-load', failed)
  win.once('closed', hide)
  hideSplash = hide
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
  main.on('close', (ev) => {
    if (quitting || installing || !keepsInTray()) return
    ev.preventDefault()
    // Full screen on macOS hides into a blank space: out of full screen first.
    if (main.isFullScreen()) {
      main.once('leave-full-screen', () => main?.hide())
      main.setFullScreen(false)
    } else main.hide()
  })
  main.on('closed', () => {
    main = null
  })
  // The page holds the window open during a call. A restart into an update it asked for goes anyway.
  main.webContents.on('will-prevent-unload', (ev) => {
    if (installing) ev.preventDefault()
  })
  // A page that loads again was not restarted: the update did not go in, and a call holds the window again.
  main.webContents.on('did-navigate', () => {
    installing = false
  })
  const tell = (channel, value) => main && main.webContents.send(channel, value)
  main.on('maximize', () => tell('window:maximized', true))
  main.on('unmaximize', () => tell('window:maximized', false))
  main.on('enter-full-screen', () => tell('window:fullscreen', true))
  main.on('leave-full-screen', () => tell('window:fullscreen', false))
  // Whether you look at the window: shown, not minimized, and in front. The page cannot tell on
  // its own: with background throttling off, a window put away in the tray still reads as visible.
  const looking = () => tell('window:looking', lookingAt(main))
  for (const name of ['show', 'hide', 'focus', 'blur', 'minimize', 'restore']) main.on(name, looking)
  main.webContents.on('did-finish-load', () => {
    tell('window:maximized', main.isMaximized())
    tell('window:fullscreen', main.isFullScreen())
    looking()
  })

  showSplash(main)
  const start = pendingLink || process.argv.map(appLink).find(Boolean)
  pendingLink = null
  main.loadURL(start || HOME)
}

/** The clear space round the picker for its shadow, the same as the margin in picker.html. */
const PICKER_MARGIN = 24

/** A screen or a window as the picker shows it. */
const asItem = (s) => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen:') ? 'screen' : 'window' })

/** The theme the page has picked ("light" or "dark"), or "" to follow the device. */
async function themeOf(win) {
  if (!win || win.isDestroyed()) return ''
  const asked = win.webContents.executeJavaScript('document.documentElement.dataset.theme || ""', true).catch(() => '')
  const theme = await Promise.race([asked, new Promise((ok) => setTimeout(() => ok(''), 150))])
  return theme === 'light' || theme === 'dark' ? theme : ''
}

/**
 * Shows the picker window and resolves with the chosen source, or null. The window opens at once:
 * the names come first, as a list with no pictures is quick to get, and the pictures follow.
 */
async function pickSource(parent) {
  const names = desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
  const theme = await themeOf(parent)

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

  return new Promise((resolve) => {
    let done = false
    let sources = []
    const finish = (value) => {
      if (done) return
      done = true
      ipcMain.removeHandler('picker:list')
      ipcMain.removeAllListeners('picker:choose')
      if (!picker.isDestroyed()) picker.close()
      resolve(value)
    }
    const send = (channel, value) => !done && !picker.isDestroyed() && picker.webContents.send(channel, value)

    const listed = names.then((found) => {
      sources = found
      // Nothing to pick from, or only one thing: no picker.
      if (found.length === 0) finish(null)
      else if (found.length === 1) finish({ source: found[0], audio: false })
      return found.map(asItem)
    })
    listed.catch(() => finish(null))

    // The pictures: twice the size a card shows them at, so they are sharp on a high density screen.
    listed
      .then(() => {
        if (done) return
        return desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 640, height: 360 }, fetchWindowIcons: true })
      })
      .then((found) => {
        if (!found) return
        send(
          'picker:pictures',
          found.map((s) => ({ id: s.id, thumb: s.thumbnail.toDataURL(), icon: s.appIcon ? s.appIcon.toDataURL() : null })),
        )
      })
      .catch(() => {})

    ipcMain.handle('picker:list', () => listed.then((list) => ({ sources: list, canShareAudio: process.platform === 'win32' })))
    ipcMain.on('picker:choose', (_ev, choice) => {
      const source = choice && sources.find((s) => s.id === choice.id)
      finish(source ? { source, audio: !!choice.audio } : null)
    })
    picker.on('closed', () => finish(null))
    picker.once('ready-to-show', () => !done && picker.show())
    picker.loadFile(path.join(__dirname, 'picker.html'), theme ? { query: { theme } } : undefined)
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

// The page asks for the song while you let it show what you listen to.
let spotify = null

function tellSong(now) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (isHome(win.webContents.getURL())) win.webContents.send('spotify:listening', now)
  }
}

ipcMain.on('spotify:watch', (ev, on) => {
  if (!isHome(ev.sender.getURL())) return
  if (on && !spotify) spotify = watchSpotify(tellSong)
  else if (on) ev.sender.send('spotify:listening', spotify.now())
  else if (spotify) {
    spotify.stop()
    spotify = null
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
// shows one; a small red circle over the taskbar button on Windows; and on the tray's icon.
ipcMain.on('badge:set', (ev, count, overlay) => {
  if (!isHome(ev.sender.getURL())) return
  const n = Number.isInteger(count) && count > 0 ? Math.min(count, 9999) : 0
  const ok = n > 0 && typeof overlay === 'string' && overlay.startsWith('data:image/png;base64,') && overlay.length < 20_000
  // The tray's icon has a dot for the same count, on every system, while the window is put away.
  trayUnread = n
  paintTray()
  if (process.platform === 'win32') {
    const win = BrowserWindow.fromWebContents(ev.sender)
    if (!win) return
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
// A picture of a plain video, from the system's own thumbnails (Explorer's, Finder's), which are
// quick for a file of gigabytes where the page would have to read the video to draw one.
ipcMain.handle('recordings:thumb', async (ev, id) => {
  if (!isHome(ev.sender.getURL()) || typeof id !== 'string') return null
  const file = recordings.plainFile(id)
  if (!file || typeof nativeImage.createThumbnailFromPath !== 'function') return null
  try {
    const picture = await nativeImage.createThumbnailFromPath(file, { width: 480, height: 270 })
    return picture.isEmpty() ? null : new Uint8Array(picture.toJPEG(78))
  } catch {
    return null
  }
})
ipcMain.on('recordings:show', (ev, id) => {
  if (!isHome(ev.sender.getURL()) || typeof id !== 'string') return
  const where = recordings.place(id)
  if (where) shell.showItemInFolder(where)
})

// The sound of a YouTube video, for the soundboard: { title, bytes, type } or { error }.
ipcMain.handle('youtube:audio', (ev, url) =>
  isHome(ev.sender.getURL()) && typeof url === 'string'
    ? youtubeAudio(path.join(app.getPath('userData'), 'yt-dlp'), url)
    : { error: 'Not from Nook.' },
)

// The page has painted its loading screen: the splash over it goes.
ipcMain.on('boot:shown', (ev) => {
  if (main && ev.sender === main.webContents) hideSplash?.()
})

// The theme the page picked, for the splash and the window colour on the next start.
ipcMain.on('theme:is', (ev, picked) => {
  if (!isHome(ev.sender.getURL())) return
  const next = picked === 'light' || picked === 'dark' ? picked : ''
  if (next === savedTheme()) return
  theme = next
  try {
    fs.writeFileSync(THEME_FILE(), next)
  } catch {
    /* no place to keep it: the next start follows the device */
  }
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

  // The frame that asks must be home's own top frame, not only the page it sits in: a frame put
  // in the page from somewhere else gets no microphone, camera or screen.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const asker = details?.requestingUrl ?? wc.getURL()
    callback(isHome(wc.getURL()) && isHome(asker) && details?.isMainFrame !== false && ALLOWED.has(permission))
  })
  ses.setPermissionCheckHandler(
    (wc, permission, origin, details) =>
      !!wc && isHome(wc.getURL()) && isHome(origin || wc.getURL()) && details?.isMainFrame !== false && ALLOWED.has(permission),
  )

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isHome(request.securityOrigin ?? '') || (request.frame && request.frame.parent)) return callback({})
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
    else bringBack()
  })

  app.whenReady().then(() => {
    setUpSession()
    createWindow()
    makeTray()
    updates = watchUpdates(tellUpdate)
    // The Dock icon brings back a window put away to the tray.
    app.on('activate', () => {
      if (main) bringBack()
      else if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
  })

  // A quit from outside, as a shutdown sends, is a quit like any other: an update goes in on it.
  process.on('SIGTERM', () => app.quit())

  app.on('window-all-closed', () => {
    games?.stop()
    games = null
    spotify?.stop()
    spotify = null
    if (process.platform !== 'darwin') app.quit()
  })
}
