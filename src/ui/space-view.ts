import { checkSupport, hostBlocker } from '../diagnostics'
import { captureScreen, CaptureError, type ScreenCapture } from '../media/capture'
import { AudioMixer } from '../media/mixer'
import type { Mesh, MeshPeer } from '../net/mesh'
import type { Voice } from '../net/voice'
import { UplinkMeter } from '../net/uplink'
import { mutedFor, setMutedFor, setVolumeFor, volumeFor } from '../net/volume'
import { gifs as serverGifs, preview, serverHasGifs } from '../net/server-api'
import { formatSecret, roomLink, setLinkSecret, type Room } from '../room'
import { HostPeer } from '../rtc/host-peer'
import { ViewerPeer } from '../rtc/viewer-peer'
import { NO_HARDWARE, probeHardwareEncoders, type HardwareProbe } from '../rtc/hardware'
import { useServedIce } from '../rtc/config'
import { fetchIce, serverTag } from '../backend'
import {
  availableCodecs,
  planFor,
  PRESETS,
  presetById,
  type CodecChoice,
  type PresetId,
  type QualityPlan,
} from '../rtc/quality'
import type { SignalBus } from '../signal/bus'
import type { Envelope } from '../signal/envelope'
import { loadSettings, saveSettings, type HostSettings } from '../settings'
import { cleanName, mentionsMe } from '../chat'
import { addServer, bookFor } from '../store/server-spaces'
import { loadIdentity, saveDisplayName, shortKey, signClaim, verifyClaim } from '../store/identity'
import { isClip, type Gif } from '../store/gifs'
import {
  DEFAULT_CHANNEL,
  DEFAULT_VOICE,
  MEMBER,
  OWNER,
  cleanChannel,
  type ChannelInfo,
  type LogEvent,
  type Message,
} from '../store/log'
import type { RoomChat } from '../store/room-chat'
import { filesFor, isCallChannel, type SpaceRuntime } from '../space/runtime'
import { spaces } from '../space/registry'
import { spaceFace, switcherButton } from './space-switcher'
import { voiceDock } from './call'
import { chirpMessage, isNews, speak } from './sounds'
import { openSoundboard, playSound, soundById, soundByName, SOUNDS } from './soundboard'
import { avatarOf, ChatPanel, imageLinks } from './chat-panel'
import { clear, copyText, fmtKbps, h, onPress } from './dom'
import { icon } from './icons'
import { openMenu, type MenuItem, type MenuEntry } from './menu'
import { placeNear } from './emoji'
import { loadAvatar } from './avatar'
import type { WindowChrome } from './shell'
import { toast } from './toast'
import { notify } from './notify'
import { VideoSurface } from './video-surface'

const RECENT_MS = 14 * 24 * 60 * 60 * 1000
const STATS_MS = 2000
const SOUND_EVERY_MS = 1500
const TTS_EVERY_MS = 5000
const TTS_MAX_CHARS = 280
const TYPING_EVERY_MS = 2000
const TYPING_FOR_MS = 5000
const SEARCH_LIMIT = 40
const WATCHING_MAX = 12
const SERVER_SILENCE_MS = 10_000

interface PersonRow {
  key: string
  name: string
  here: boolean
  talking: boolean
  sharing: boolean
  voice: string | null
  you: boolean
  away: boolean
}

interface StageTile {
  peer: ViewerPeer | null
  surface: VideoSurface
  tile: HTMLElement
  tag: HTMLElement
}

interface LiveStream {
  id: string
  name: string
  you: boolean
  key: string
}

interface SearchQuery {
  words: string
  from: string
  in: string
  has: string
}

const COMMANDS = [
  { name: 'me', note: 'Say what you are doing' },
  { name: 'dm', note: 'Write to one person', takesName: true, also: ['msg'] },
  { name: 'poll', note: 'Ask a question with answers' },
  { name: 'nick', note: 'Change your name' },
  { name: 'topic', note: 'Say what this channel is for' },
  { name: 'rename', note: 'Rename this channel' },
  { name: 'gif', note: 'Look for a GIF to send' },
  { name: 'sound', note: 'Play a noise for everybody' },
  { name: 'tts', note: 'Say it out loud' },
  { name: 'shrug', note: '\u00af\\_(\u30c4)_/\u00af' },
  { name: 'invite', note: 'Copy the invite link' },
  { name: 'leave', note: 'Leave this space' },
  { name: 'help', note: 'List these' },
]

function levelDot(colour: string): HTMLElement {
  const dot = h('span', { class: 'level-dot' })
  if (colour) dot.style.background = colour
  return dot
}

function parseNote<T extends object>(raw: string, type: string): T | null {
  if (!raw.startsWith(`{"t":"${type}"`)) return null
  try {
    const note = JSON.parse(raw) as T & { t?: string }
    return note.t === type ? note : null
  } catch {
    return null
  }
}

// Checked on receipt too, because a modified sender keeps no promise to ration itself.
function allowNow(lastAt: Map<string, number>, key: string, everyMs: number): boolean {
  const now = Date.now()
  if (now - (lastAt.get(key) ?? 0) < everyMs) return false
  lastAt.set(key, now)
  return true
}

function watchedSessions(raw: unknown): string[] {
  // A lone string is the older wire format.
  if (typeof raw === 'string') return [raw]
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string').slice(0, WATCHING_MAX)
}

function dropOtherDeviceRows(rows: Map<string, PersonRow>, myName: string): void {
  const hereByName = new Set(
    [...rows.values()].filter((r) => r.here && r.name).map((r) => r.name.toLowerCase()),
  )
  for (const [key, row] of rows) {
    if (!row.here && row.name && hereByName.has(row.name.toLowerCase())) rows.delete(key)
  }
  const mine = myName.toLowerCase()
  if (!mine) return
  for (const [key, row] of rows) {
    if (!row.you && row.name.toLowerCase() === mine) rows.delete(key)
  }
}

function parseSearch(raw: string): SearchQuery {
  const filters = { from: '', in: '', has: '' }
  const words: string[] = []
  for (const part of raw.split(/\s+/)) {
    const at = part.indexOf(':')
    const key = at === -1 ? '' : part.slice(0, at).toLowerCase()
    const value = at === -1 ? '' : part.slice(at + 1).toLowerCase()
    if (value && (key === 'from' || key === 'in' || key === 'has')) filters[key] = value
    else words.push(part.toLowerCase())
  }
  return { ...filters, words: words.join(' ') }
}

function gifCell(g: Gif): HTMLVideoElement | HTMLImageElement {
  if (isClip(g.preview)) {
    const clip = h('video', { class: 'gif-choice' })
    clip.src = g.preview
    clip.autoplay = true
    clip.loop = true
    clip.muted = true
    clip.playsInline = true
    clip.setAttribute('muted', '')
    clip.setAttribute('playsinline', '')
    void clip.play().catch(() => undefined)
    return clip
  }
  const img = h('img', { class: 'gif-choice' })
  img.src = g.preview
  img.alt = ''
  img.loading = 'lazy'
  img.referrerPolicy = 'no-referrer'
  return img
}

export class SpaceView {
  private readonly root: HTMLElement
  private readonly chrome: WindowChrome | null
  readonly secret: string
  readonly space: SpaceRuntime
  private readonly selfId: string
  private unlisten: (() => void)[] = []
  private readonly onDirectOut: (space: SpaceRuntime, key: string) => void
  private settings: HostSettings = loadSettings()

  private room: Room | null = null
  private bus: SignalBus | null = null
  private mesh: Mesh | null = null
  private chat: RoomChat | null = null
  private chatPanel!: ChatPanel

  private channel = DEFAULT_CHANNEL
  private drawQueued = false
  readonly locked: boolean
  readonly server: string
  private spaceTitle!: HTMLSpanElement
  private spaceFace!: HTMLSpanElement
  private gifClose: (() => void) | null = null
  private dock: { root: HTMLElement; stop(): void } = { root: h('div', { class: 'hidden' }), stop: () => undefined }
  private voice: Voice | null = null
  private stopped = false
  private timers: number[] = []
  private readonly onLeave: () => void
  private forgotten = false
  private closing = false
  private loaded = false
  private settingsOpen = false

  private capture: ScreenCapture | null = null
  private mixer: AudioMixer | null = null
  private outStream: MediaStream | null = null
  private readonly watchers = new Map<string, HostPeer>()
  private gpu: HardwareProbe = NO_HARDWARE
  private readonly uplink = new UplinkMeter()

  private readonly watched = new Map<string, StageTile>()
  private readonly sharers = new Map<string, string>()
  private streamBar!: HTMLDivElement

  private readonly newestMoveBy = new Map<string, number>()
  private readonly watchingBy = new Map<string, string[]>()
  private soundSentAt = 0
  private readonly soundHeard = new Map<string, number>()
  private ttsSentAt = 0
  private readonly ttsHeard = new Map<string, number>()
  private serverWarned = false
  private serverTimer: number | null = null

  private channelList!: HTMLDivElement
  private voiceList!: HTMLDivElement
  private newTextButton!: HTMLButtonElement
  private newVoiceButton!: HTMLButtonElement
  private threadList!: HTMLDivElement
  private peopleList!: HTMLDivElement
  private voiceBar!: HTMLDivElement
  private shell!: HTMLElement
  private stage!: HTMLDivElement
  private shareButton!: HTMLButtonElement
  private shareButtonSharing: boolean | null = null
  private channelTitle!: HTMLDivElement
  private channelTitleSig = ''
  private searchInput!: HTMLInputElement
  private searchWrap!: HTMLDivElement
  private searchResults!: HTMLDivElement
  private searchNames: HTMLDivElement | null = null
  private pinsButton!: HTMLButtonElement
  private channelsButton!: HTMLButtonElement
  private peopleButton!: HTMLButtonElement
  private meFace!: HTMLSpanElement
  private meName!: HTMLSpanElement
  private membersHidden = false
  private railOpen: 'left' | 'right' | null = null

  private thread: string | null = null
  private read: Record<string, number> = {}
  private readWhenOpened = 0
  private readonly away = new Set<string>()
  private readonly typing = new Map<string, { channel: string; at: number }>()
  private lastTypingSent = 0
  private mentions = 0

  constructor(
    root: HTMLElement,
    space: SpaceRuntime,
    chrome: WindowChrome | null,
    onLeave: () => void,
    onDirect: (space: SpaceRuntime, key: string) => void = () => undefined,
  ) {
    this.root = root
    this.space = space
    this.secret = space.secret
    this.selfId = space.selfId
    this.chrome = chrome
    this.locked = space.locked
    this.server = space.server
    this.onDirectOut = onDirect
    this.onLeave = onLeave
  }

  get isLive(): boolean {
    return this.capture !== null || this.watchingAnyone()
  }

  private watchingAnyone(): boolean {
    for (const id of this.watched.keys()) if (id !== this.selfId) return true
    return false
  }

