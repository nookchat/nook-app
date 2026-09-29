// Tells the web app it runs in the desktop shell, what game is running, and
// when a newer desktop app is out. The page gives it the unread count for the icon.
// It also draws the title bar in place of the system one: a strip to drag the
// window by, in the page colour, with the Nook icon and the window's title on the
// left, and on Windows and Linux the window buttons on the right. On macOS the
// system keeps its own three buttons, over the left end of the bar.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nookDesktop', {
  platform: process.platform,
  /** On: the shell looks for a running game and tells `onPlaying`. Off: it stops looking. */
  watchGames: (on) => ipcRenderer.send('games:watch', !!on),
  /** Called with { name, steam?, since } or null. Returns a function that stops it. */
  onPlaying: (fn) => {
    const heard = (_ev, now) =>
      fn(now && typeof now.name === 'string' ? { name: now.name, steam: now.steam, since: now.since } : null)
    ipcRenderer.on('games:playing', heard)
    return () => ipcRenderer.removeListener('games:playing', heard)
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
  /** The unread count on the Dock or taskbar icon. `overlay` is a PNG data URL, for Windows. */
  setBadge: (count, overlay) => ipcRenderer.send('badge:set', Number(count) || 0, typeof overlay === 'string' ? overlay : ''),
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
    background: var(--bg, #FBF7EF); color: var(--fg-faint, #6E6984);
    font: 600 12px/1 var(--sans, system-ui, sans-serif);
    user-select: none; -webkit-user-select: none; -webkit-app-region: drag;
  }
  #nook-titlebar .title {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding-left: 12px;
  }
  #nook-titlebar .title img { width: 16px; height: 16px; border-radius: 4px; flex: 0 0 auto; }
  #nook-titlebar .title span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  #nook-titlebar .controls { display: flex; height: 100%; -webkit-app-region: no-drag; }
  /* Square, as Windows draws them: the page's own button style must not reach in. */
  #nook-titlebar .controls button {
    width: 46px; height: 100%; min-height: 0; margin: 0; border: 0; border-radius: 0; padding: 0;
    background: transparent; box-shadow: none; transform: none; outline-offset: -2px;
    color: var(--fg-dim, #5B5670); display: grid; place-items: center; cursor: default;
  }
  #nook-titlebar .controls button:active { transform: none; }
  #nook-titlebar .controls button svg { width: 10px; height: 10px; }
  #nook-titlebar .controls button:hover { background: var(--hover, rgb(30 27 46 / 6%)); color: var(--fg, #1E1B2E); }
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

  const title = document.createElement('div')
  title.className = 'title'
  const mark = document.createElement('img')
  mark.alt = ''
  mark.src = new URL('icons/app-icon.svg', location.href).href
  const words = document.createElement('span')
  // "Nook | Night Shift": the icon says Nook, so the words say the rest.
  const sayTitle = () => {
    words.textContent = document.title.replace(/^Nook \| /, '')
  }
  sayTitle()
  new MutationObserver(sayTitle).observe(document.head, { subtree: true, childList: true, characterData: true })
  title.append(mark, words)
  bar.append(title)

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
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
else mount()
