/**
 * Cathode. A peer to peer place, with screen sharing in it.
 *
 * The only server is the one that served this page. Read the plan in README.md.
 */

import './styles.css'
import { bootTheme } from './ui/themes'
import { clearLink, readLinkSecret, setLinkSecret } from './room'
import { clear } from './ui/dom'
import { createWindow, type WindowChrome } from './ui/shell'
import { spaceList } from './ui/space-list'
import { SpaceView } from './ui/space-view'
import { toast } from './ui/toast'
import { checkSupport } from './diagnostics'

// Before anything is drawn, so nothing flashes in the wrong skin.
bootTheme()

const app = document.getElementById('app')
if (!app) throw new Error('The page could not find its mount point.')
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

async function showList(): Promise<void> {
  clearLink()
  const chrome = freshWindow('Cathode')
  chrome.setStatus(['Pick a space, or make one'])
  chrome.setActions({})
  chrome.body.append(await spaceList({ open: (secret) => openSpace(secret) }))
}

function openSpace(secret: string): void {
  const chrome = freshWindow('Cathode')
  setLinkSecret(secret)
  const view = new SpaceView(chrome.body, secret, chrome, () => void showList())
  active = view
  void view.start()
}

const linked = readLinkSecret()
if (linked) openSpace(linked)
else void showList()

window.addEventListener('beforeunload', (ev) => {
  if (active?.isLive) {
    ev.preventDefault()
    ev.returnValue = ''
  }
})

window.addEventListener('pagehide', () => active?.destroy())

if (checkSupport().isIOS && !linked) {
  toast(
    'This device can watch and chat, but Apple gives no browser the right to share a screen.',
    'info',
    8000,
  )
}
