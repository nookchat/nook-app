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
import { closeConnections } from './net/connection'
import { startStreaming } from './net/files'
import { watchPush } from './net/push'
import { roomHasLog } from './net/server-api'
import { watchListening } from './net/listening'
import { fitKeyboard } from './ui/keyboard'
import { installTips } from './ui/tip'
import { watchPlaying } from './net/playing'
import { SOUND_HELD } from './net/unlock'
import { watchForDesktopUpdates, watchForUpdates } from './net/updates'
import { warmEmoji } from './ui/emoji'
import { clearLink, deriveRoom, readLink, setLinkSecret } from './room'
import { spaces } from './space/registry'
import { filesFor, type SpaceMaking, type SpaceRuntime } from './space/runtime'
import { nameChosen, shortKey } from './store/identity'
import { cleanChannel, cleanFiles, DEFAULT_CHANNEL, type Attachment, type LogEvent } from './store/log'
import { channelMuted } from './store/mute'
import { newSpaceServer } from './store/server-spaces'
import { ROOMS_CHANGED } from './store/notes'
import { findSpace } from './store/spaces'
import { lastScreen } from './store/screen'
import { ask } from './ui/ask'
import { watchUnread } from './ui/badge'
import { lookingAtNook, watchLooking } from './ui/looking'
import { bootDone, bootStep } from './ui/boot'
import { installCalls } from './ui/call'
import { loggingOut } from './ui/log-out'
import { clear } from './ui/dom'
import { HomeView, type DirectRef } from './ui/home-view'
import { noticePicture, notify, notifyText, notifyWhat, offerNotify } from './ui/notify'
import { keepVoiceOnPhone } from './ui/phone-voice'
import { createWindow, type WindowChrome } from './ui/shell'
import { tabBar, type Tab } from './ui/tab-bar'
import { chirpMention, isNews, warmSounds } from './ui/sounds'
import { spaceList } from './ui/space-list'
import { SpaceView } from './ui/space-view'
import { watchTheme } from './ui/theme'
import { toast } from './ui/toast'
import { drawEmojiAsArt } from './ui/twemoji'

const DEVICE_LINK_PREFIX = '#link='
/** How long the last word before an update's reload gets to reach the others. */
const ANNOUNCE_OUT_MS = 300
/** How long the first screen waits for your spaces, to open the one you were in. */
const RESUME_WAIT_MS = 4000
/** How long the loading screen waits for the messages of the space it opens. */
const SETTLE_MS = 5000

const app = document.getElementById('app')
if (!app) throw new Error('The page could not find its mount point.')
const mount = app

// The loading screen in index.html stays until the first screen has what it needs.
bootStep(30, 'Loading Nook')

