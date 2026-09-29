import '@fontsource/bricolage-grotesque/700.css'
import '@fontsource/bricolage-grotesque/800.css'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './brand/tokens.css'
import './brand/motion.css'
import './brand/components.css'
import './styles.css'
import { mentionsMe } from './chat'
import { checkSupport } from './diagnostics'
import { startStreaming } from './net/files'
import { watchPlaying } from './net/playing'
import { SOUND_HELD } from './net/unlock'
import { watchForDesktopUpdates, watchForUpdates } from './net/updates'
import { warmEmoji } from './ui/emoji'
import { clearLink, readLink, setLinkSecret } from './room'
import { spaces } from './space/registry'
import { noteForUpdate } from './space/resume'
import { isCallChannel, type SpaceRuntime } from './space/runtime'
import { nameChosen, shortKey } from './store/identity'
import { cleanChannel, DEFAULT_CHANNEL, type LogEvent } from './store/log'
import { newSpaceServer } from './store/server-spaces'
import { findSpace } from './store/spaces'
import { ask } from './ui/ask'
import { watchUnread } from './ui/badge'
import { installCalls } from './ui/call'
import { clear } from './ui/dom'
import { HomeView, type DirectRef } from './ui/home-view'
import { notify, notifyText, notifyWhat } from './ui/notify'
import { createWindow, type WindowChrome } from './ui/shell'
import { chirpMessage, isNews } from './ui/sounds'
import { spaceList } from './ui/space-list'
import { SpaceView } from './ui/space-view'
import { watchTheme } from './ui/theme'
import { toast } from './ui/toast'
import { drawEmojiAsArt } from './ui/twemoji'

const DEVICE_LINK_PREFIX = '#link='
/** How long the last word before an update's reload gets to reach the others. */
const ANNOUNCE_OUT_MS = 300

const app = document.getElementById('app')
if (!app) throw new Error('The page could not find its mount point.')
const mount = app

// The loading screen in index.html goes as soon as the first screen is on the page.
const boot = document.getElementById('boot')
if (boot) {
  const done = new MutationObserver(() => {
    if (mount.childElementCount === 0) return
    done.disconnect()
    boot.classList.add('gone')
    window.setTimeout(() => boot.remove(), 250)
  })
  done.observe(mount, { childList: true })
}

watchTheme()
watchUnread()
startStreaming()
watchForUpdates({
  inCall: () => spaces.all().some((space) => !!space.voice?.state.channel),
  beforeReload: async () => {
    const inVoice = spaces.all().find((space) => {
      const channel = space.voice?.state.channel ?? null
      return channel !== null && !isCallChannel(channel)
    })
    const state = inVoice?.voice.state
    noteForUpdate(
      inVoice && state?.channel
        ? { room: inVoice.room.id, channel: state.channel, muted: state.muted, deafened: state.deafened }
        : null,
      active?.sharingIn ?? null,
    )
    // Tells the others this is a reload, so they keep a place and play no sound; then gives it time to go out.
    for (const space of spaces.all()) space.announce()
    await new Promise((done) => window.setTimeout(done, ANNOUNCE_OUT_MS))
  },
})
window.addEventListener(SOUND_HELD, () => {
  toast('The browser holds back the sound of your call until you click. Your voice waits too.', 'warn', 0, {
    label: 'Hear the call',
    // The click itself lets the sound go.
    run: () => undefined,
  })
})
watchForDesktopUpdates()
warmEmoji()

interface Screen {
  destroy(): void
  readonly isLive: boolean
  /** The room whose screen this page shares, if any. */
  readonly sharingIn?: string | null
  readonly secret?: string
  readonly locked?: boolean
  readonly server?: string
  /** Opens a text channel of the space on screen. */
  openChannelNamed?(name: string): void
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
    pass = (await ask('This space has a password.', { password: true, ok: 'Join' })) ?? ''
    if (!pass) {
      void showHome()
      return
    }
  }
  const space = await spaces.open({ secret, locked: needsPassword, password: pass, server: where, fresh, name })
  openSpace(space)
}

spaces.fresh.add((space, events) => void alertAbout(space, events))

/**
 * A notification for what came in, as Discord does: who, where, and what they said.
 * Mentions and direct messages always, and every message if you asked for that.
 * The toast and the chirp are for mentions in a space you are not looking at.
 */
async function alertAbout(space: SpaceRuntime, events: LogEvent[]): Promise<void> {
  const chat = space.chat
  if (!chat) return
  const onScreen = active instanceof SpaceView && active.space === space
  const reading = active instanceof HomeView ? active.showing : null
  const spaceName = chat.spaceName() || 'a space'
  let names: Map<string, string> | null = null
  for (const e of events) {
    if (e.author === chat.me || !isNews(e.at)) continue
    const who = chat.nameOf(e.author) || shortKey(e.author)
    const picture = chat.avatarOf(e.author) || undefined
    if (e.kind === 'dm') {
      if (String(e.body.to ?? '') !== chat.me) continue
      const open = (): void => void showHome({ room: space.room.id, key: e.author })
      const looking = reading?.room === space.room.id && reading.key === e.author && !document.hidden
      if (!looking) {
        chirpMessage()
        toast(`${who} sent you a message`, 'info', 8000, { label: 'Read', run: open }, 'peek')
      }
      await chat.readDirect()
      const text = notifyText() ? chat.directText(e.id) || 'Sent you a file' : 'Sent you a message'
      notify(who, text, open, { tag: e.id, picture })
      continue
    }
    if (e.kind !== 'said') continue
    const channel = cleanChannel(String(e.body.channel ?? '')) || DEFAULT_CHANNEL
    // A kept channel you may not see, or one they may not write in, says nothing.
    if (!chat.mayEnter(chat.me, channel) || !chat.mayEnter(e.author, channel)) continue
    const text = String(e.body.text ?? '')
    names ??= chat.log.names()
    const mention = mentionsMe(text, names, chat.me)
    if (!mention && notifyWhat() !== 'all') continue
    const open = (): void => {
      if (!onScreen) openSpace(space)
      active?.openChannelNamed?.(channel)
    }
    if (mention && !onScreen) {
      chirpMessage()
      toast(`${who} mentioned you in ${spaceName}`, 'info', 8000, { label: 'Go', run: () => openSpace(space) }, 'wiggle')
    }
    const body = notifyText() ? text : mention ? 'Mentioned you' : 'Sent a message'
    notify(`${who} (#${channel}, ${spaceName})`, body, open, { tag: e.id, picture })
  }
}

const linked = window.location.hash.startsWith(DEVICE_LINK_PREFIX) ? null : readLink()

installCalls((space, key) => void showHome({ room: space.room.id, key }))

drawEmojiAsArt()
watchPlaying()

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
