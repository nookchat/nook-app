// Tells the web app it runs in the desktop shell, and draws the title bar in
// place of the system one: a plain strip to drag the window by, in the page
// colour, and on Windows and Linux the window buttons on the right. On macOS the
// system keeps its own three buttons, over the left end of the bar. The app
// already shows its name and the space you are in, so the bar does not.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nookDesktop', { platform: process.platform })

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
  #nook-titlebar .spacer { flex: 1; }
  #nook-titlebar .controls { display: flex; height: 100%; -webkit-app-region: no-drag; }
  #nook-titlebar .controls button {
    width: 46px; height: 100%; border: 0; padding: 0; background: transparent;
    color: var(--fg-dim, #5B5670); display: grid; place-items: center; cursor: default;
  }
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

  const spacer = document.createElement('div')
  spacer.className = 'spacer'
  bar.append(spacer)

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
