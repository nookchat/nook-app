import './styles.css'
import { mentionsMe } from './chat'
import { checkSupport } from './diagnostics'
import { startStreaming } from './net/files'
import { warmEmoji } from './ui/emoji'
import { clearLink, readLink, setLinkSecret } from './room'
import { spaces } from './space/registry'
import type { SpaceRuntime } from './space/runtime'
import { nameChosen, shortKey } from './store/identity'
import { newSpaceServer } from './store/server-spaces'
import { findSpace } from './store/spaces'
import { installCalls } from './ui/call'
import { clear } from './ui/dom'
import { HomeView, type DirectRef } from './ui/home-view'
import { notify } from './ui/notify'
import { createWindow, type WindowChrome } from './ui/shell'
import { chirpMessage, isNews } from './ui/sounds'
import { spaceList } from './ui/space-list'
import { SpaceView } from './ui/space-view'
import { toast } from './ui/toast'

const DEVICE_LINK_PREFIX = '#link='

const app = document.getElementById('app')
if (!app) throw new Error('The page could not find its mount point.')
const mount = app

startStreaming()
warmEmoji()

interface Screen {
  destroy(): void
  readonly isLive: boolean
  readonly secret?: string
  readonly locked?: boolean
  readonly server?: string
}

let active: Screen | null = null

function freshWindow(title: string): WindowChrome {
  active?.destroy()
  active = null
  clear(mount)
  const chrome = createWindow(title, {
    home: () => void showHome(),
    add: () => void showHome(null, true),
    open: (room) =>
      void enter(room.secret, room.locked === true, room.password ?? '', false, '', room.server ?? ''),
  })
  mount.append(chrome.root)
  return chrome
}

async function showHome(dm: DirectRef | null = null, making = false): Promise<void> {
  clearLink()
  const chrome = freshWindow('Nook: chat, voice and screen sharing')
  const home = new HomeView(chrome.body, chrome, {
    page: () =>
      spaceList({
        open: (secret, locked, password, name, server) =>
          void enter(secret, locked, password, name !== undefined, name, server),
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
  const chrome = freshWindow('Nook | Settings')
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
  const chrome = freshWindow('Nook')
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

// A wrong password opens a different, empty room, so the known list is asked first.
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

spaces.fresh.add((space, events) => {
  const chat = space.chat
  if (!chat) return
  const onScreen = active instanceof SpaceView && active.space === space
  const reading = active instanceof HomeView ? active.showing : null
  let names: Map<string, string> | null = null
  for (const e of events) {
    if (e.author === chat.me || !isNews(e.at)) continue
    const who = chat.nameOf(e.author) || shortKey(e.author)
    if (e.kind === 'dm') {
      if (String(e.body.to ?? '') !== chat.me) continue
      const open = (): void => void showHome({ room: space.room.id, key: e.author })
      if (reading?.room === space.room.id && reading.key === e.author && !document.hidden) continue
      chirpMessage()
      toast(`${who} sent you a message`, 'info', 8000, { label: 'Read', run: open })
      // Say who, not what: a private message is not for a lock screen.
      notify(who, 'Sent you a private message', open)
      continue
    }
    if (onScreen || e.kind !== 'said') continue
    const text = String(e.body.text ?? '')
    names ??= chat.log.names()
    if (!mentionsMe(text, names, chat.me)) continue
    const where = chat.spaceName() || 'a space'
    const open = (): void => openSpace(space)
    chirpMessage()
    toast(`${who} mentioned you in ${where}`, 'info', 8000, { label: 'Go', run: open })
    notify(`${who} in ${where}`, text, open)
  }
})

const linked = window.location.hash.startsWith(DEVICE_LINK_PREFIX) ? null : readLink()

installCalls((space, key) => void showHome({ room: space.room.id, key }))

async function start(): Promise<void> {
  if (window.location.hash.startsWith(DEVICE_LINK_PREFIX)) {
    const { linkFromAddress } = await import('./ui/link-device')
    if (await linkFromAddress(mount)) return
  }
  if (!nameChosen()) {
    const { welcome } = await import('./ui/welcome')
    await welcome(mount, linked !== null)
  }
  void spaces.load()
  if (linked) void enter(linked.secret, linked.locked, '', false, '', linked.server)
  else void showHome()
}
void start()

window.addEventListener('hashchange', () => {
  if (window.location.hash.startsWith(DEVICE_LINK_PREFIX)) {
    window.location.reload()
    return
  }
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
