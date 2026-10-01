// Tells the web app it runs in the desktop shell, what game is running, what
// song Spotify plays, and when a newer desktop app is out. The page gives it the
// unread count for the icon.
// It lets the page list your game recordings and play them from nook-rec:// links,
// and get the sound of a YouTube video for the soundboard.
// It also draws the title bar in place of the system one: a strip to drag the
// window by, in the page colour, with the Nook icon on the left, the window's
// title in the middle with the space's icon before it, as Discord does, and on
// Windows and Linux the window buttons on the right. On macOS the system keeps
// its own three buttons, over the left end of the bar. The page puts the
// space's icon in #nook-title-face.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nookDesktop', {
  platform: process.platform,
  /** The shell showed desktop/splash.html while the page came: the page's loading screen does not come in again. */
  splash: true,
  /** On: the shell looks for a running game and tells `onPlaying`. Off: it stops looking. */
  watchGames: (on) => ipcRenderer.send('games:watch', !!on),
  /** Called with { name, steam?, since } or null. Returns a function that stops it. */
  onPlaying: (fn) => {
    const heard = (_ev, now) =>
      fn(now && typeof now.name === 'string' ? { name: now.name, steam: now.steam, since: now.since } : null)
    ipcRenderer.on('games:playing', heard)
    return () => ipcRenderer.removeListener('games:playing', heard)
  },
  /** On: the shell asks Spotify on this computer what it plays, and tells `onListening`. Off: it stops. */
  watchSpotify: (on) => ipcRenderer.send('spotify:watch', !!on),
  /** Called with { title, artist, album?, track?, art?, duration?, position?, at } or null. Returns a function that stops it. */
  onListening: (fn) => {
    const heard = (_ev, now) => fn(now && typeof now === 'object' && typeof now.title === 'string' ? { ...now } : null)
    ipcRenderer.on('spotify:listening', heard)
    return () => ipcRenderer.removeListener('spotify:listening', heard)
  },
  /** This desktop app's version. */
  version: () => ipcRenderer.invoke('app:version'),
  /** Called with { version, ready } when a newer desktop app is out, now or later. Returns a function that stops it. */
  onUpdate: (fn) => {
    const clean = (offer) =>
      offer && typeof offer.version === 'string' ? { version: offer.version, ready: offer.ready === true } : null
    const heard = (_ev, offer) => {
      const next = clean(offer)
      if (next) fn(next)
    }
    ipcRenderer.on('update:offer', heard)
    void ipcRenderer.invoke('update:now').then((offer) => heard(null, offer))
    return () => ipcRenderer.removeListener('update:offer', heard)
  },
  /** Looks for a newer desktop app now: { state: newest | available | downloading | ready | failed | dev, version? }. */
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  /** Restarts into the update when it has downloaded, or opens the download page. */
  installUpdate: () => ipcRenderer.send('update:install'),
  /** Whether close puts the window away to the tray, and a change to it. */
  closesToTray: () => ipcRenderer.sendSync('tray:get') === true,
  setCloseToTray: (on) => ipcRenderer.send('tray:set', !!on),
  /** Whether you look at the window now: shown, not minimized, and in front. */
  looking: () => ipcRenderer.sendSync('window:looking') === true,
  /** Called with true or false as that changes. Returns a function that stops it. */
  onLooking: (fn) => {
    const heard = (_ev, now) => fn(now === true)
    ipcRenderer.on('window:looking', heard)
    return () => ipcRenderer.removeListener('window:looking', heard)
  },
  /** The unread count on the Dock or taskbar icon. `overlay` is a PNG data URL, for Windows. */
  setBadge: (count, overlay) => ipcRenderer.send('badge:set', Number(count) || 0, typeof overlay === 'string' ? overlay : ''),
  /** The sound of a YouTube video, for the soundboard: { title, bytes, type } or { error }. */
  youtubeAudio: (url) => ipcRenderer.invoke('youtube:audio', String(url)),
  /** Your game recordings, from Steam, NVIDIA and your videos folder, and the folders the list looks in. */
  recordings: {
    /** The folders: [{ path, label, kind: steam | nvidia | videos | folder, found, exists }]. */
    folders: () => ipcRenderer.invoke('recordings:folders'),
    /** Asks for a folder to add. The folders, or null when you cancel. */
    addFolder: () => ipcRenderer.invoke('recordings:add'),
    /** A folder you added goes; a found one is hidden. The folders. */
    removeFolder: (path) => ipcRenderer.invoke('recordings:remove', String(path)),
    /** Shows the found folders you hid again. The folders. */
    restoreFolders: () => ipcRenderer.invoke('recordings:restore'),
    /** Every recording, newest first, each with a nook-rec:// url to play it from. */
    list: () => ipcRenderer.invoke('recordings:list'),
    /** Where each fragment of a Steam recording is in its file, or null. */
    index: (id) => ipcRenderer.invoke('recordings:index', String(id)),
    /** Shows the recording in the file manager. */
    show: (id) => ipcRenderer.send('recordings:show', String(id)),
  },
})

const BAR_HEIGHT = 32
const MAC = process.platform === 'darwin'

