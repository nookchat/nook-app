// Nook for the desktop. The window loads the web app from its home, so invite
// links point at the same place as on the web and the service worker works.
// The shell adds what a browser tab cannot: a picker for a screen or a window,
// and the system sound on Windows.

const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } = require('electron')
const path = require('node:path')

app.setName('Nook')

const HOME = process.env.NOOK_URL || 'https://cathode.video/'
const ALLOWED = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])

let main = null
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

function createWindow() {
  main = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 380,
    minHeight: 500,
    backgroundColor: '#0a0b0e',
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
    },
  })

  // A Nook link, such as an invite in a chat, opens here. Anything else opens outside.
  main.webContents.setWindowOpenHandler(({ url }) => {
    if (isHome(url)) main.loadURL(url)
    else openOutside(url)
    return { action: 'deny' }
  })
  main.webContents.on('will-navigate', (ev, url) => {
    if (isHome(url)) return
    ev.preventDefault()
    openOutside(url)
  })
  main.on('closed', () => {
    main = null
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

/** Shows the picker window and resolves with the chosen source, or null. */
async function pickSource(parent) {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  })
  if (sources.length === 0) return null
  if (sources.length === 1) return { source: sources[0], audio: false }

  const picker = new BrowserWindow({
    parent,
    modal: true,
    width: 760,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#131519',
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
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
