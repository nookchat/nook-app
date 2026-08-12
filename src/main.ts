/**
 * Cathode. A peer to peer place, with screen sharing in it.
 *
 * The only server is the one that served this page. Read the plan in README.md.
 */

import './styles.css'
import { clearLink, readLink, setLinkSecret } from './room'
import { clear } from './ui/dom'
import { createWindow, type WindowChrome } from './ui/shell'
import { spaceList } from './ui/space-list'
import { SpaceView } from './ui/space-view'
import { findBySecret } from './store/db'
import { toast } from './ui/toast'
import { checkSupport } from './diagnostics'

const app = document.getElementById('app')
if (!app) throw new Error('The page could not find its mount point.')
const mount = app

interface Screen {
  destroy(): void
  readonly isLive: boolean
  /** Which space this is, so a link to the same one is left alone. */
  readonly secret?: string
  /** And whether it was opened with a password, which decides the same thing. */
  readonly locked?: boolean
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
  chrome.body.append(
    await spaceList({
      // A name means this space is being made rather than joined, so whoever
      // typed it is the one who claims the founder's key.
      open: (secret, locked, password, name) =>
        void enter(secret, locked, password, name !== undefined, name),
    }),
  )
}

function openSpace(
  secret: string,
  locked = false,
  password = '',
  fresh = false,
  name = '',
): void {
  const chrome = freshWindow('Cathode')
  setLinkSecret(secret, locked)
  const view = new SpaceView(chrome.body, secret, chrome, () => void showList(), {
    locked,
    password,
    fresh,
    name,
  })
  active = view
  void view.start()
}

/**
 * Open a space, asking for the password only when we do not already have it.
 *
 * A locked space used to ask every single time, including for the space you
 * made yourself an hour ago. The password is kept with the space, so this only
 * has to ask the first time, or after somebody clears their data.
 *
 * A caller that says nothing about the lock gets the space's own answer. The
 * password is mixed into the room id, so opening a locked space without it does
 * not fail: it lands in a different room, empty, under the same code. That is
 * what a bare code from the list or from somebody's message looks like, and it
 * is why the store is asked before the code is trusted.
 */
async function enter(
  secret: string,
  locked?: boolean,
  password = '',
  fresh = false,
  name = '',
): Promise<void> {
  const known = fresh ? null : await findBySecret(secret)
  const needsPassword = locked ?? known?.locked === true
  let pass = password
  if (needsPassword && !pass) pass = known?.password ?? ''
  if (needsPassword && !pass) {
    pass = window.prompt('This space has a password.') ?? ''
    if (!pass) {
      void showList()
      return
    }
  }
  openSpace(secret, needsPassword, pass, fresh, name)
}

const linked = readLink()
if (linked) {
  void enter(linked.secret, linked.locked)
} else {
  void showList()
}

/*
 * A link that arrives while the app is already open.
 *
 * The code lives in the fragment, so opening one from a page you already have
 * open changes the hash and reloads nothing. Without this the address bar said
 * one space and the screen showed another, which is worse than doing nothing at
 * all. Rewrites we make ourselves are skipped: those already opened the space.
 */
window.addEventListener('hashchange', () => {
  const next = readLink()
  if (!next) {
    if (active) void showList()
    return
  }
  // The code alone does not say which room this is: a locked space and an
  // unlocked one wearing the same code are two different rooms.
  if (active?.secret === next.secret && active.locked === next.locked) return
  void enter(next.secret, next.locked)
})

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
