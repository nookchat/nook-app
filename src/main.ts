/**
 * Beam. Peer to peer screen share with audio.
 *
 * The only server is the one that served this page. Read the plan in README.md.
 */

import './styles.css'
import { clearLink, readLinkSecret } from './room'
import { clear } from './ui/dom'
import { HostView, type SessionSummary } from './ui/host-view'
import { landing, topbar } from './ui/landing'
import { toast } from './ui/toast'
import { ViewerView } from './ui/viewer-view'
import { checkSupport } from './diagnostics'

const app = document.getElementById('app')

if (!app) {
  throw new Error('Beam could not find its mount point.')
}

const mount = app
let active: { stop: () => void } | null = null

function showLanding(summary: SessionSummary | null = null): void {
  active?.stop()
  active = null
  document.title = 'Beam · peer to peer screen share'
  clearLink()
  clear(mount)
  mount.append(landing(() => void startHosting(), summary))
}

async function startHosting(): Promise<void> {
  const shell = document.createElement('main')
  const view = new HostView(shell, (summary) => showLanding(summary))
  active = { stop: () => view.stop() }

  // Ask for the screen first. The picker must open inside the click, so we
  // swap the page only after the browser hands the capture over.
  clear(mount)
  mount.append(topbar())
  mount.append(shell)
  await view.start()
}

function showViewer(secret: string): void {
  const shell = document.createElement('div')
  shell.style.display = 'contents'
  clear(mount)
  mount.append(topbar())
  mount.append(shell)
  const view = new ViewerView(shell, secret, () => showLanding())
  active = { stop: () => view.stop() }
  void view.start()
}

function route(): void {
  const secret = readLinkSecret()
  if (secret) showViewer(secret)
  else showLanding()
}

window.addEventListener('beforeunload', (ev) => {
  if (active) {
    // A reload kills the stream for everybody watching, so ask first.
    ev.preventDefault()
    ev.returnValue = ''
  }
})

window.addEventListener('pagehide', () => active?.stop())

route()

const support = checkSupport()
if (support.isIOS && !readLinkSecret()) {
  toast(
    'This device can watch a stream, but Apple gives no browser the right to share a screen.',
    'info',
    8000,
  )
}
