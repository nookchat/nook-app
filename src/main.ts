/**
 * Beam. Peer to peer screen share with audio.
 *
 * The only server is the one that served this page. Read the plan in README.md.
 */

import './styles.css'
import { clearLink, readLinkSecret } from './room'
import { clear } from './ui/dom'
import { HostView } from './ui/host-view'
import { createWindow, type WindowChrome } from './ui/shell'
import { toast } from './ui/toast'
import { ViewerView } from './ui/viewer-view'
import { checkSupport } from './diagnostics'

const app = document.getElementById('app')

if (!app) {
  throw new Error('Beam could not find its mount point.')
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
 * only thing anybody opens Beam to do is share a screen.
 */
function showHost(): void {
  clearLink()
  const chrome = freshWindow('Beam')
  const view = new HostView(chrome.body, chrome)
  active = view
  view.mount()
}

function showViewer(secret: string): void {
  const chrome = freshWindow('Beam — watching')
  const view = new ViewerView(chrome.body, secret, showHost, chrome)
  active = view
  void view.start()
}

const secret = readLinkSecret()
if (secret) showViewer(secret)
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
