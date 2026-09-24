/**
 * Cathode: spaces with text channels, voice and screen sharing, kept on a
 * server, sealed end to end. Read README.md.
 *
 * On opening, every space you are in starts at once (space/registry.ts), so
 * the rail shows what is new everywhere and home lists every direct message.
 * One screen is on show at a time: home, or one space.
 */

import './styles.css'
import { mentionsMe } from './chat'
import { clearLink, readLink, setLinkSecret } from './room'
import { spaces } from './space/registry'
import { newSpaceServer } from './store/server-spaces'
import type { SpaceRuntime } from './space/runtime'
import { shortKey } from './store/identity'
import { findSpace } from './store/spaces'
import { clear } from './ui/dom'
import { HomeView, type DirectRef } from './ui/home-view'
import { notify } from './ui/notify'
import { createWindow, type WindowChrome } from './ui/shell'
import { chirpMessage, isNews } from './ui/sounds'
import { spaceList } from './ui/space-list'
import { mountSpaceRail } from './ui/space-rail'
import { SpaceView } from './ui/space-view'
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
  readonly locked?: boolean
  readonly server?: string
}

let active: Screen | null = null

function freshWindow(title: string, space: string | null): WindowChrome {
  active?.destroy()
  active = null
  clear(mount)
  const chrome = createWindow(title)
  mount.append(chrome.root)
  mountSpaceRail(chrome.rail, space, {
    home: () => void showHome(),
    add: () => void showHome(null, true),
    open: (room) =>
      void enter(room.secret, room.locked === true, room.password ?? '', false, '', room.server ?? ''),
  })
  return chrome
}

/** Home: direct messages on the left, and your spaces or a conversation beside them. */
async function showHome(dm: DirectRef | null = null, making = false): Promise<void> {
  clearLink()
  const chrome = freshWindow('Cathode: chat, voice and screen sharing', null)
  const home = new HomeView(chrome.body, chrome, {
    page: () =>
      spaceList({
        // A name means this space is being made, so whoever typed it claims it.
        open: (secret, locked, password, name, server) =>
          void enter(secret, locked, password, name !== undefined, name, server),
        // A server just added may already hold spaces, from another device.
        refresh: () => {
          void spaces.catchUp()
          void showHome(null, true)
        },
      }),
    settings: () => void showSettings(),
  }, dm)
  active = home
  await home.start()
  if (making) chrome.body.querySelector<HTMLInputElement>('input[aria-label="Space name"]')?.focus()
}

async function showSettings(): Promise<void> {
  const chrome = freshWindow('Cathode | Settings', null)
  const { settingsView } = await import('./ui/settings-view')
  chrome.body.append(
    settingsView({
      rename: (name, avatar) => {
        for (const space of spaces.all()) {
          space.mesh?.setName(name)
          void space.chat?.announceName(name, avatar)
        }
      },
      back: () => void showHome(),
    }),
  )
}

function openSpace(space: SpaceRuntime): void {
  const chrome = freshWindow('Cathode', space.secret)
  setLinkSecret(space.secret, space.locked, space.server)
  const view = new SpaceView(
    chrome.body,
    space,
    chrome,
    () => void showHome(),
    (from, key) => void showHome({ room: from.room.id, key }),
  )
  active = view
  void view.start()
}

/**
 * Open a space, asking for the password only when this device does not have it.
 *
 * The password is mixed into the room id, so opening a locked space without it
 * does not fail: it lands in a different, empty room under the same code. So
 * your list is asked before a bare code is trusted.
 */
async function enter(
  secret: string,
  locked?: boolean,
  password = '',
  fresh = false,
  name = '',
  server?: string,
): Promise<void> {
  const known = fresh ? null : await findSpace(secret, server)
  const where = server || known?.server || newSpaceServer()
  if (!where) {
    toast('That code has no server in it. Paste the whole invite link, or add your server first.', 'warn', 7000)
    void showHome()
    return
  }
  const needsPassword = locked ?? known?.locked === true
  let pass = password
  if (needsPassword && !pass) pass = known?.password ?? ''
  if (needsPassword && !pass) {
    pass = window.prompt('This space has a password.') ?? ''
    if (!pass) {
      void showHome()
      return
    }
  }
  const space = await spaces.open({ secret, locked: needsPassword, password: pass, server: where, fresh, name })
  openSpace(space)
}

/*
 * Something new in any space. The space on screen says so itself; a direct
 * message, or a mention anywhere else, is said here, with a sound and a
 * notification when the tab is behind something else.
 */
spaces.fresh.add((space, events) => {
  const chat = space.chat
  if (!chat) return
  const onScreen = active instanceof SpaceView && active.space === space
  const reading = active instanceof HomeView ? active.showing : null
  for (const e of events) {
    if (e.author === chat.me || !isNews(e.at)) continue
    const who = chat.nameOf(e.author) || shortKey(e.author)
    if (e.kind === 'dm') {
      if (String(e.body.to ?? '') !== chat.me) continue
      const open = (): void => void showHome({ room: space.room.id, key: e.author })
      if (reading?.room === space.room.id && reading.key === e.author && !document.hidden) continue
      chirpMessage()
      toast(`${who} sent you a message`, 'info', 8000, { label: 'Read', run: open })
      // Who rather than what: a private message is not for a lock screen.
      notify(who, 'Sent you a private message', open)
      continue
    }
    if (onScreen || e.kind !== 'said') continue
    const text = String(e.body.text ?? '')
    if (!mentionsMe(text, chat.log.names(), chat.me)) continue
    const where = chat.spaceName() || 'a space'
    const open = (): void => openSpace(space)
    chirpMessage()
    toast(`${who} mentioned you in ${where}`, 'info', 8000, { label: 'Go', run: open })
    notify(`${who} in ${where}`, text, open)
  }
})

// Every space you are in, running, before anything is drawn from them.
void spaces.load()

const linked = readLink()
if (linked) {
  void enter(linked.secret, linked.locked, '', false, '', linked.server)
} else {
  void showHome()
}

/*
 * A link that arrives while the app is already open: the code lives in the
 * fragment, so it changes the hash and reloads nothing. Rewrites made here are
 * skipped, because those already opened the space.
 */
window.addEventListener('hashchange', () => {
  const next = readLink()
  if (!next) {
    if (active instanceof SpaceView) void showHome()
    return
  }
  if (
    active?.secret === next.secret &&
    active.locked === next.locked &&
    (next.server === undefined || active.server === next.server)
  ) {
    return
  }
  void enter(next.secret, next.locked, '', false, '', next.server)
})

window.addEventListener('beforeunload', (ev) => {
  if (active?.isLive) {
    ev.preventDefault()
    ev.returnValue = ''
  }
})

window.addEventListener('pagehide', () => active?.destroy())

if (checkSupport().isIOS && !linked) {
  toast('This device can watch and chat. Apple does not let any browser share a screen.', 'info', 8000)
}