  async start(): Promise<void> {
    this.renderShell()
    const space = this.space
    try {
      await space.ready
    } catch {
      this.stage.classList.remove('hidden')
      this.stage.append(h('div', { class: 'empty', text: 'That room code is not valid.' }))
      return
    }
    if (this.stopped) return
    addServer(this.server)
    this.room = space.room
    this.chatPanel.setFiles(filesFor(space))
    const chat = space.chat
    this.chat = chat
    this.bus = space.bus
    this.mesh = space.mesh
    this.chatPanel.setMe(chat.me)
    this.chatPanel.setName(chat.displayName)
    this.chatPanel.useDraft(this.channel)
    this.read = { ...(space.note?.read ?? {}) }
    this.readWhenOpened = this.read[this.channel] ?? 0

    void fetchIce(this.server).then((ice) => {
      if (!this.stopped) useServedIce(ice.iceServers, ice.relayOnly)
    })
    this.voice = space.voice

    space.extras = () => ({
      sharing: this.capture ? this.voice?.state.channel ?? undefined : undefined,
      watching: this.watchingAnyone()
        ? [...this.watched.keys()].filter((id) => id !== this.selfId)
        : undefined,
    })

    this.unlisten.push(
      space.on('changed', () => this.draw()),
      space.on('voice', () => this.draw()),
      space.on('signal', (env) => void this.onSignal(env)),
      space.on('data', (from, raw) => this.onMeshData(from, raw)),
      space.on('peers', () => {
        this.prunePeers()
        this.draw()
      }),
      space.on('status', () => {
        this.status()
        this.watchServer()
      }),
      space.on('fresh', (events) => this.noticeFresh(events)),
    )
    for (const env of space.presence.values()) void this.onSignal(env)

    setLinkSecret(this.secret, this.locked, this.server)
    void probeHardwareEncoders(availableCodecs()).then((probe) => (this.gpu = probe))

    this.timers.push(window.setInterval(() => void this.tick(), STATS_MS))
    document.addEventListener('visibilitychange', this.onVisible)
    window.addEventListener('keydown', this.onShortcut)
    this.draw()
    this.status()
  }

  private readonly onVisible = (): void => {
    this.announceMe()
    this.draw()
  }