const GLYPHS = {
  minimize: '<svg viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor"/></svg>',
  maximize: '<svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>',
  restore:
    '<svg viewBox="0 0 10 10"><path d="M2.5 2.5V0.5h7v7h-2M0.5 2.5h7v7h-7z" fill="none" stroke="currentColor"/></svg>',
  close: '<svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor"/></svg>',
}

const CSS = `
  :root { --nook-titlebar: ${BAR_HEIGHT}px; }
  #app { height: calc(100dvh - var(--nook-titlebar)) !important; }
  #nook-titlebar {
    position: relative; z-index: 2147483000;
    height: var(--nook-titlebar); display: flex; align-items: center;
    background: var(--bg, #FDF6F3); color: var(--fg-faint, #6F6561);
    font: 600 12px/1 var(--sans, system-ui, sans-serif);
    user-select: none; -webkit-user-select: none; -webkit-app-region: drag;
  }
  #nook-titlebar .brand { flex: 1; min-width: 0; display: flex; align-items: center; padding-left: 12px; }
  #nook-titlebar .brand img { width: 16px; height: 16px; border-radius: 4px; flex: 0 0 auto; }
  /* In the middle of the window, clear of the buttons at either end. */
  #nook-titlebar .title {
    position: absolute; top: 0; left: 50%; height: 100%; transform: translateX(-50%);
    max-width: calc(100% - 320px); display: flex; align-items: center; gap: 6px; pointer-events: none;
  }
  #nook-titlebar .title-face { flex: 0 0 auto; display: inline-flex; }
  #nook-titlebar .title-face:empty { display: none; }
  #nook-titlebar .title-words { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  #nook-titlebar .controls { display: flex; height: 100%; -webkit-app-region: no-drag; }
  /* Square, as Windows draws them: the page's own button style must not reach in. */
  #nook-titlebar .controls button {
    width: 46px; height: 100%; min-height: 0; margin: 0; border: 0; border-radius: 0; padding: 0;
    background: transparent; box-shadow: none; transform: none; outline-offset: -2px;
    color: var(--fg-dim, #5F5551); display: grid; place-items: center; cursor: default;
  }
  #nook-titlebar .controls button:active { transform: none; }
  #nook-titlebar .controls button svg { width: 10px; height: 10px; }
  #nook-titlebar .controls button:hover { background: var(--hover, rgb(25 20 18 / 6%)); color: var(--fg, #191412); }
  #nook-titlebar .controls button.close:hover { background: #e81123; color: #fff; }
  html.nook-mac #nook-titlebar { padding-left: 72px; }
  html.nook-mac.nook-fullscreen #nook-titlebar { padding-left: 0; }
`

function button(kind, label, action) {
  const b = document.createElement('button')
  b.className = kind
  b.title = label
  b.setAttribute('aria-label', label)
  b.innerHTML = GLYPHS[kind]
  b.addEventListener('click', () => ipcRenderer.send('window:control', action))
  return b
}

function mount() {
  if (document.getElementById('nook-titlebar')) return

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.append(style)
  if (MAC) document.documentElement.classList.add('nook-mac')

  const bar = document.createElement('div')
  bar.id = 'nook-titlebar'

  const brand = document.createElement('div')
  brand.className = 'brand'
  const mark = document.createElement('img')
  mark.alt = ''
  mark.src = new URL('icons/app-icon.svg', location.href).href
  brand.append(mark)

  const title = document.createElement('div')
  title.className = 'title'
  const face = document.createElement('span')
  face.className = 'title-face'
  face.id = 'nook-title-face'
  const words = document.createElement('span')
  words.className = 'title-words'
  // "Nook | Night Shift": the icon says Nook, so the words say the rest.
  const sayTitle = () => {
    words.textContent = document.title.replace(/^Nook \| /, '')
  }
  sayTitle()
  new MutationObserver(sayTitle).observe(document.head, { subtree: true, childList: true, characterData: true })
  title.append(face, words)
  bar.append(brand, title)

  if (!MAC) {
    const max = button('maximize', 'Maximize', 'maximize')
    const controls = document.createElement('div')
    controls.className = 'controls'
    controls.append(button('minimize', 'Minimize', 'minimize'), max, button('close', 'Close', 'close'))
    bar.append(controls)
    ipcRenderer.on('window:maximized', (_ev, maximized) => {
      max.innerHTML = maximized ? GLYPHS.restore : GLYPHS.maximize
      max.title = maximized ? 'Restore' : 'Maximize'
      max.setAttribute('aria-label', max.title)
    })
  }

  ipcRenderer.on('window:fullscreen', (_ev, full) => {
    document.documentElement.classList.toggle('nook-fullscreen', full)
  })

  document.body.prepend(bar)

  // The theme the page picked, so the next start shows the splash and the window in it at once.
  const root = document.documentElement
  const tellTheme = () => ipcRenderer.send('theme:is', root.dataset.theme || '')
  tellTheme()
  new MutationObserver(tellTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
else mount()

// The shell's splash stays over the window until the page has painted its own loading screen,
// which is the same, or the page has come with none. The frame after the one that finds it has
// painted it.
function whenShown() {
  const look = () => {
    if (!document.querySelector('#boot .boot-say') && document.readyState === 'loading') {
      requestAnimationFrame(look)
      return
    }
    requestAnimationFrame(() => requestAnimationFrame(() => ipcRenderer.send('boot:shown')))
  }
  requestAnimationFrame(look)
}
whenShown()

