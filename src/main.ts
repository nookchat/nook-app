/**
 * Cathode. Peer to peer screen share with audio.
 *
 * The only server is the one that served this page. Read the plan in README.md.
 */

import './styles.css'
import { bootTheme } from './ui/themes'
import { clearLink, readLinkSecret } from './room'
import { clear } from './ui/dom'
import { HostView } from './ui/host-view'
import { createWindow, type WindowChrome } from './ui/shell'
import { toast } from './ui/toast'
import { ViewerView } from './ui/viewer-view'
import { checkSupport } from './diagnostics'

// Before anything is drawn, so nothing flashes in the wrong skin.
bootTheme()

const app = document.getElementById('app')

if (!app) {
  throw new Error('The page could not find its mount point.')
}

const mount = app

interface Screen {
  destroy(): void
  readonly isLive: boolean
}

let active: Screen | null = null

function freshWindow(title: string): WindowChrome {
  active?.destroy()
  active = null
  clear(mount)
  const chrome = createWindow(title)
  mount.append(chrome.root)
  return chrome
}

/**
 * The sharing page is the front door. There is no welcome screen, because the
 * only thing anybody opens Cathode to do is share a screen.
 */
function showHost(): void {
  clearLink()
  const chrome = freshWindow('Screen share')
  const view = new HostView(chrome.body, chrome)
  active = view
  view.mount()
}

function showViewer(secret: string): void {
  const chrome = freshWindow('Watching a shared screen')
  const view = new ViewerView(chrome.body, secret, showHost, chrome)
  active = view
  void view.start()
}

/*
 * The address bar carries the room once a stream starts, so the link can be
 * shared straight from there. That creates one trap: reloading the host page
 * would read that fragment back and turn the host into a viewer of a room that
 * died with the reload. This tab remembers what it was hosting, so it lands
 * back on the picker instead.
 */
const HOSTING_KEY = 'cathode.hosting'

function wasHosting(secret: string): boolean {
  try {
    return sessionStorage.getItem(HOSTING_KEY) === secret
  } catch {
    return false
  }
}

const secret = readLinkSecret()
if (secret && !wasHosting(secret)) showViewer(secret)
else showHost()

window.addEventListener('beforeunload', (ev) => {
  // A reload kills the stream for everybody watching, so ask first.
  if (active?.isLive) {
    ev.preventDefault()
    ev.returnValue = ''
  }
})

window.addEventListener('pagehide', () => active?.destroy())

const support = checkSupport()
if (support.isIOS && !secret) {
  toast(
    'This device can watch a stream, but Apple gives no browser the right to share a screen.',
    'info',
    8000,
  )
}