  private readonly onShortcut = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && this.railOpen) {
      this.showRail(null)
      return
    }
    if (ev.key === 'Escape' && this.watched.size > 0) {
      const target = ev.target as HTMLElement | null
      const writing = target?.closest('input, textarea, [contenteditable]') != null
      const menuOpen = document.querySelector('.menu') !== null
      if (!writing && !menuOpen) {
        this.stopWatching()
        this.draw()
        return
      }
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === 'm') {
      ev.preventDefault()
      this.toggleMute()
      return
    }
    if (!(ev.metaKey || ev.ctrlKey)) return
    if (ev.key.toLowerCase() === 'k') {
      ev.preventDefault()
      this.openSearchBox()
      return
    }
    if (/^[1-9]$/.test(ev.key)) {
      const wanted = (this.chat?.channels() ?? [])[Number(ev.key) - 1]
      if (!wanted) return
      ev.preventDefault()
      this.openChannel(wanted)
      this.chatPanel.focus()
    }
  }

  private toggleMute(): void {
    const state = this.voice?.state
    if (!state?.channel) {
      toast('You are not in a voice channel.', 'warn', 2500)
      return
    }
    this.voice?.setMuted(!state.muted)
    toast(state.muted ? 'Microphone on.' : 'Microphone muted.', 'info', 2000)
    this.draw()
  }

  destroy(): void {
    if (this.stopped) return
    this.stopped = true
    document.removeEventListener('visibilitychange', this.onVisible)
    window.removeEventListener('keydown', this.onShortcut)
    for (const t of this.timers) window.clearInterval(t)
    this.timers = []
    this.stopSharing()
    this.stopWatching()
    this.dock.stop()
    for (const off of this.unlisten) off()
    this.unlisten = []
    this.space.extras = () => ({})
    this.space.announce()
    this.bus = null
    useServedIce()
    void bookFor(this.server).flush()
    document.title = 'Nook'
  }

  // Only the cosmetic maps: a relay outage empties the roster while media keeps flowing.
  private prunePeers(): void {
    const alive = new Set((this.mesh?.peers() ?? []).map((p) => p.id))
    const known = new Set([...this.sharers.keys(), ...this.away, ...this.typing.keys(), ...this.watchingBy.keys()])
    for (const id of known) if (!alive.has(id)) this.forgetSession(id)
  }

  private forgetSession(id: string): void {
    this.sharers.delete(id)
    this.away.delete(id)
    this.typing.delete(id)
    this.watchingBy.delete(id)
  }

  private peersById(): Map<string, MeshPeer> {
    return new Map((this.mesh?.peers() ?? []).map((p) => [p.id, p]))
  }

  private keyOf(session: string): string {
    return this.mesh?.peers().find((p) => p.id === session)?.key || session
  }

  private async onSignal(env: Envelope): Promise<void> {
    await this.mesh?.handle(env)

    const data = (env.data ?? {}) as Record<string, unknown>
    switch (env.type) {
      case 'announce': {
        this.onAnnounce(env.from, data)
        return
      }
      case 'hello': {
        if (!this.outStream) return
        this.closeWatcher(env.from)
        this.admitWatcher(env.from)
        return
      }
      case 'offer': {
        // Only a session we asked to watch can put a picture here.
        await this.watched
          .get(env.from)
          ?.peer?.onOffer(data as unknown as RTCSessionDescriptionInit)
        return
      }
      case 'answer': {
        await this.watchers.get(env.from)?.onAnswer(data as unknown as RTCSessionDescriptionInit)
        return
      }
      case 'ice': {
        // side names the connection, since one person can watch us while we watch them; none is an older peer.
        const side = typeof data.side === 'string' ? data.side : ''
        const forViewer = side === 'host' || (side === '' && !this.watchers.has(env.from))
        if (forViewer) {
          await this.watched
            .get(env.from)
            ?.peer?.onIce(data as unknown as RTCIceCandidateInit)
        } else if (this.watchers.has(env.from)) {
          await this.watchers.get(env.from)?.onIce(data as unknown as RTCIceCandidateInit)
        }
        return
      }
      case 'vmove': {
        await this.onMoved(data)
        return
      }
      case 'bye': {
        this.closeWatcher(env.from)
        if (this.watched.has(env.from)) this.dropTile(env.from)
        this.forgetSession(env.from)
        this.draw()
        return
      }
      default:
        return
    }
  }

  private onAnnounce(from: string, data: Record<string, unknown>): void {
    const wasAway = this.away.has(from)
    if (data.away === true) this.away.add(from)
    else this.away.delete(from)

    const sharing = typeof data.sharing === 'string' ? cleanChannel(data.sharing) : ''
    const wasSharing = this.sharers.get(from)
    if (sharing) this.sharers.set(from, sharing)
    else this.sharers.delete(from)

    const eyes = watchedSessions(data.watching)
    const hadEyes = (this.watchingBy.get(from) ?? []).join()
    if (eyes.length) this.watchingBy.set(from, eyes)
    else this.watchingBy.delete(from)

    if (wasAway !== this.away.has(from) || (wasSharing ?? '') !== sharing || hadEyes !== eyes.join()) this.draw()
    if (!sharing && this.watched.has(from)) {
      this.dropTile(from)
      this.announceMe()
      this.draw()
    }
  }

  private noticeFresh(fresh: LogEvent[]): void {
    if (fresh.some((e) => e.kind === 'said' && e.author !== this.chat?.me && isNews(e.at))) {
      chirpMessage()
    }
    this.noticeMentions(fresh)
  }

  private onMeshData(from: string, raw: string): void {
    if (this.takeTyping(from, raw) || this.takeSound(from, raw)) return
    this.takeSpoken(from, raw)
  }

  private sayTyping(): void {
    const now = Date.now()
    if (now - this.lastTypingSent < TYPING_EVERY_MS) return
    this.lastTypingSent = now
    this.mesh?.broadcast(JSON.stringify({ t: 'typing', c: this.channel }))
  }

  private takeTyping(from: string, raw: string): boolean {
    const note = parseNote<{ c?: unknown }>(raw, 'typing')
    if (!note) return false
    this.typing.set(from, {
      channel: typeof note.c === 'string' ? cleanChannel(note.c) : DEFAULT_CHANNEL,
      at: Date.now(),
    })
    this.showTyping()
    window.setTimeout(() => {
      if (!this.stopped) this.showTyping()
    }, TYPING_FOR_MS + 100)
    return true
  }

  private showTyping(): void {
    const cutoff = Date.now() - TYPING_FOR_MS
    const peers = this.peersById()
    const people = new Map<string, string>()
    for (const [session, note] of this.typing) {
      if (note.at < cutoff) {
        this.typing.delete(session)
        continue
      }
      if (note.channel !== this.channel) continue
      const key = peers.get(session)?.key || session
      people.set(key, this.chat?.nameOf(key) || shortKey(key))
    }
    this.chatPanel.setTyping([...people.values()])
  }

  private sendSound(id: string): void {
    const sound = soundById(id)
    if (!sound) return
    const now = Date.now()
    if (now - this.soundSentAt < SOUND_EVERY_MS) {
      toast('One sound at a time.', 'warn')
      return
    }
    this.soundSentAt = now
    this.mesh?.broadcast(JSON.stringify({ t: 'sound', s: sound.id, c: this.channel }))
    if (!playSound(sound.id)) {
      toast(`${sound.label} went out. Your own sounds are off in Settings.`, 'info', 4000)
    }
  }

  private takeSound(from: string, raw: string): boolean {
    const note = parseNote<{ s?: unknown }>(raw, 'sound')
    if (!note) return false
    const sound = typeof note.s === 'string' ? soundById(note.s) : null
    if (!sound) return true
    const key = this.keyOf(from)
    if (!allowNow(this.soundHeard, key, SOUND_EVERY_MS)) return true
    if (playSound(sound.id)) {
      const who = (key && this.chat?.nameOf(key)) || 'Somebody'
      toast(`${who} played ${sound.label} ${sound.emoji}`, 'info', 3000)
    }
    return true
  }

  private openBoard(anchor: HTMLElement | null): void {
    const button = anchor ?? this.chatPanel.soundAnchor
    if (!button) return
    openSoundboard({ anchor: button, onPick: (id) => this.sendSound(id) })
  }

  private sendSpoken(arg: string): void {
    if (!this.chat || !this.mesh) return
    const text = arg.trim().slice(0, TTS_MAX_CHARS)
    if (!text) {
      toast('Say what to speak: /tts hello everybody', 'warn')
      return
    }
    if (Date.now() - this.ttsSentAt < TTS_EVERY_MS) {
      toast('Easy. One spoken line every five seconds.', 'warn')
      return
    }
    this.ttsSentAt = Date.now()
    this.mesh.broadcast(JSON.stringify({ t: 'tts', c: this.channel, x: text }))
    void this.publish((c) => c.say(text, this.channel))
    speak(text)
  }

  private takeSpoken(from: string, raw: string): boolean {
    const note = parseNote<{ x?: unknown }>(raw, 'tts')
    if (!note) return false
    if (typeof note.x !== 'string') return true
    if (!allowNow(this.ttsHeard, this.keyOf(from), TTS_EVERY_MS)) return true
    speak(note.x.slice(0, TTS_MAX_CHARS))
    return true
  }

  private markRead(channel: string): void {
    if (document.hidden) return
    const top = this.chat?.highWater(channel) ?? 0
    if (top <= (this.read[channel] ?? 0)) return
    this.read[channel] = top
    void this.remember({ read: this.read })
  }

  private noticeMentions(fresh: LogEvent[]): void {
    const chat = this.chat
    if (!chat) return
    const names = this.everybody()
    for (const e of fresh) {
      if (e.kind !== 'said' || e.author === chat.me || !isNews(e.at)) continue
      const text = String(e.body.text ?? '')
      if (!mentionsMe(text, names, chat.me)) continue
      const who = chat.nameOf(e.author) || shortKey(e.author)
      const where = cleanChannel(String(e.body.channel ?? '')) || DEFAULT_CHANNEL
      notify(`${who} in #${where}`, text, () => this.openChannel(where))
      if (where === this.channel && !this.thread) continue
      toast(`${who} mentioned you in #${where}`, 'info', 8000, {
        label: 'Go',
        run: () => this.openChannel(where),
      })
    }
  }

  private channelActions(channel: ChannelInfo): MenuItem[] {
    if (!this.chat?.can('channels')) return []
    const items: MenuItem[] = [
      {
        label: 'Rename',
        note: `Shown instead of ${channel.name}`,
        run: () => {
          const raw = window.prompt('What should this channel be called?', channel.label) ?? ''
          const label = raw.trim().slice(0, 32)
          if (!label) return
          void this.publish((c) => c.labelChannel(channel.name, label))
        },
      },
      {
        label: channel.topic ? 'Change the topic' : 'Set a topic',
        note: channel.topic || 'A line saying what it is for',
        run: () => {
          const raw = window.prompt('What is this channel for?', channel.topic) ?? ''
          void this.publish((c) => c.setTopic(channel.name, raw.trim().slice(0, 140)))
        },
      },
    ]
    if (channel.name !== DEFAULT_CHANNEL) {
      items.push({
        label: 'Delete',
        note: 'Takes the channel and everything said in it',
        danger: true,
        run: () => {
          const ok = window.confirm(
            `Delete ${channel.label}? Everything said in it goes with it, on every device that reads the log. It cannot be undone.`,
          )
          if (!ok) return
          if (this.channel === channel.name) this.openChannel(DEFAULT_CHANNEL)
          void this.publish((c) => c.dropChannel(channel.name))
        },
      })
    }
    return items
  }

  private runCommand(line: string): boolean {
    const [word, ...rest] = line.slice(1).split(' ')
    const name = word.toLowerCase()
    const arg = rest.join(' ').trim()
    const chat = this.chat
    if (!chat) return false

    const needsAdmin = (): boolean => {
      if (chat.can('channels')) return false
      toast('Your level cannot change channels.', 'warn')
      return true
    }

    switch (name) {
      case 'me': {
        if (!arg) return true
        void this.publish((c) => c.say(arg, this.channel, null, false, true))
        return true
      }
      case 'poll': {
        void this.newPoll(arg)
        return true
      }
      case 'tts': {
        this.sendSpoken(arg)
        return true
      }
      case 'gif': {
        void this.openGifPicker(arg)
        return true
      }
      case 'sound': {
        if (!arg) {
          this.openBoard(null)
          return true
        }
        const sound = soundByName(arg)
        if (!sound) {
          toast(`No sound called ${arg}. There is: ${SOUNDS.map((s) => s.id).join(', ')}`, 'warn', 7000)
          return true
        }
        this.sendSound(sound.id)
        return true
      }
      case 'shrug': {
        // Escaped so the markdown formatter keeps the arm and the underscores.
        const text = `${arg} \u00af\\\\\\_(\u30c4)\\_/\u00af`.trim()
        void this.publish((c) => c.say(text, this.channel))
        return true
      }
      case 'nick': {
        const next = cleanName(arg)
        if (!next) {
          toast('Say what to call you: /nick your name', 'warn')
          return true
        }
        saveDisplayName(next)
        this.rename(next)
        toast('Name changed. It updates everywhere, including old messages.', 'info', 5000)
        return true
      }
      case 'topic': {
        if (needsAdmin()) return true
        void this.publish((c) => c.setTopic(this.channel, arg))
        toast(arg ? 'Topic set.' : 'Topic cleared.', 'good')
        return true
      }
      case 'rename': {
        if (needsAdmin()) return true
        const label = arg.slice(0, 32)
        if (!label) {
          toast('Say what to call it: /rename the new name', 'warn')
          return true
        }
        void this.publish((c) => c.labelChannel(this.channel, label))
        return true
      }
      case 'dm':
      case 'msg': {
        const found = this.personNamedAtStart(arg)
        if (!found) {
          toast(`Nobody here is called ${arg.split(' ')[0] || 'that'}.`, 'warn')
          return true
        }
        const [key, who] = found
        const text = arg.slice(who.length).trim()
        this.openDirect(key)
        if (text) void this.publish((c) => c.sayDirect(key, text))
        return true
      }
      case 'invite': {
        void copyText(roomLink(this.secret, this.locked, this.server)).then((ok) =>
          toast(ok ? 'Invite link copied.' : 'Could not copy it.', ok ? 'info' : 'warn'),
        )
        return true
      }
      case 'leave': {
        void this.leaveSpace()
        return true
      }
      case 'help': {
        toast(COMMANDS.map((c) => `/${c.name}`).join('  '), 'info', 9000)
        return true
      }
      default:
        toast(`There is no /${name}. Try /help.`, 'warn')
        return true
    }
  }

  private personNamedAtStart(line: string): [string, string] | undefined {
    const wanted = line.toLowerCase()
    return [...this.everybody()]
      .filter(([, who]) => {
        const low = who.toLowerCase()
        return low !== '' && (wanted === low || wanted.startsWith(`${low} `))
      })
      .sort((a, b) => b[1].length - a[1].length)[0]
  }

  private openDirect(key: string): void {
    this.onDirectOut(this.space, key)
  }

  private openThread(rootId: string | null): void {
    this.showRail(null)
    this.chatPanel.keepDraft()
    this.thread = rootId
    this.chatPanel.useDraft(rootId ? `thread:${rootId}` : this.channel)
    this.chatPanel.setThread(rootId)
    this.closeSearch()
    this.drawNow()
    if (rootId) this.chatPanel.focus()
  }

  private renderSearch(): void {
    const raw = this.searchInput.value.trim()
    clear(this.searchResults)
    this.searchResults.classList.toggle('hidden', raw.length === 0)
    const chat = this.chat
    if (!raw || !chat) return

    const names = chat.log.names()
    const hits = this.searchHits(chat, parseSearch(raw), names)
    if (hits.length === 0) {
      this.searchResults.append(
        h('div', { class: 'tiny faint', text: 'Nothing matches that.' }),
        h('div', {
          class: 'tiny faint',
          text: 'Try from:alice, in:general, has:link, has:image, has:code, has:poll.',
        }),
      )
      return
    }
    this.searchResults.append(
      h('div', {
        class: 'tiny faint',
        text: `${hits.length}${hits.length === SEARCH_LIMIT ? '+' : ''} in this space`,
      }),
    )
    for (const m of hits) {
      const who = names.get(m.author) || shortKey(m.author)
      this.searchResults.append(
        h(
          'button',
          {
            class: 'search-hit',
            title: 'Go to it',
            on: { click: () => this.goTo(m) },
          },
          [
            h('span', { class: 'tiny faint', text: `#${m.channel} · ${who}` }),
            h('span', { class: 'truncate', text: m.text }),
          ],
        ),
      )
    }
  }

  private searchHits(chat: RoomChat, q: SearchQuery, names: Map<string, string>): Message[] {
    const labels = new Map(chat.channelInfo().map((c) => [c.name, c.label]))
    return chat.log
      .messages()
      .filter((m) => {
        if (q.words && !m.text.toLowerCase().includes(q.words)) return false
        if (q.from) {
          const who = (names.get(m.author) ?? '').toLowerCase()
          if (!who.startsWith(q.from) && !m.author.startsWith(q.from)) return false
        }
        if (q.in) {
          const label = (labels.get(m.channel) ?? m.channel).toLowerCase()
          if (!m.channel.startsWith(q.in) && !label.startsWith(q.in)) return false
        }
        if (q.has === 'link' && !/https?:\/\//.test(m.text)) return false
        if (q.has === 'image' && imageLinks(m.text).length === 0) return false
        if (q.has === 'code' && !m.text.includes('`')) return false
        if (q.has === 'poll' && !m.poll) return false
        return true
      })
      .sort((a, b) => b.lamport - a.lamport)
      .slice(0, SEARCH_LIMIT)
  }

  private goTo(m: Message): void {
    this.closeSearch()
    if (m.inThread && m.replyTo) this.openThread(m.replyTo)
    else if (this.thread) this.openThread(null)
    if (m.channel !== this.channel) this.openChannel(m.channel)
    this.drawNow()
    window.setTimeout(() => this.chatPanel.jump(m.id), 40)
  }

  private closeSearch(): void {
    this.searchInput.value = ''
    this.searchResults.classList.add('hidden')
    clear(this.searchResults)
    this.closeSearchNames()
    this.searchWrap.classList.remove('open')
  }

  private suggestSearchNames(): void {
    const input = this.searchInput
    const caret = input.selectionStart ?? input.value.length
    const word = /\S*$/.exec(input.value.slice(0, caret))?.[0] ?? ''
    const asked = /^from:(.*)$/i.exec(word)
    if (!asked) {
      this.closeSearchNames()
      return
    }

    const wanted = asked[1].toLowerCase()
    const hits = [...this.everybody().values()]
      .filter((who) => who && who.toLowerCase().startsWith(wanted))
      .slice(0, 6)
    if (hits.length === 0) {
      this.closeSearchNames()
      return
    }

    const list = this.searchNames ?? h('div', { class: 'mention-pop' })
    clear(list)
    hits.forEach((who, i) => {
      list.append(
        h('button', {
          class: `mention-option${i === 0 ? ' on' : ''}`,
          text: who,
          // mousedown, because the blur a click causes would close the list first.
          on: { mousedown: (ev) => { ev.preventDefault(); this.takeSearchName(who) } },
        }),
      )
    })
    if (!this.searchNames) {
      this.searchNames = list
      document.body.append(list)
    }
    placeNear(list, input)
  }

  private onSearchKey(ev: KeyboardEvent): boolean {
    const list = this.searchNames
    if (!list) return false
    const options = [...list.querySelectorAll('.mention-option')]
    const at = options.findIndex((el) => el.classList.contains('on'))
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const next = (at + (ev.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length
      options[at]?.classList.remove('on')
      options[next]?.classList.add('on')
      ev.preventDefault()
      return true
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      const who = options[at === -1 ? 0 : at]?.textContent ?? ''
      if (who) this.takeSearchName(who)
      ev.preventDefault()
      return true
    }
    if (ev.key === 'Escape') {
      this.closeSearchNames()
      ev.preventDefault()
      return true
    }
    return false
  }

  private takeSearchName(who: string): void {
    const input = this.searchInput
    const caret = input.selectionStart ?? input.value.length
    const head = input.value.slice(0, caret)
    const start = head.length - (/\S*$/.exec(head)?.[0].length ?? 0)
    const tail = input.value.slice(caret)
    const insert = `from:${who.split(' ')[0]}${tail.startsWith(' ') ? '' : ' '}`
    input.value = input.value.slice(0, start) + insert + tail
    const at = start + insert.length
    input.setSelectionRange(at, at)
    this.closeSearchNames()
    input.focus()
    this.renderSearch()
  }

  private closeSearchNames(): void {
    this.searchNames?.remove()
    this.searchNames = null
  }

  private async publish(make: (chat: RoomChat) => Promise<unknown>): Promise<void> {
    if (!this.chat) return
    await make(this.chat)
  }

  private draw(): void {
    if (this.stopped || this.drawQueued) return
    this.drawQueued = true
    requestAnimationFrame(() => {
      this.drawQueued = false
      this.drawNow()
    })
  }

  private drawNow(): void {
    const chat = this.chat
    if (this.stopped || !chat) return
    if (!this.loaded) {
      this.loaded = true
      this.shell.classList.remove('loading')
    }
    this.chatPanel.canPin = chat.can('pin')
    this.chatPanel.canDelete = chat.can('delete')
    const auth = chat.authority()
    this.chatPanel.colourOf = (key) => auth.levelOf(key).colour
    this.chatPanel.setNames(this.everybody(), chat.log.avatars())
    this.chatPanel.setReadMark(this.thread ? 0 : this.readWhenOpened)

    const thread = this.thread ? chat.threadOf(this.thread) : null
    if (thread?.length === 0) {
      this.openThread(null)
      return
    }
    const info = chat.channelInfo().find((c) => c.name === this.channel)
    this.renderConversation(chat, info, thread)
    this.renderChannelHead(info)
    this.markRead(this.channel)
    this.showTyping()
    this.renderSpaceName(chat)
    if (chat.isClosed && !this.closing) void this.acceptClose()

    const people = this.roster()
    this.renderChannels()
    this.renderThreads()
    this.renderVoice()
    this.renderPeople(people)
    this.renderMe()
    this.renderShareButton()
    this.status(people)
  }

  private renderConversation(chat: RoomChat, info: ChannelInfo | undefined, thread: Message[] | null): void {
    if (thread) {
      this.chatPanel.render(thread)
      this.chatPanel.setTitle(`Thread in #${this.channel}`)
      this.showPinsButton(0)
      return
    }
    const label = info?.label ?? this.channel
    this.chatPanel.setIntro({
      title: `Welcome to #${label}`,
      text: info?.topic || `This is the start of #${label}.`,
    })
    const messages = chat.messages(this.channel)
    this.chatPanel.render(messages)
    this.chatPanel.setTitle('Chat')
    this.showPinsButton(messages.filter((m) => m.pinned).length)
  }

  private showPinsButton(pinned: number): void {
    this.pinsButton.classList.toggle('hidden', pinned === 0)
    if (pinned > 0) {
      this.pinsButton.title = pinned === 1 ? 'One pinned message' : `${pinned} pinned messages`
    }
  }

  private renderChannelHead(info: ChannelInfo | undefined): void {
    const label = info?.label ?? this.channel
    const topic = info?.topic ?? ''
    const sig = `${label}\n${topic}`
    if (this.channelTitleSig === sig) return
    this.channelTitleSig = sig
    clear(this.channelTitle)
    this.channelTitle.append(
      h('span', { class: 'channel-name' }, [icon('hash', 18), h('span', { class: 'truncate', text: label })]),
    )
    if (topic) this.channelTitle.append(h('span', { class: 'channel-topic truncate', text: topic }))
  }

  private renderSpaceName(chat: RoomChat): void {
    const named = chat.spaceName()
    const label = named || 'Unnamed space'
    if (this.spaceTitle.textContent !== label) {
      this.spaceTitle.textContent = label
      if (named) void this.remember({ name: named })
    }
    const faceKey = `${this.room?.id ?? ''}|${named}`
    if (this.room && this.spaceFace.dataset.key !== faceKey) {
      this.spaceFace.dataset.key = faceKey
      this.spaceFace.replaceChildren(spaceFace(this.room.id, named, 24))
    }
  }

  private renderMe(): void {
    const chat = this.chat
    if (!chat) return
    const name = chat.displayName
    const picture = chat.avatarOf(chat.me) || loadAvatar()
    const sig = `${name}|${picture.length}|${picture.slice(-24)}`
    if (this.meFace.dataset.sig === sig) return
    this.meFace.dataset.sig = sig
    this.meFace.replaceChildren(avatarOf(chat.me, name, picture, 32), h('i', { class: 'dot good' }))
    this.meName.textContent = name
  }

  private everybody(): Map<string, string> {
    const names = new Map(this.chat?.log.names() ?? [])
    for (const peer of this.mesh?.peers() ?? []) {
      if (!peer.key || !peer.name) continue
      if (!names.has(peer.key)) names.set(peer.key, peer.name)
    }
    return names
  }

  private remember(patch: Parameters<SpaceRuntime['remember']>[0]): Promise<void> {
    if (this.forgotten) return Promise.resolve()
    return this.space.remember(patch)
  }

  private serverUp(): boolean {
    return this.bus?.healthList.some((r) => r.status === 'open') ?? false
  }

  private status(people?: PersonRow[]): void {
    if (!this.chrome) return
    if (!this.loaded) {
      this.chrome.setStatus(['Opening...'])
      return
    }
    const up = this.serverUp()
    const here = (people ?? this.roster()).filter((r) => r.here).length
    const what = this.capture
      ? 'Sharing your screen'
      : this.watchingAnyone()
        ? 'Watching a shared screen'
        : `#${this.channel}`
    const name = this.capture ? 'Sharing your screen' : `#${this.channel}`
    this.chrome.setTitle(`Nook | ${this.mentions ? `(${this.mentions}) ` : ''}${name}`)
    const serving = serverTag(this.space.channel?.serving ?? this.server)
    this.chrome.setStatus([what, `${here} here`, ...(up ? [] : [`cannot reach ${serving}`])])
    this.chrome.status.title = up ? `Connected to ${serving}` : `Cannot reach ${serving}`
  }

  private watchServer(): void {
    if (this.serverUp()) {
      this.serverWarned = false
      if (this.serverTimer !== null) {
        window.clearTimeout(this.serverTimer)
        this.serverTimer = null
      }
      return
    }
    if (this.serverWarned || this.serverTimer !== null) return
    this.serverTimer = window.setTimeout(() => {
      this.serverTimer = null
      if (this.stopped || this.serverWarned || this.serverUp()) return
      this.serverWarned = true
      toast(
        `Nook cannot reach ${serverTag(this.server)} or any server in its cluster, so nothing will sync until one answers. They may be down, or this network may block them.`,
        'bad',
        12_000,
      )
    }, SERVER_SILENCE_MS)
  }

  private renderShell(): void {
    clear(this.root)
    this.dock.stop()
    this.dock = voiceDock(this.space)

    this.channelList = h('div', { class: 'rail-list' })
    this.voiceList = h('div', { class: 'rail-list' })
    this.threadList = h('div', { class: 'rail-list' })
    this.peopleList = h('div', { class: 'rail-list' })
    this.voiceBar = h('div', { class: 'voice-bar hidden' })
    this.stage = h('div', { class: 'stage hidden' })
    this.streamBar = h('div', { class: 'stream-bar hidden' })
    this.channelTitle = h('div', { class: 'row channel-head' }, [
      h('span', { class: 'channel-name' }, [icon('hash', 18), h('span', { class: 'truncate', text: this.channel })]),
    ])
    this.channelTitleSig = ''

    this.shareButton = h('button', { class: 'ghost icon-only share-button' }, [icon('monitor', 19)])
    this.shareButton.addEventListener('click', () => void this.toggleShare())
    this.shareButtonSharing = null

    this.chatPanel = this.makeChatPanel()
    const left = this.leftRail()
    const right = h('div', { class: 'rail rail-right', role: 'complementary', ariaLabel: 'Who is here' }, [
      h('div', { class: 'rail-scroll' }, [this.peopleList]),
    ])

    this.pinsButton = h('button', {
      class: 'ghost icon-only hidden',
      ariaLabel: 'Pinned messages',
      title: 'Pinned in this channel',
      on: { click: () => this.openPins() },
    })
    this.pinsButton.append(icon('pin', 20))

    this.searchWrap = this.searchBar()

    const scrim = h('div', {
      class: 'rail-scrim',
      on: { click: () => this.showRail(null) },
    })
    this.channelsButton = h('button', {
      class: 'ghost icon-only rail-button',
      ariaLabel: 'Channels and settings',
      title: 'Channels, voice, and settings',
      on: { click: () => this.showRail(this.railOpen === 'left' ? null : 'left') },
    })
    this.channelsButton.append(icon('menu', 20))
    this.peopleButton = h('button', {
      class: 'ghost icon-only people-button',
      ariaLabel: 'Who is here',
      title: 'Who is here, and the invite',
      on: { click: () => this.togglePeople() },
    })
    this.peopleButton.classList.add('on')
    this.peopleButton.append(icon('people', 21))

    this.shell = h('div', { class: 'space-grid loading' }, [
      scrim,
      left,
      h('div', { class: 'space-main' }, [
        h('div', { class: 'space-head row' }, [
          this.channelsButton,
          this.channelTitle,
          this.pinsButton,
          this.searchWrap,
          this.peopleButton,
        ]),
        this.searchResults,
        this.streamBar,
        this.stage,
        this.chatPanel.root,
      ]),
      right,
    ])

    this.root.append(h('main', {}, [this.shell]))
  }

  private makeChatPanel(): ChatPanel {
    const panel = new ChatPanel(loadIdentity().name, 'Chat')
    panel.showNameField(false)
    panel.onTyping = () => this.sayTyping()
    panel.onThread = (rootId) => this.openThread(rootId)
    panel.onDirect = (key) => {
      if (key) this.openDirect(key)
    }
    panel.onCommand = (line) => this.runCommand(line)
    panel.streamLive = (key) => this.sharerByKey(key) !== null
    panel.onWatch = (key) => this.joinStream(key)
    panel.onGif = () => void this.openGifPicker('')
    panel.onSound = () => this.openBoard(panel.soundAnchor ?? null)
    panel.commands = COMMANDS
    panel.actions = {
      say: (text, replyTo, inThread, files) =>
        void this.publish((c) => c.say(text, this.channel, replyTo, inThread, false, files)),
      sayDirect: (to, text, files) => void this.publish((c) => c.sayDirect(to, text, files)),
      edit: (id, text) => void this.publish((c) => c.edit(id, text)),
      react: (id, emoji, on) => void this.publish((c) => c.react(id, emoji, on)),
      retract: (id) => void this.publish((c) => c.retract(id)),
      pin: (id, on) => void this.publish((c) => c.pin(id, on)),
      vote: (id, choice) => void this.publish((c) => c.vote(id, choice)),
      rename: (name) => this.rename(name),
    }
    panel.previewFor = (url) => preview(this.server, url)
    panel.setEnabled(true)
    return panel
  }

  private leftRail(): HTMLElement {
    this.spaceTitle = h('span', { class: 'space-name truncate', text: '' })
    this.spaceFace = h('span', { class: 'space-face-slot' })
    const spaceMenu = switcherButton({
      active: this.secret,
      face: this.spaceFace,
      name: this.spaceTitle,
      nav: this.chrome?.nav ?? { home: () => this.goHome(), add: () => this.goHome(), open: () => undefined },
      more: () => [
        { label: 'Invite', lead: h('span', { class: 'menu-icon' }, [icon('user-plus', 16)]), run: () => void this.showInvite() },
        { label: 'Settings', lead: h('span', { class: 'menu-icon' }, [icon('settings', 16)]), run: () => void this.openSettings() },
        { label: 'Leave', danger: true, lead: h('span', { class: 'menu-icon' }, [icon('leave', 16)]), run: () => void this.leaveSpace() },
      ],
    })

    this.meFace = h('span', { class: 'me-face' })
    this.meName = h('span', { class: 'me-name truncate' })
    const me = h('div', { class: 'me-panel' }, [
      this.meFace,
      h('div', { class: 'me-text' }, [this.meName, this.chrome?.status ?? null]),
      h(
        'button',
        {
          class: 'ghost icon-only',
          title: 'Your name, your ID, and this space',
          ariaLabel: 'Settings',
          on: { click: () => void this.openSettings() },
        },
        [icon('settings', 19)],
      ),
    ])

    this.newTextButton = h(
      'button',
      {
        class: 'ghost icon-only rail-add hidden',
        title: 'Make a text channel',
        ariaLabel: 'Make a text channel',
        on: { click: () => void this.newChannel(false) },
      },
      [icon('plus', 17)],
    )
    this.newVoiceButton = h(
      'button',
      {
        class: 'ghost icon-only rail-add hidden',
        title: 'Make a voice channel',
        ariaLabel: 'Make a voice channel',
        on: { click: () => void this.newChannel(true) },
      },
      [icon('plus', 17)],
    )

    return h('div', { class: 'rail rail-left', role: 'navigation', ariaLabel: 'Channels, threads and conversations' }, [
      h('div', { class: 'space-title' }, [spaceMenu]),
      h('div', { class: 'rail-scroll' }, [
        h('div', { class: 'rail-head' }, [h('span', { class: 'eyebrow', text: 'Text channels' }), this.newTextButton]),
        this.channelList,
        h('div', { class: 'rail-head' }, [
          h('span', {
            class: 'eyebrow',
            text: 'Voice channels',
            title: 'Everybody standing in one hears everybody else.',
          }),
          this.newVoiceButton,
        ]),
        this.voiceList,
        this.threadList,
      ]),
      this.dock.root,
      this.voiceBar,
      me,
    ])
  }

  private searchBar(): HTMLDivElement {
    this.searchInput = h('input', {
      type: 'text',
      class: 'space-search',
      ariaLabel: 'Search this space',
      placeholder: 'Search',
      title: 'Words to look for, and from: in: has: to narrow it down',
      on: {
        input: () => {
          this.renderSearch()
          this.suggestSearchNames()
        },
        keydown: (ev) => {
          if (this.onSearchKey(ev as KeyboardEvent)) return
          if ((ev as KeyboardEvent).key === 'Escape') this.closeSearch()
        },
        focus: () => this.searchWrap.classList.add('open'),
        blur: () => {
          this.closeSearchNames()
          window.setTimeout(() => {
            if (!this.searchInput.value && document.activeElement !== this.searchInput) {
              this.searchWrap.classList.remove('open')
            }
          }, 150)
        },
      },
    })
    this.searchResults = h('div', { class: 'search-results hidden' })
    const searchBox = h('label', { class: 'search-box' }, [icon('search', 16), this.searchInput])
    const searchToggle = h(
      'button',
      {
        class: 'ghost icon-only search-toggle',
        ariaLabel: 'Search',
        title: 'Search this space (Ctrl K)',
        on: { click: () => this.openSearchBox() },
      },
      [icon('search', 20)],
    )
    return h('div', { class: 'search-wrap' }, [searchToggle, searchBox])
  }

  private togglePeople(): void {
    if (window.matchMedia('(max-width: 780px)').matches) {
      this.showRail(this.railOpen === 'right' ? null : 'right')
      return
    }
    this.membersHidden = !this.membersHidden
    this.shell.classList.toggle('members-hidden', this.membersHidden)
    this.peopleButton.classList.toggle('on', !this.membersHidden)
  }

  private async openSettings(): Promise<void> {
    const { settingsView } = await import('./settings-view')
    if (this.stopped) return
    clear(this.root)
    this.settingsOpen = true
    this.root.append(
      settingsView({
        rename: (name, avatar) => this.rename(name, avatar),
        space: {
          name: this.chat?.spaceName() || 'Unnamed space',
          admin: this.chat?.can('space') === true,
          levels: this.chat?.can('levels') ? () => this.levelsEditor() : undefined,
          rename: () => this.renameSpace(),
          reset: () => this.resetSpace(),
          leave: () => this.leaveSpace(),
          remove: () => this.deleteSpace(),
          removed: [...(this.chat?.roles() ?? new Map<string, string>())]
            .filter(([key, role]) => role === 'kicked' && this.chat?.authority().mayRemove(this.chat.me, key))
            .map(([key]) => ({
              key,
              name: this.chat?.nameOf(key) || shortKey(key),
              restore: () => void this.setRole(key, 'member'),
            })),
        },
        back: () => {
          this.settingsOpen = false
          clear(this.root)
          this.root.append(h('main', {}, [this.shell]))
          this.drawNow()
        },
      }),
    )
  }

  private async renameSpace(): Promise<void> {
    if (!this.chat?.can('space')) {
      toast('Your level cannot rename this space.', 'warn')
      return
    }
    const raw = window.prompt('Name this space', this.chat.spaceName()) ?? ''
    const name = raw.trim().slice(0, 32)
    if (!name) return
    await this.publish((c) => c.setSpaceName(name))
    await this.remember({ name })
    if (this.settingsOpen) void this.openSettings()
  }

  private showRail(which: 'left' | 'right' | null): void {
    this.railOpen = which
    this.shell.classList.toggle('rail-left-open', which === 'left')
    this.shell.classList.toggle('rail-right-open', which === 'right')
    this.channelsButton.setAttribute('aria-expanded', String(which === 'left'))
    this.peopleButton.setAttribute('aria-expanded', String(which === 'right'))
  }

  private openSearchBox(): void {
    this.searchWrap.classList.add('open')
    this.searchInput.focus()
    this.searchInput.select()
  }

  private goHome(): void {
    this.destroy()
    this.onLeave()
  }

  private async leaveSpace(): Promise<void> {
    const name = this.chat?.spaceName() || 'this space'
    const ok = window.confirm(
      this.server
        ? `Leave ${name}? It comes off your list on every device. Its history stays on ${serverTag(this.server)}, and the link still works if you want back in.`
        : `Leave ${name}? Its history goes from this device. Everybody else keeps theirs, and the link still works if you want back in.`,
    )
    if (!ok) return
    await this.forget(false)
    toast(this.server ? 'Left. It is off your list.' : 'Left, and forgotten on this device.', 'info')
  }

  private async deleteSpace(): Promise<void> {
    if (!this.chat?.can('space')) {
      toast('Your level cannot delete this space.', 'warn')
      return
    }
    const name = this.chat.spaceName() || 'this space'
    const ok = window.confirm(
      `Delete ${name} for everybody? Every device in it now, and every device that syncs later, forgets the space and its history. It cannot be undone, and anybody who exported a copy first still has that copy.`,
    )
    if (!ok) return
    this.closing = true
    await this.publish((c) => c.closeSpace())
    // A moment for the close to reach connected peers before the connections go.
    await new Promise((done) => window.setTimeout(done, 400))
    await this.forget(true)
    toast('Deleted. Everybody who is here, or who syncs later, loses it too.', 'info', 7000)
  }

  private async acceptClose(): Promise<void> {
    if (this.forgotten) return
    await this.forget(true)
    toast('An admin deleted this space.', 'warn', 7000)
  }

  private async forget(closed: boolean): Promise<void> {
    if (this.forgotten) return
    const room = this.room
    if (closed) await this.space.remember({ closed: true })
    this.forgotten = true
    this.destroy()
    if (room) {
      spaces.drop(room.id)
      const book = bookFor(this.server)
      if (!closed) await book.forget(room.id)
      await book.flush()
    }
    this.onLeave()
  }

  private async setRole(subject: string, role: string): Promise<void> {
    const auth = this.chat?.authority()
    const me = this.chat?.me ?? ''
    const allowed =
      auth && (role === 'kicked' || auth.isKicked(subject) ? auth.mayRemove(me, subject) : auth.mayPlace(me, subject))
    if (!allowed) {
      toast('Your level cannot do that.', 'warn')
      return
    }
    await this.publish((c) => c.setRole(subject, role))
  }

  private levelsEditor(): HTMLElement {
    const holder = h('div', { class: 'stack tight' })
    void import('./levels').then(({ levelsEditor }) => {
      const chat = this.chat
      if (!chat) return
      holder.append(
        levelsEditor({
          chat,
          publish: (write) => this.publish(write),
          people: () => this.roster().map((r) => ({ key: r.key, name: r.name || shortKey(r.key) })),
        }),
      )
    })
    return holder
  }

  private rename(name: string, avatar?: string): void {
    this.mesh?.setName(name)
    this.chatPanel.setName(name)
    void this.publish((c) => c.announceName(name, avatar))
  }

  private async showInvite(): Promise<void> {
    const { qrSvg } = await import('./qr')
    const link = roomLink(this.secret, this.locked, this.server)
    const close = (): void => {
      scrim.remove()
      window.removeEventListener('keydown', onKey)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    const frame = h('div', { class: 'qr-frame' })
    try {
      frame.append(qrSvg(link, { pixels: 200 }))
    } catch {
      frame.append(h('div', { class: 'small', text: 'This link is too long for a QR code.' }))
    }
    const copy = h('button', { class: 'primary grow' }, [icon('link', 15), 'Copy link'])
    copy.addEventListener('click', async () => {
      const ok = await copyText(link)
      toast(ok ? 'Invite link copied.' : 'Could not copy it.', ok ? 'info' : 'warn')
    })
    const scrim = h('div', { class: 'scrim', on: { click: (ev) => ev.target === scrim && close() } })
    scrim.append(
      h('div', { class: 'modal invite-modal' }, [
        h('div', { class: 'invite-head' }, [
          h('div', { class: 'invite-words' }, [
            h('div', { class: 'invite-title', text: `Invite people to ${this.chat?.spaceName() || 'this space'}` }),
            h('div', {
              class: 'tiny faint',
              text: this.locked
                ? 'They need the password too. Send it separately.'
                : 'Anyone with the link can join. It holds the key, so send it privately.',
            }),
          ]),
          h('button', { class: 'ghost icon-only', ariaLabel: 'Close', on: { click: close } }, [icon('close', 18)]),
        ]),
        h('div', { class: 'invite-body' }, [
          h('div', { class: 'share-code', text: formatSecret(this.secret), title: 'The code for this space', data: { link } }),
          copy,
          frame,
          h('div', { class: 'tiny faint invite-scan', text: 'Or scan it with a phone.' }),
        ]),
      ]),
    )
    document.body.append(scrim)
  }

  private renderChannels(): void {
    const chat = this.chat
    clear(this.channelList)
    const canEdit = chat?.can('channels') === true
    this.newTextButton.classList.toggle('hidden', !canEdit)
    const waiting = chat?.unread(this.read) ?? new Map()
    let mentions = 0
    for (const [, count] of waiting) mentions += count.mentions
    const liveChannels = new Set(this.sharers.values())

    for (const channel of chat?.channelInfo() ?? [{ name: DEFAULT_CHANNEL, label: DEFAULT_CHANNEL, topic: '' }]) {
      const name = channel.name
      const news = waiting.get(name)
      const open = h(
        'button',
        {
          class: `rail-item grow${name === this.channel ? ' on' : ''}${news ? ' unread' : ''}`,
          title: channel.topic || `Open ${channel.label}`,
          on: { click: () => this.openChannel(name) },
        },
        [
          icon('hash', 16),
          h('span', { class: 'truncate grow', text: channel.label }),
          liveChannels.has(name) ? h('span', { class: 'pill live', text: 'live' }) : null,
          news?.mentions
            ? h('span', { class: 'pill bad', text: `${news.mentions}`, title: 'You were mentioned' })
            : null,
        ],
      )
      let more: HTMLButtonElement | null = null
      if (canEdit) {
        const button = h('button', {
          class: 'ghost tiny-btn person-more',
          title: `What you can do with ${channel.label}`,
          ariaLabel: `Actions for ${channel.label}`,
          data: { menu: `channel:${name}` },
        })
        onPress(button, () => openMenu(button, this.channelActions(channel)))
        button.append(icon('more', 17))
        more = button
      }
      this.channelList.append(h('div', { class: 'row rail-row' }, [open, more]))
    }
    this.mentions = mentions
  }

  private renderThreads(): void {
    clear(this.threadList)
    const threads = this.chat?.threads() ?? []
    if (threads.length === 0) return
    this.threadList.append(h('div', { class: 'rail-head' }, [h('span', { class: 'eyebrow', text: 'Threads' })]))
    for (const thread of threads.slice(0, 6)) {
      const mark = this.read[thread.root.channel] ?? 0
      const fresh = thread.newest > mark && thread.root.author !== this.chat?.me
      this.threadList.append(
        h(
          'button',
          {
            class: `rail-item${this.thread === thread.root.id ? ' on' : ''}${fresh ? ' unread' : ''}`,
            title: `${thread.root.name || shortKey(thread.root.author)}: ${thread.root.text}`,
            on: { click: () => this.openThread(thread.root.id) },
          },
          [
            h('span', { class: 'truncate grow', text: thread.root.text || 'a message' }),
            h('span', { class: 'pill', text: `${thread.replies}` }),
          ],
        ),
      )
    }
  }

  private renderVoice(): void {
    const chat = this.chat
    clear(this.voiceList)
    this.newVoiceButton.classList.toggle('hidden', !chat?.can('channels'))
    const here = this.voice?.state.channel ?? null
    const peers = this.peersById()
    const names = chat?.log.names() ?? new Map<string, string>()
    const avatars = chat?.log.avatars() ?? new Map<string, string>()
    for (const name of chat?.channels(true) ?? [DEFAULT_VOICE]) {
      const people = this.sessionsByPerson(this.voice?.membersOf(name) ?? [], peers)
      const row = h('div', { class: 'voice-channel' }, [
        h(
          'button',
          {
            class: `rail-item${here === name ? ' on' : ''}`,
            title:
              here === name
                ? 'You are in here. Click to leave.'
                : 'Join this voice channel. Everybody in it hears everybody else.',
            on: { click: () => void this.joinVoice(name) },
          },
          [
            icon('volume', 16),
            h('span', { class: 'truncate grow', text: name }),
            people.size ? h('span', { class: 'pill', text: String(people.size) }) : null,
          ],
        ),
      ])
      for (const [key, ids] of people) {
        row.append(this.voiceMember(key, ids, peers, names.get(key) ?? '', avatars.get(key) ?? ''))
      }
      this.voiceList.append(row)
    }
    this.renderVoiceBar()
  }

  private sessionsByPerson(members: string[], peers: Map<string, MeshPeer>): Map<string, string[]> {
    const people = new Map<string, string[]>()
    for (const id of members) {
      const key = id === this.selfId ? this.chat?.me ?? id : peers.get(id)?.key || id
      people.set(key, [...(people.get(key) ?? []), id])
    }
    return people
  }

  private voiceMember(
    key: string,
    ids: string[],
    peers: Map<string, MeshPeer>,
    logName: string,
    avatar: string,
  ): HTMLElement {
    const mine = ids.includes(this.selfId)
    const talking = ids.some((id) => this.voice?.isTalking(id))
    const peer = mine ? null : [...peers.values()].find((p) => ids.includes(p.id) && p.name)
    const name = mine ? this.chat?.displayName ?? 'You' : peer?.name || logName || shortKey(key)
    const label = mine ? `${name} (you)` : name
    const sharing = mine
      ? (this.capture !== null ? this.selfId : null)
      : (ids.find((id) => this.sharers.has(id)) ?? null)
    const id = sharing ?? ids[0]
    const watching = this.watched.has(id)
    const member = h('div', { class: `voice-member${talking ? ' talking' : ''}` })
    if (!mine) {
      member.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        openMenu(member, [{ custom: this.volumeBlock(key, name) }])
      })
      member.title = 'Right click for their volume'
    }
    const who = h('span', { class: 'truncate grow', text: label })
    const colour = this.chat?.levelOf(key).colour
    if (colour) who.style.color = colour
    member.append(h('i', { class: `dot ${talking ? 'talking' : 'good'}` }), avatarOf(key, name, avatar, 20), who)
    if (sharing !== null) {
      member.append(
        h('button', {
          class: `live-badge${watching ? ' on' : ''}`,
          text: 'LIVE',
          title: watching ? 'Stop watching' : `Watch ${label}`,
          ariaLabel: watching ? `Stop watching ${label}` : `Watch ${label}`,
          on: { click: () => this.watch(id) },
        }),
      )
    }
    return member
  }

  private renderVoiceBar(): void {
    const state = this.voice?.state
    this.voiceBar.classList.toggle('hidden', !state?.channel)
    if (state?.channel) {
      clear(this.voiceBar)
      this.voiceBar.append(
        h('div', { class: 'voice-bar-text' }, [
          h('span', { class: 'voice-bar-state' }, [h('i', { class: 'dot good' }), 'Voice connected']),
          h('span', {
            class: 'tiny faint truncate',
            text: isCallChannel(state.channel)
              ? `Call with ${this.chat?.nameOf(this.space.call?.with ?? '') || 'somebody'}`
              : `${state.channel} · ${(this.voice?.connected ?? 0) + 1} in`,
          }),
        ]),
        h(
          'button',
          {
            class: `ghost icon-only${state.muted ? ' danger on' : ''}`,
            title: state.muted ? 'Unmute' : 'Mute',
            ariaLabel: state.muted ? 'Unmute' : 'Mute',
            on: { click: () => this.voice?.setMuted(!state.muted) },
          },
          [icon(state.muted ? 'mic-off' : 'mic', 19)],
        ),
        this.shareButton,
        h(
          'button',
          {
            class: 'ghost icon-only danger',
            title: 'Leave voice',
            ariaLabel: 'Leave',
            on: { click: () => this.leaveVoice() },
          },
          [icon('phone-off', 19)],
        ),
      )
    }
    this.chatPanel.showSoundboard(Boolean(state?.channel))
  }

  private async joinVoice(name: string): Promise<void> {
    if (this.voice?.state.channel === name) return
    try {
      await this.space.joinVoice(name)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'bad', 9000)
      return
    }
    this.announceMe()
    this.draw()
  }

  private async onMoved(data: Record<string, unknown>): Promise<void> {
    const asked = typeof data.channel === 'string' ? data.channel : ''
    const by = typeof data.by === 'string' ? data.by : ''
    const at = typeof data.at === 'number' ? data.at : 0
    const sig = typeof data.sig === 'string' ? data.sig : ''
    const channel = cleanChannel(asked)
    if (!channel || !by || !sig || !this.room || !this.chat) return

    const me = loadIdentity().pubkey
    if (!(await verifyClaim(['vmove', this.room.id, me, asked, at], sig, by))) return
    if (!this.chat.authority().can(by, 'move')) return
    // Replay guard: the signed time must climb per admin key. Clocks differ, so it is not compared with ours.
    if (at <= (this.newestMoveBy.get(by) ?? 0)) return
    this.newestMoveBy.set(by, at)

    const who = this.chat.nameOf(by) || 'An admin'

    if (this.voice?.state.channel) {
      await this.voice.join(channel).catch(() => undefined)
      toast(`${who} moved you to ${channel}`, 'good', 5000)
      this.announceMe()
      this.draw()
      return
    }

    // A browser opens a microphone only on a user gesture, so this offers instead.
    toast(`${who} asked you to join ${channel}`, 'good', 12_000, {
      label: 'Join',
      run: () => void this.joinVoice(channel),
    })
  }

  private async callPerson(key: string): Promise<void> {
    try {
      await this.space.startCall(key)
      this.openDirect(key)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The call could not start.', 'warn', 6000)
    }
  }

  private leaveVoice(): void {
    if (this.capture) this.stopSharing()
    this.space.leaveVoice()
    this.announceMe()
    this.draw()
  }

  private async moveTo(key: string, channel: string): Promise<void> {
    if (!this.room) return
    const peer = this.mesh?.peers().find((p) => p.key === key)
    if (!peer) {
      toast('They are not here right now.', 'warn', 4000)
      return
    }
    const by = loadIdentity().pubkey
    const at = Date.now()
    const sig = await signClaim(['vmove', this.room.id, key, channel, at])
    void this.bus?.send({ type: 'vmove', to: peer.id, data: { channel, by, at, sig } })
    toast(`Asked them to join ${channel}`, 'good', 4000)
  }

  private personMenu(key: string, role: string, you: boolean, here: boolean): MenuEntry[] {
    const actions = this.actionsFor(key, role, you, here)
    const talks = !you && (this.mesh?.peers() ?? []).some((p) => p.key === key && this.voice?.whereIs(p.id))
    if (!talks) return actions
    const name = this.chat?.nameOf(key) || shortKey(key)
    return actions.length ? [{ custom: this.volumeBlock(key, name) }, 'line', ...actions] : [{ custom: this.volumeBlock(key, name) }]
  }

  private volumeBlock(key: string, name: string): HTMLElement {
    const value = h('span', { class: 'tiny faint' })
    const range = h('input', { type: 'range', min: '0', max: '100', step: '1', ariaLabel: `Volume for ${name}` })
    range.value = String(Math.round(volumeFor(key) * 100))
    const mute = h('button', { class: 'switch-row menu-switch', role: 'switch' }, [
      h('span', { class: 'switch-words' }, [h('span', { class: 'switch-label', text: 'Mute' })]),
      h('span', { class: 'switch' }, [h('i')]),
    ])
    const paint = (): void => {
      const muted = mutedFor(key)
      value.textContent = muted ? 'Muted' : `${range.value}%`
      mute.setAttribute('aria-checked', String(muted))
      range.classList.toggle('muted', muted)
    }
    range.addEventListener('input', () => {
      setVolumeFor(key, Number(range.value) / 100)
      if (mutedFor(key)) setMutedFor(key, false)
      paint()
    })
    mute.addEventListener('click', () => {
      setMutedFor(key, !mutedFor(key))
      paint()
    })
    paint()
    return h('div', { class: 'menu-volume' }, [
      h('div', { class: 'row spread' }, [h('span', { class: 'menu-volume-label', text: `${name}’s volume` }), value]),
      range,
      mute,
    ])
  }

  private actionsFor(key: string, role: string, you: boolean, here: boolean): MenuEntry[] {
    const chat = this.chat
    if (!chat || you) return []
    const items: MenuEntry[] = []
    const logName = chat.nameOf(key)
    const name = logName || shortKey(key)

    items.push({
      label: 'Message',
      note: 'Privately, sealed to the two of you',
      run: () => this.openDirect(key),
    })
    if (here) {
      items.push({
        label: 'Call',
        note: 'A voice call, just the two of you',
        run: () => void this.callPerson(key),
      })
    }
    if (logName) {
      items.push({
        label: 'Mention',
        note: 'Puts @' + name + ' in the message you are writing',
        run: () => {
          this.chatPanel.insert(`@${name} `)
          this.chatPanel.focus()
        },
      })
    }
    const auth = chat.authority()
    const me = chat.me
    const standing = this.voice?.state.channel
    if (here && standing && auth.can(me, 'move')) {
      items.push({
        label: `Move to ${standing}`,
        note: 'Asks their device to join the voice channel you are in',
        run: () => void this.moveTo(key, standing),
      })
    }
    if (role !== 'kicked' && auth.mayPlace(me, key)) {
      const mine = auth.levelOf(me).rank
      const current = auth.levelOf(key).id
      const choices = auth.list().filter((l) => l.id !== OWNER && l.rank <= mine)
      if (choices.length > 1) {
        items.push('line', { heading: 'Level' })
        for (const level of choices) {
          items.push({
            label: level.name,
            lead: levelDot(level.colour),
            current: level.id === current,
            run: () => {
              if (level.id !== current) void this.setRole(key, level.id)
            },
          })
        }
      }
    }
    if (auth.mayRemove(me, key)) {
      items.push('line')
      if (role === 'kicked') {
        items.push({
          label: 'Unban',
          run: () => void this.setRole(key, MEMBER),
        })
      } else {
        items.push({
          label: 'Remove',
          note: 'Everything they write after this is ignored by everybody',
          danger: true,
          run: () => {
            if (!window.confirm(`Remove ${name} from this space?`)) return
            void this.setRole(key, 'kicked')
          },
        })
      }
    }
    return items
  }

  private announceMe(): void {
    this.mesh?.announce()
  }

  private roster(): PersonRow[] {
    const chat = this.chat
    const rows = new Map<string, PersonRow>()

    const put = (key: string, patch: Partial<PersonRow>): void => {
      const was = rows.get(key)
      rows.set(key, {
        key,
        name: '',
        here: false,
        talking: false,
        sharing: false,
        voice: null,
        you: false,
        away: false,
        ...was,
        ...patch,
      })
    }

    const seen = chat?.lastSeen() ?? new Map<string, number>()
    const cutoff = Date.now() - RECENT_MS
    for (const [key, name] of chat?.log.names() ?? []) {
      if ((seen.get(key) ?? 0) < cutoff) continue
      put(key, { name })
    }

    put(chat?.me ?? 'you', {
      name: chat?.displayName ?? 'You',
      here: true,
      you: true,
      away: document.hidden,
      sharing: this.capture !== null,
      voice: this.voice?.state.channel ?? null,
      talking: this.voice?.isTalking(this.selfId) ?? false,
    })

    for (const peer of this.mesh?.peers() ?? []) {
      const key = peer.key || peer.id
      const was = rows.get(key)
      put(key, {
        name: peer.name || was?.name || '',
        here: true,
        away: this.away.has(peer.id) && !(was?.here && !was.away),
        sharing: this.sharers.has(peer.id) || was?.sharing === true,
        voice: this.voice?.whereIs(peer.id) ?? was?.voice ?? null,
        talking: this.voice?.isTalking(peer.id) === true || was?.talking === true,
      })
    }

    dropOtherDeviceRows(rows, chat?.displayName ?? '')

    const auth = chat?.authority()
    const rank = new Map([...rows.keys()].map((key) => [key, auth?.levelOf(key).rank ?? 0]))
    return [...rows.values()].sort((a, b) => {
      if (a.you !== b.you) return a.you ? -1 : 1
      if (a.here !== b.here) return a.here ? -1 : 1
      const byRank = (rank.get(b.key) ?? 0) - (rank.get(a.key) ?? 0)
      if (byRank !== 0) return byRank
      return (a.name || a.key).localeCompare(b.name || b.key)
    })
  }

  private renderPeople(order: PersonRow[]): void {
    clear(this.peopleList)
    const chat = this.chat
    const roles = chat?.roles() ?? new Map<string, string>()
    const avatars = chat?.log.avatars() ?? new Map<string, string>()

    const visible = order.filter((r) => (roles.get(r.key) ?? 'member') !== 'kicked' || r.you)
    const hereCount = visible.filter((r) => r.here).length
    const awayCount = visible.length - hereCount
    this.peopleList.append(
      h('div', { class: 'rail-head' }, [h('span', { class: 'eyebrow', text: `Here · ${hereCount}` })]),
    )
    let drawnOffline = false
    for (const row of order) {
      if (!row.here && !drawnOffline) {
        drawnOffline = true
        this.peopleList.append(
          h('div', { class: 'rail-head' }, [h('span', { class: 'eyebrow', text: `Away · ${awayCount}` })]),
        )
      }
      const role = roles.get(row.key) ?? 'member'
      if (role === 'kicked' && !row.you) continue
      this.peopleList.append(this.personRow(row, role, avatars.get(row.key) ?? ''))
    }
  }

  private personRow(row: PersonRow, role: string, avatar: string): HTMLElement {
    const label = row.name || shortKey(row.key)
    const level = this.chat?.levelOf(row.key)
    const shown = h('span', { class: 'truncate', text: row.you ? `${label} (you)` : label })
    if (level?.colour) shown.style.color = level.colour

    let more: HTMLButtonElement | null = null
    if (!row.you) {
      const button = h('button', {
        class: 'ghost tiny-btn person-more',
        title: `What you can do about ${label}`,
        ariaLabel: `Actions for ${label}`,
        data: { menu: `person:${row.key}` },
      })
      onPress(button, () => openMenu(button, this.personMenu(row.key, role, row.you, row.here)))
      button.append(icon('more', 17))
      more = button
    }

    const rowClass = `rail-person${row.here ? '' : ' away'}${row.talking ? ' talking' : ''}`
    return h('div', { class: rowClass, title: `${level?.name ?? 'Member'} · ID ${row.key}` }, [
      h('span', { class: 'person-face' }, [
        avatarOf(row.key, row.name, avatar, 32),
        row.here
          ? h('i', {
              class: `dot ${row.away ? 'warn' : 'good'}`,
              title: row.away ? 'Here, but looking at something else' : 'Here',
            })
          : null,
      ]),
      h('div', { class: 'person-text' }, [
        h('div', { class: 'row person-line' }, [
          shown,
          role === OWNER
            ? h('span', { class: 'crown', title: 'Made this space' }, [icon('crown', 12)])
            : null,
          role === 'kicked' ? h('span', { class: 'tiny faint', text: 'removed' }) : null,
        ]),
        this.personDoing(row),
      ]),
      more,
    ])
  }

  private personDoing(row: PersonRow): HTMLElement | null {
    if (row.sharing) {
      return h('span', { class: 'person-doing live' }, [h('i', { class: 'live-dot' }), 'Sharing their screen'])
    }
    if (!row.voice) return null
    return h('span', { class: `person-doing${row.talking ? ' talking' : ''}` }, [
      icon('volume-low', 11),
      isCallChannel(row.voice)
        ? row.talking
          ? 'Talking in a call'
          : 'In a call'
        : row.talking
          ? `Talking in ${row.voice}`
          : `In ${row.voice}`,
    ])
  }

  private async findGifs(term: string): Promise<{ gifs: Gif[]; from: string }> {
    if (!this.server || !(await serverHasGifs(this.server))) return { gifs: [], from: '' }
    return serverGifs(this.server, term)
  }

  private async openGifPicker(term: string): Promise<void> {
    if (this.gifClose) {
      this.gifClose()
      if (!term) return
    }
    const grid = h('div', { class: 'gif-grid' })
    const status = h('div', { class: 'tiny faint' })
    const box = h('input', {
      type: 'text',
      class: 'gif-search',
      placeholder: 'Search GIFs',
      ariaLabel: 'Search GIFs',
      value: term.trim(),
    })

    const pop = h('div', { class: 'gif-pop', role: 'dialog', ariaLabel: 'GIFs' }, [
      h('div', { class: 'row spread' }, [
        h('span', { class: 'eyebrow', text: 'GIFs' }),
        h('button', {
          class: 'ghost tiny-btn',
          text: '×',
          title: 'Close',
          ariaLabel: 'Close the GIF picker',
          on: { click: () => done() },
        }),
      ]),
      box,
      grid,
      status,
    ])

    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        done()
      }
    }
    const onAway = (ev: PointerEvent): void => {
      const target = ev.target as Node
      if (pop.contains(target) || this.chatPanel.gifAnchor.contains(target)) return
      done()
    }
    let timer: number | null = null
    const done = (): void => {
      if (this.gifClose === done) this.gifClose = null
      if (timer !== null) window.clearTimeout(timer)
      pop.remove()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onAway, true)
      window.removeEventListener('resize', place)
    }
    const place = (): void => {
      const at = this.chatPanel.gifAnchor.getBoundingClientRect()
      if (at.width === 0) return
      pop.classList.add('placed')
      const width = pop.offsetWidth
      pop.style.left = `${Math.round(Math.max(8, Math.min(at.right - width, window.innerWidth - width - 8)))}px`
      pop.style.bottom = `${Math.round(window.innerHeight - at.top + 8)}px`
      pop.style.maxHeight = `${Math.round(at.top - 16)}px`
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onAway, true)

    const send = (url: string): void => {
      done()
      void this.publish((c) => c.say(url, this.channel))
    }

    let asking = 0
    const run = async (): Promise<void> => {
      const mine = ++asking
      const wanted = box.value.trim()
      status.textContent = 'Looking...'
      const { gifs, from } = await this.findGifs(wanted)
      if (mine !== asking || !pop.isConnected) return
      clear(grid)
      for (const g of gifs) {
        const cell = gifCell(g)
        cell.addEventListener('click', () => send(g.url))
        grid.append(cell)
      }
      if (gifs.length > 0) {
        status.textContent = `${wanted ? `Results for "${wanted}"` : 'Popular now'}, from ${from}.`
        return
      }
      clear(status)
      status.append(...this.gifTrouble(wanted, from))
    }

    box.addEventListener('input', () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void run(), 400)
    })
    box.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key !== 'Enter') return
      ev.preventDefault()
      if (timer !== null) window.clearTimeout(timer)
      void run()
    })

    document.body.append(pop)
    this.gifClose = done
    place()
    window.addEventListener('resize', place)
    box.focus()
    await run()
  }

  private gifTrouble(wanted: string, from: string): (string | Node)[] {
    if (from === '') {
      return [
        this.server
          ? `GIF search is off on ${serverTag(this.server)}. Whoever runs it turns it on with a key; see server/README.md.`
          : 'GIF search needs a server, and this space has none.',
      ]
    }
    if (!wanted) return ['Nothing came back. Type what to look for.']
    return [`Nothing for "${wanted}" from ${from}. Try other words.`]
  }

  private openPins(): void {
    const chat = this.chat
    if (!chat) return
    const pinned = chat.messages(this.channel).filter((m) => m.pinned)
    openMenu(
      this.pinsButton,
      pinned.map((m) => ({
        label: m.text.slice(0, 60) || 'a message with no text',
        note: m.name || shortKey(m.author),
        run: () => this.goTo(m),
      })),
    )
  }

  private openChannel(name: string): void {
    this.showRail(null)
    if (name === this.channel && !this.thread) return
    this.chatPanel.keepDraft()
    this.channel = name
    this.thread = null
    this.chatPanel.setThread(null)
    this.chatPanel.setDirect(null)
    this.chatPanel.useDraft(name)
    this.readWhenOpened = this.read[name] ?? 0
    this.stopWatching()
    this.draw()
  }

  /** "/poll Tea or coffee? tea, coffee, neither" in one line, or prompts for what is missing. */
  private async newPoll(line = ''): Promise<void> {
    const mark = line.search(/[?]/)
    let question = mark === -1 ? '' : line.slice(0, mark + 1).trim()
    let raw = mark === -1 ? '' : line.slice(mark + 1).trim()
    if (!question) question = window.prompt('What is the question?', line)?.trim() ?? ''
    if (!question) return
    if (!raw) raw = window.prompt('The answers, separated by commas.', 'Yes, No')?.trim() ?? ''
    if (!raw) return
    const options = raw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
    if (options.length < 2) {
      toast('A poll needs at least two answers.', 'warn')
      return
    }
    await this.publish((c) => c.askPoll(question, options, this.channel))
  }

  private async resetSpace(): Promise<void> {
    const ok = window.confirm(
      'Clear the history in this space for everybody?\n\n' +
        'Messages, polls and pins go, on every device that is in the space or ' +
        'joins it later. Names, channels and who runs the place stay.\n\n' +
        (this.server
          ? 'The server stops handing the old history to anybody. A copy somebody already saved stays theirs.'
          : 'Anybody who has already saved a copy of the history keeps it. There is ' +
            'no server to take it back from them.'),
    )
    if (!ok) return
    await this.publish((c) => c.reset())
    toast('The history is cleared.', 'good')
    this.draw()
  }

  private async newChannel(voice: boolean): Promise<void> {
    if (!this.chat?.can('channels')) {
      toast('Your level cannot make channels.', 'warn')
      return
    }
    const raw = window.prompt(voice ? 'Name the voice channel' : 'Name the channel')
    if (raw === null) return
    const name = cleanChannel(raw)
    if (!name) {
      toast('A channel name needs a letter or a number in it.', 'warn')
      return
    }
    await this.publish((c) => c.makeChannel(name, voice))
    if (!voice) this.openChannel(name)
    else this.draw()
  }

  private renderShareButton(): void {
    const sharing = this.capture !== null
    if (this.shareButtonSharing !== sharing) {
      this.shareButtonSharing = sharing
      clear(this.shareButton)
      this.shareButton.setAttribute('aria-label', sharing ? 'Stop sharing' : 'Share screen')
      this.shareButton.title = sharing ? 'Stop sharing your screen' : 'Share your screen with this voice channel'
      this.shareButton.append(icon(sharing ? 'stop' : 'monitor', sharing ? 16 : 19))
      this.shareButton.classList.toggle('danger', sharing)
      this.shareButton.classList.toggle('on', sharing)
    }
    this.stage.classList.toggle('hidden', this.watched.size === 0)
    this.renderStreams()
  }

  private async toggleShare(): Promise<void> {
    if (this.capture) {
      this.stopSharing()
      this.draw()
      return
    }
    if (!this.voice?.state.channel) {
      toast('Join a voice channel to share your screen.', 'info')
      return
    }
    const blocker = hostBlocker(checkSupport())
    if (blocker) {
      toast(blocker, 'bad', 8000)
      return
    }
    try {
      this.capture = await captureScreen({
        maxHeight: this.settings.maxHeight,
        fps: this.settings.fps,
        wantSystemAudio: this.settings.shareSystemAudio,
      })
    } catch (err) {
      if (!(err instanceof CaptureError) || err.kind !== 'denied') {
        toast(err instanceof CaptureError ? err.message : String(err), 'bad', 8000)
      }
      return
    }

    this.mixer = new AudioMixer()
    await this.mixer.resume()
    this.mixer.attachSystem(
      this.capture.systemAudio ? new MediaStream([this.capture.systemAudio]) : null,
    )
    this.outStream = new MediaStream([this.capture.video, this.mixer.track])
    this.capture.video.addEventListener('ended', () => {
      if (this.capture) {
        this.stopSharing()
        this.draw()
      }
    })

    this.showOwnPreview()
    this.announceMe()
    this.draw()
  }

  private stopSharing(): void {
    for (const peer of this.watchers.values()) peer.close()
    this.watchers.clear()
    this.capture?.stream.getTracks().forEach((t) => t.stop())
    this.capture = null
    this.mixer?.close()
    this.mixer = null
    this.outStream = null
    this.dropTile(this.selfId)
    this.announceMe()
  }

  private closeWatcher(id: string): void {
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
  }

  private admitWatcher(peerId: string): void {
    if (!this.outStream) return
    const peer = new HostPeer({
      viewerId: peerId,
      stream: this.outStream,
      mode: this.settings.mode,
      codec: this.settings.codec,
      hardware: this.gpu.hardware,
      send: (type, data) =>
        void this.bus?.send({
          type,
          to: peerId,
          data: type === 'ice' ? { ...(data as Record<string, unknown>), side: 'host' } : data,
        }),
      onChange: () => this.draw(),
      onFailed: (reason) => toast(reason, 'bad', 8000),
    })
    this.watchers.set(peerId, peer)
    void peer.setPlan(this.plan(this.watchers.size))
  }

  private liveHere(peers: Map<string, MeshPeer>): LiveStream[] {
    const out: LiveStream[] = []
    if (this.capture) {
      out.push({ id: this.selfId, name: 'Your screen', you: true, key: this.chat?.me ?? '' })
    }
    for (const id of this.sharers.keys()) {
      if (id === this.selfId) continue
      const peer = peers.get(id)
      out.push({ id, name: peer?.name || shortKey(id), you: false, key: peer?.key ?? '' })
    }
    return out
  }

  private sharerByKey(key: string): string | null {
    const peers = this.peersById()
    for (const id of this.sharers.keys()) {
      if (id !== this.selfId && peers.get(id)?.key === key) return id
    }
    return null
  }

  private joinStream(key: string): void {
    const id = this.sharerByKey(key)
    if (!id) {
      toast('That stream has ended.', 'warn')
      return
    }
    if (!this.watched.has(id)) this.watch(id)
  }

  private watch(peerId: string): void {
    if (this.watched.has(peerId)) {
      this.dropTile(peerId)
      this.announceMe()
      this.draw()
      return
    }
    if (peerId === this.selfId) {
      if (!this.outStream) return
      const entry = this.addTile(peerId)
      entry.surface.setStream(this.outStream)
      entry.tile.append(this.qualityMenu())
      this.draw()
      return
    }
    const entry = this.addTile(peerId)
    entry.peer = new ViewerPeer({
      send: (type, data) =>
        void this.bus?.send({
          type,
          to: peerId,
          data: type === 'ice' ? { ...(data as Record<string, unknown>), side: 'viewer' } : data,
        }),
      onStream: (stream) => {
        entry.surface.setStream(stream)
        void entry.surface.tryUnmute().then((got) => {
          if (!got) entry.surface.setSoundPrompt(() => void entry.surface.tryUnmute())
        })
      },
      onChange: () => this.draw(),
      onFailed: (reason) => toast(reason, 'bad', 8000),
    })
    void this.bus?.send({ type: 'hello', to: peerId })
    this.announceMe()
    this.draw()
  }

  private addTile(id: string): StageTile {
    const surface = new VideoSurface({ muted: true, showVolume: true })
    const tag = h('div', { class: 'stage-tag' })
    const tile = h('div', { class: 'stage-tile' }, [surface.root, tag])
    this.stage.append(tile)
    const entry: StageTile = { peer: null, surface, tile, tag }
    this.watched.set(id, entry)
    this.stage.classList.remove('hidden')
    return entry
  }

  private dropTile(id: string): void {
    const entry = this.watched.get(id)
    if (!entry) return
    entry.peer?.close()
    entry.surface.destroy()
    entry.tile.remove()
    this.watched.delete(id)
    if (this.watched.size === 0) this.stage.classList.add('hidden')
  }

  private watcherNames(sharer: string, peers: Map<string, MeshPeer>): string[] {
    const names = new Set<string>()
    const note = (session: string): void => {
      const p = peers.get(session)
      names.add(p ? p.name || shortKey(p.key || session) : shortKey(session))
    }
    for (const [session, targets] of this.watchingBy) {
      if (targets.includes(sharer) && session !== this.selfId) note(session)
    }
    if (sharer === this.selfId) for (const id of this.watchers.keys()) note(id)
    return [...names]
  }

  private renderStreams(): void {
    const peers = this.peersById()
    const live = this.liveHere(peers)
    clear(this.streamBar)
    this.streamBar.classList.toggle('hidden', live.length === 0)

    for (const [id, entry] of this.watched) {
      if (id === this.selfId) {
        const eyes = this.watcherNames(this.selfId, peers)
        entry.tag.textContent = eyes.length ? `Your screen · ${eyes.length} watching` : 'Your screen'
        entry.tag.title = eyes.length ? `Watching: ${eyes.join(', ')}` : 'Nobody is watching yet'
      } else {
        const whose = live.find((l) => l.id === id)?.name ?? 'a shared screen'
        entry.tag.dataset.who = whose
        if (!entry.tag.textContent?.startsWith(whose)) entry.tag.textContent = whose
      }
    }
    if (live.length === 0) return

    this.streamBar.append(h('span', { class: 'eyebrow', text: 'Live' }))
    for (const one of live) {
      const label = one.you
        ? this.watchers.size > 0
          ? `Your screen · ${this.watchers.size} watching`
          : 'Your screen'
        : one.name
      const eyes = this.watcherNames(one.id, peers)
      const tab = h(
        'button',
        {
          class: `stream-tab${this.watched.has(one.id) ? ' on' : ''}`,
          title: (one.you ? 'Show your own screen' : `Watch ${one.name}`) + (eyes.length ? `. Watching: ${eyes.join(', ')}` : ''),
          on: { click: () => this.watch(one.id) },
        },
        [
          avatarOf(one.key || one.id, one.you ? (this.chat?.displayName ?? '') : one.name, this.chat?.avatarOf(one.key) ?? '', 18),
          h('span', { class: 'truncate', text: label }),
          h('span', { class: 'live-dot', title: 'Live' }),
        ],
      )
      tab.dataset.watch = one.you ? 'self' : 'peer'
      this.streamBar.append(tab)
    }

    if (this.watched.size > 0) {
      this.streamBar.append(
        h('button', {
          class: 'stream-tab quiet',
          text: 'Close',
          title: 'Stop watching. Escape does the same.',
          on: {
            click: () => {
              this.stopWatching()
              this.draw()
            },
          },
        }),
      )
    }
  }

  private stopWatching(): void {
    const was = this.watchingAnyone()
    for (const id of [...this.watched.keys()]) this.dropTile(id)
    if (was) this.announceMe()
  }

  private showOwnPreview(): void {
    const held = this.watched.get(this.selfId)
    if (held) held.surface.setStream(this.outStream)
    else this.watch(this.selfId)
  }

  private plan(watchers: number): QualityPlan {
    const s = this.capture?.video.getSettings()
    return planFor({
      mode: this.settings.mode,
      budgetKbps: this.settings.budgetAuto ? this.uplink.estimateKbps : this.settings.budgetKbps,
      viewerCount: Math.max(1, watchers),
      width: s?.width ?? 1920,
      height: s?.height ?? 1080,
      fps: this.settings.fps,
      bitrateScale: this.settings.bitrateScale,
    })
  }

  private async tick(): Promise<void> {
    const peers = [...this.watchers.values()]
    if (peers.length) {
      await Promise.all(peers.map((p) => p.sample()))
      const live = peers.filter((p) => p.state === 'connected' && p.stats.kbps > 0)
      if (live.length) {
        this.uplink.observe({
          demandKbps: this.plan(1).maxBitrateKbps * live.length,
          sendingKbps: live.reduce((n, p) => n + p.stats.kbps + p.stats.audioKbps, 0),
          availableKbps: live.reduce((n, p) => n + p.stats.availableOutKbps, 0),
          lossPct: live.reduce((n, p) => n + p.stats.lossPct, 0) / live.length,
        })
      }
      const plan = this.plan(peers.length)
      for (const peer of peers) await peer.setPlan(plan)
    }
    for (const [id, entry] of this.watched) {
      if (id === this.selfId || !entry.peer) continue
      const s = await entry.peer.sample()
      const size = s.height ? ` · ${s.height}p` : ''
      entry.tag.textContent = `${entry.tag.dataset.who ?? ''}${size}`
      entry.tile.title = `${s.width}x${s.height}, ${s.fps} fps, ${fmtKbps(s.kbps)}${s.codec ? `, ${s.codec}` : ''}`
    }
  }

  private qualityMenu(): HTMLElement {
    const pick = h('select', { class: 'share-quality', ariaLabel: 'Stream quality', title: 'What you are sharing' })
    for (const preset of PRESETS) {
      const option = h('option', { value: preset.id, text: preset.name })
      if (this.settings.presetId === preset.id) option.selected = true
      pick.append(option)
    }
    pick.addEventListener('change', () => void this.applyPreset(pick.value as PresetId))
    return pick
  }

  private async applyPreset(id: PresetId): Promise<void> {
    const preset = presetById(id)
    if (!preset) return
    this.settings = {
      ...this.settings,
      presetId: preset.id,
      mode: preset.mode,
      maxHeight: preset.maxHeight,
      fps: preset.fps,
      bitrateScale: preset.bitrateScale,
    }
    saveSettings(this.settings)
    for (const peer of this.watchers.values()) {
      peer.setMode(preset.mode, this.settings.codec as CodecChoice, this.gpu.hardware)
    }
    await this.applyConstraints()
  }

  private async applyConstraints(): Promise<void> {
    const track = this.capture?.video
    if (!track) return
    const constraints: MediaTrackConstraints = {
      frameRate: { ideal: this.settings.fps, max: this.settings.fps },
    }
    if (this.settings.maxHeight > 0) {
      constraints.height = { max: this.settings.maxHeight }
      constraints.width = { max: Math.round((this.settings.maxHeight * 16) / 9) }
    }
    await track.applyConstraints(constraints).catch(() => undefined)
  }
}