watchTheme()
watchLooking()
watchUnread()
warmSounds()
startStreaming()
watchForUpdates({
  // Nothing a reload would lose: no call, no share, no half-written message or unsaved note.
  idle: () =>
    !spaces.all().some((space) => !!space.voice?.state.channel) &&
    !active?.sharingIn &&
    ![...document.querySelectorAll<HTMLTextAreaElement>('.chat-compose textarea')].some((box) => box.value.trim()) &&
    !document.querySelector('.note-status')?.textContent?.includes('Not saved'),
  // A reload is a leave: out of every call first, so the others see it at once.
  beforeReload: async () => {
    for (const space of spaces.all()) space.leaveVoice()
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
keepVoiceOnPhone()
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
/** The space last on screen, for the space's tab on a phone. */
let lastSpace: SpaceRuntime | null = null

/** The space the space's tab goes to: the last one on screen, or the one a reload would open. */
function tabSpace(): SpaceRuntime | null {
  if (lastSpace && spaces.all().includes(lastSpace)) return lastSpace
  const last = lastScreen()
  return (last?.kind === 'space' ? spaces.get(last.room) : undefined) ?? spaces.all()[0] ?? null
}

function freshWindow(title: string, tab: Tab): WindowChrome {
  active?.destroy()
  active = null
  clear(mount)
  const chrome = createWindow(title, {
    home: () => void showHome(),
    add: () => void showHome(null, true),
    open: (room) =>
      void enter(room.secret, room.locked === true, room.password ?? '', false, '', room.server ?? ''),
  })
  chrome.root.append(
    tabBar(tab, {
      home: () => void showHome(),
      space: tabSpace(),
      // As Discord's tab does: the space with its channels out, to pick one.
      openSpace: (space) => {
        openSpace(space)
        if (active instanceof SpaceView) active.showChannels()
      },
      you: () => void showSettings(),
    }),
  )
  mount.append(chrome.root)
  return chrome
}

async function showHome(dm: DirectRef | null = null, making = false): Promise<void> {
  clearLink()
  const chrome = freshWindow('Nook: chat, voice and screen sharing', 'home')
  const home = new HomeView(chrome.body, chrome, {
    page: () => {
      // Add a space opens the new space steps once, not each time home draws its page again.
      const page = spaceList({
        open: (secret, locked, password, name, server, made) =>
          void enter(secret, locked, password, name !== undefined, name, server, made),
        refresh: () => {
          void spaces.catchUp()
          void showHome()
        },
        making,
      })
      making = false
      return page
    },
    settings: () => void showSettings(),
  }, dm)
  active = home
  await home.start()
}

async function showSettings(): Promise<void> {
  const chrome = freshWindow('Nook | Settings', 'you')
  const { settingsView } = await import('./ui/settings-view')
  chrome.body.append(
    settingsView({
      rename: (name, avatar, cover) => {
        for (const space of spaces.all()) {
          space.mesh?.setName(name)
          void space.chat?.announceName(name, avatar, cover)
        }
      },
      back: () => void showHome(),
    }),
  )
}

// A log out in another tab cleared what this one runs on: it starts again, at the welcome.
window.addEventListener('storage', (ev) => {
  if (ev.key === null && ev.storageArea === localStorage) window.location.replace(window.location.pathname)
})

function openSpace(space: SpaceRuntime): void {
  lastSpace = space
  const chrome = freshWindow('Nook', 'space')
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

// A wrong password opens a different, empty room, so the known list is asked first, and a
// password typed in is checked with the server before the space opens.
async function enter(
  secret: string,
  locked?: boolean,
  password = '',
  fresh = false,
  name = '',
  server?: string,
  made?: SpaceMaking,
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
  // A slow server after an update must not look like a password never given: wait for the whole list.
  if (needsPassword && !pass && !fresh) pass = (await findSpace(secret, server, true))?.password ?? ''
  if (needsPassword && !pass) pass = spaces.all().find((s) => s.secret === secret && s.locked && s.password)?.password ?? ''
  if (needsPassword && !pass) {
    pass = await askPassword(secret, where)
    if (!pass) {
      void showHome()
      return
    }
  }
  const space = await spaces.open({ secret, locked: needsPassword, password: pass, server: where, fresh, name, ...made })
  openSpace(space)
}

/** Asks until the password opens a space that is there. Empty when they gave up, or nothing could check it. */
async function askPassword(secret: string, server: string): Promise<string> {
  let question = 'This space has a password.'
  for (;;) {
    const pass = (await ask(question, { password: true, ok: 'Join' })) ?? ''
    if (!pass) return ''
    const room = await deriveRoom(secret, pass)
    const there = await roomHasLog(server, room.id)
    if (there) return pass
    if (there === null) {
      toast('The server did not answer, so the password could not be checked. Try again soon.', 'warn', 7000)
      return ''
    }
    question = 'That password is wrong. Try again.'
  }
}

spaces.fresh.add((space, events) => void alertAbout(space, events))

/** What a message with no words says, for what it carries. */
function wordsForFiles(files: Attachment[]): string {
  if (files.length === 0) return 'Sent a message'
  return files.every((f) => /^image\//.test(f.type)) ? (files.length > 1 ? 'Sent pictures' : 'Sent a picture') : 'Sent a file'
}

/** The picture a notification shows, when the person sees what was said and the message has one. */
function pictureOf(space: SpaceRuntime, files: Attachment[]): Promise<string> | undefined {
  return notifyText() && files.length ? noticePicture(files, filesFor(space)) : undefined
}

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
      const looking = reading?.room === space.room.id && reading.key === e.author && lookingAtNook()
      if (!looking) {
        chirpMention()
        toast(`${who} sent you a message`, 'info', 8000, { label: 'Read', run: open }, 'peek')
      }
      offerNotify()
      await chat.readDirect()
      const sent = chat.directFiles(e.id)
      const text = notifyText() ? chat.directText(e.id) || wordsForFiles(sent) : 'Sent you a message'
      notify(who, text, open, { tag: e.id, picture, image: pictureOf(space, sent) })
      continue
    }
    if (e.kind !== 'said') continue
    const channel = cleanChannel(String(e.body.channel ?? '')) || DEFAULT_CHANNEL
    // A kept channel you may not see, or one they may not write in, says nothing, and so does a muted one.
    if (!chat.mayEnter(chat.me, channel) || !chat.mayEnter(e.author, channel)) continue
    if (channelMuted(space.room.id, channel)) continue
    // Words alone in a Media only channel are out of sight, so they say nothing either.
    const info = chat.channelInfo().find((c) => c.name === channel)
    if (info?.mediaOnly && !chat.log.messages().some((m) => m.id === e.id)) continue
    const text = String(e.body.text ?? '')
    names ??= chat.log.names()
    const mention = mentionsMe(text, names, chat.me)
    if (!mention && notifyWhat() !== 'all') continue
    const open = (): void => {
      if (!onScreen) openSpace(space)
      active?.openChannelNamed?.(channel)
    }
    if (mention) offerNotify()
    if (mention && !onScreen) {
      chirpMention()
      toast(`${who} mentioned you in ${spaceName}`, 'info', 8000, { label: 'Go', run: () => openSpace(space) }, 'wiggle')
    }
    const sent = cleanFiles(e.body.files)
    const body = notifyText() ? text || wordsForFiles(sent) : mention ? 'Mentioned you' : 'Sent a message'
    // A channel marked NSFW never puts its pictures in a notification.
    const image = info?.nsfw ? undefined : pictureOf(space, sent)
    notify(`${who} (#${channel}, ${spaceName})`, body, open, { tag: e.id, picture, image })
  }
}

const linked = window.location.hash.startsWith(DEVICE_LINK_PREFIX) ? null : readLink()

interface NotificationTarget {
  room: string
  ch?: string
  dm?: string
}

/** A notification opened with Nook closed: the service worker puts where it was for in the address. */
function notificationTarget(): NotificationTarget | null {
  const query = new URLSearchParams(window.location.search)
  const room = query.get('room') ?? ''
  if (!/^[0-9a-f]{32}$/.test(room)) return null
  history.replaceState(null, '', window.location.pathname + window.location.hash)
  const ch = cleanChannel(query.get('ch') ?? '')
  const dm = query.get('dm') ?? ''
  return { room, ch: ch || undefined, dm: /^[0-9a-f]{64}$/.test(dm) ? dm : undefined }
}

/** The space and channel, or the direct message, a notification was about. */
async function openFromNotification(target: NotificationTarget): Promise<void> {
  const space = spaces.get(target.room)
  if (!space) return showHome()
  if (target.dm) return showHome({ room: space.room.id, key: target.dm })
  if (!(active instanceof SpaceView && active.space === space)) openSpace(space)
  if (target.ch) active?.openChannelNamed?.(target.ch)
}

// A notification clicked while a Nook window is open: the service worker hands it over.
navigator.serviceWorker?.addEventListener('message', (ev: MessageEvent) => {
  const data = ev.data as { type?: string } & Partial<NotificationTarget>
  if (data?.type !== 'nook-open' || typeof data.room !== 'string') return
  window.focus()
  void spaces.load().then(() => openFromNotification({ room: data.room!, ch: data.ch, dm: data.dm }))
})

installCalls((space, key) => void showHome({ room: space.room.id, key }))

drawEmojiAsArt()
watchPlaying()
watchListening()
fitKeyboard()
installTips()

/** The loading screen goes once the space on screen has its messages, or a little later at most. */
async function settle(): Promise<void> {
  const view = active
  if (view instanceof SpaceView) {
    bootStep(80, 'Catching up on messages')
    await Promise.race([view.space.ready, new Promise((done) => window.setTimeout(done, SETTLE_MS))])
  }
  bootDone()
}

async function start(): Promise<void> {
  // public/boot-move.js may be bringing the account over from the old home site: then it starts the page again.
  await (window as Window & { nookMoving?: Promise<void> }).nookMoving
  if (window.location.hash.startsWith(DEVICE_LINK_PREFIX)) {
    const { linkFromAddress } = await import('./ui/link-device')
    bootDone()
    if (await linkFromAddress(mount)) return
  }
  // Somebody who signs up now has nothing new to see in What's new: all of it is new.
  const fresh = !nameChosen()
  if (fresh) {
    const { welcome } = await import('./ui/welcome')
    bootDone()
    await welcome(mount, linked !== null)
  }
  void import('./ui/whats-new').then(({ whatsNewAfterStart }) => whatsNewAfterStart(fresh))
  bootStep(50, 'Opening your spaces')
  const loaded = spaces.load()
  void loaded.then(() => watchPush(() => spaces.all(), ROOMS_CHANGED))
  // A slow server does not keep the window blank: past this, home opens as usual.
  const listed = Promise.race([loaded, new Promise<void>((done) => window.setTimeout(done, RESUME_WAIT_MS))])
  const last = lastScreen()
  const tapped = notificationTarget()
  if (tapped && !linked) {
    await listed
    await openFromNotification(tapped)
    return void settle()
  }
  if (linked) {
    bootStep(65, 'Opening the space')
    await enter(linked.secret, linked.locked, '', false, '', linked.server)
    void settle()
    const view = active
    // The room is known once the space has started.
    if (last?.kind === 'space' && view instanceof SpaceView) {
      void view.space.ready.then(() => view.space.room.id === last.room && view.resumeChannel(last.channel))
    }
    return
  }
  // Back where you were: the desktop app opens at home after a restart, and a reload loses the channel.
  if (last?.kind === 'space') {
    await listed
    const space = spaces.get(last.room)
    if (space) {
      bootStep(65, space.note?.title ? `Opening ${space.note.title}` : 'Opening your space')
      openSpace(space)
      if (active instanceof SpaceView) active.resumeChannel(last.channel)
      void settle()
      return
    }
  }
  if (last?.kind === 'home' && last.dm) {
    await listed
    if (spaces.get(last.dm.room)) {
      await showHome(last.dm)
      return void settle()
    }
  }
  await showHome()
  void settle()
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
  if (active?.isLive && !loggingOut()) {
    ev.preventDefault()
    ev.returnValue = ''
  }
})

// Gone from the page is gone from the space: the sockets close now, so the server tells the others
// at once. A page the browser kept to show again has left, so it starts again.
window.addEventListener('pagehide', () => {
  active?.destroy()
  closeConnections()
})
window.addEventListener('pageshow', (ev) => {
  if (ev.persisted) window.location.reload()
})
