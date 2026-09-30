import { checkSupport, hostBlocker } from '../diagnostics'
import { captureScreen, CaptureError, type ScreenCapture } from '../media/capture'
import { AudioMixer } from '../media/mixer'
import type { Mesh, MeshPeer } from '../net/mesh'
import type { Voice } from '../net/voice'
import { UplinkMeter } from '../net/uplink'
import { PLAYING_CHANGED, cleanGameName, cleanSteamId, playingNow, type Playing } from '../net/playing'
import { LOUDEST, mutedFor, setMutedFor, setVolumeFor, volumeFor } from '../net/volume'
import { gifs as serverGifs, preview, serverHasGifs } from '../net/server-api'
import { formatSecret, newPass, roomLink, setLinkSecret, type Room } from '../room'
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
import { gifLink, isClip, type Gif } from '../store/gifs'
import {
  DEFAULT_CHANNEL,
  DEFAULT_VOICE,
  MAX_SPACE_PICTURE,
  MEMBER,
  OWNER,
  cleanChannel,
  type ChannelInfo,
  type LogEvent,
  type Message,
  type NoteInfo,
} from '../store/log'
import type { RoomChat } from '../store/room-chat'
import { filesFor, isCallChannel, type SpaceRuntime } from '../space/runtime'
import { spaces } from '../space/registry'
import { spaceFace, switcherButton } from './space-switcher'
import { voiceDock } from './call'
import { chirpMention, chirpMessage, chirpStream, isNews, speak } from './sounds'
import type { LinkQuality } from '../net/voice'
import { CUSTOM, CUSTOM_MAX_S, decodeClip, openSoundboard, playClip, type Sound } from './soundboard'
import { ask, askChannel, askSound, confirmDanger, pickSome } from './ask'
import { saveScreen } from '../store/screen'
import { channelMuted, channelMutedItself, MUTED_CHANGED, muteChannel, muteSpace, spaceMuted } from '../store/mute'
import { cleanPresence, cleanStatusText, loadStatus, presenceLook, STATUS_CHANGED, type Presence } from '../store/status'
import { avatarOf, ChatPanel, imageLinks } from './chat-panel'
import { clear, copyText, fmtKbps, h, onPress, roleInk } from './dom'
import { desktopOffer } from './desktop-offer'
import { forHowLong, gameCard } from './game-card'
import { ghost } from './ghost'
import { icon, type IconName } from './icons'
import { myStatusDot, openStatusMenu } from './status-menu'
import { closeMenu, onContextMenu, openMenu, type MenuItem, type MenuEntry } from './menu'
import { viewArea } from './place'
import type { MemberRow } from './space-settings'
import { actionFor, type Action } from './shortcuts'
import { NoteEditor } from './notes-view'
import { placeNear } from './emoji'
import { loadAvatar, squareThumb } from './avatar'
import { setTitleFace, type WindowChrome } from './shell'
import { toast } from './toast'
import { VideoSurface } from './video-surface'

const RECENT_MS = 14 * 24 * 60 * 60 * 1000
const STATS_MS = 2000
/** After the history is in, how long a remembered channel may still turn up. */
const RESUME_GIVE_UP_MS = 5000
const SOUND_EVERY_MS = 120
/** How long the ring shows when the length of the sound is not known here. */
const SOUND_RING_S = 1.5
const LINK_EVERY_MS = 3000

/** 4:05, or 1:04:05 past the hour. */
function clockFor(ms: number): string {
  const all = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(all / 3600)
  const minutes = Math.floor((all % 3600) / 60)
  const seconds = String(all % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}
const MAX_SOUND_BYTES = 2 * 1024 * 1024
const TTS_EVERY_MS = 5000
const TTS_MAX_CHARS = 280
const TYPING_EVERY_MS = 2000
const TYPING_FOR_MS = 5000
const SEARCH_LIMIT = 40
const WATCHING_MAX = 12
const SERVER_SILENCE_MS = 10_000
/** How long a newcomer waits for the space's key before they are told why it may not come. */
const KEY_WAIT_MS = 20_000
/** A volume this close to 100% is 100%. */
const SNAP_PERCENT = 4

interface PersonRow {
  key: string
  name: string
  here: boolean
  talking: boolean
  sharing: boolean
  voice: string | null
  you: boolean
  away: boolean
  playing: Playing | null
  status: Presence
  statusText: string
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
    const clip = h('video', { class: 'gif-choice gif-skeleton' })
    clip.addEventListener('loadeddata', () => clip.classList.remove('gif-skeleton'), { once: true })
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
  const img = h('img', { class: 'gif-choice gif-skeleton' })
  img.addEventListener('load', () => img.classList.remove('gif-skeleton'), { once: true })
  img.src = g.preview
  img.alt = ''
  img.loading = 'lazy'
  img.referrerPolicy = 'no-referrer'
  return img
}

/** What a share from outside voice is kept under: no channel name can be this. */
const NO_VOICE = '*'
/** A share heard of this soon after it started has just started, and plays its sound. */
const SHARE_NEW_MS = 10_000

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
  /** The channel you were in before a reload or a restart, opened once it has loaded. */
  private wantChannel: string | null = null
  /** The channel being dragged to a new place. Its list is not drawn again until the drag ends. */
  private channelDrag: { name: string; voice: boolean } | null = null
  /** The key of somebody being dragged into a voice channel. The lists wait for the drop. */
  private personDrag: string | null = null
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
  private settingsOpen: 'user' | 'space' | null = null

  private capture: ScreenCapture | null = null
  /** When this page's share started, by this clock. */
  private sharedAt = 0
  private mixer: AudioMixer | null = null
  private outStream: MediaStream | null = null
  private readonly watchers = new Map<string, HostPeer>()
  private gpu: HardwareProbe = NO_HARDWARE
  private readonly uplink = new UplinkMeter()

  private readonly watched = new Map<string, StageTile>()
  private readonly sharers = new Map<string, string>()
  private streamBar!: HTMLDivElement
  private offline: HTMLDivElement | null = null

  private readonly newestMoveBy = new Map<string, number>()
  private readonly watchingBy = new Map<string, string[]>()
  private soundSentAt = 0
  private readonly clips = new Map<string, Promise<AudioBuffer | null>>()
  private readonly soundHeard = new Map<string, number>()
  /** Sessions whose soundboard sound is playing now, for the ring round their face. */
  private readonly sounding = new Map<string, { until: number; label: string }>()
  private ttsSentAt = 0
  private readonly ttsHeard = new Map<string, number>()
  private serverWarned = false
  private serverTimer: number | null = null

  private channelList!: HTMLDivElement
  private voiceList!: HTMLDivElement
  private newTextButton!: HTMLButtonElement
  private newVoiceButton!: HTMLButtonElement
  private threadList!: HTMLDivElement
  private noteList!: HTMLDivElement
  private noteEditor!: NoteEditor
  /** The note on screen in place of the chat, if any. */
  private noteId: string | null = null
  private peopleList!: HTMLDivElement
  private voiceBar!: HTMLDivElement
  private shell!: HTMLElement
  private stage!: HTMLDivElement
  private shareButton!: HTMLButtonElement
  private railShareButton!: HTMLButtonElement
  /** Where Share your screen goes, once the space is open. */
  private shareStart!: HTMLDivElement
  private shareList!: HTMLDivElement
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
  private peopleSlide: Animation | null = null
  private railOpen: 'left' | 'right' | null = null

  private thread: string | null = null
  private read: Record<string, number> = {}
  private readWhenOpened = 0
  private readonly away = new Set<string>()
  /** What each session says of itself: idle, do not disturb, invisible, and its own words. */
  private readonly statusBy = new Map<string, { mode: Presence; text: string }>()
  /** Sessions in voice that have muted or deafened themselves. */
  private readonly quiet = new Map<string, 'muted' | 'deafened'>()
  /** Sessions in voice with their camera on. */
  private readonly filming = new Set<string>()
  private cameras!: HTMLDivElement
  private cameraButton!: HTMLButtonElement
  private readonly cameraTiles = new Map<string, { tile: HTMLElement; video: HTMLVideoElement; tag: HTMLElement; track: MediaStreamTrack | null }>()
  /** The newest look at the voice connection, taken every few seconds while in voice. */
  private link: {
    peers: LinkQuality[]
    pingMs: number | null
    jitterMs: number | null
    lossPct: number | null
    serverMs: number | null
  } | null = null
  private linkBusy = false
  /** When each session in voice came into its channel, by our clock. */
  private readonly voiceSince = new Map<string, number>()
  /** The game each session says it plays, and since when by our clock. */
  private readonly playingBy = new Map<string, Playing>()
  private readonly boardButton = h(
    'button',
    {
      class: 'voice-tool voice-board',
      title: 'Soundboard: only the people in your voice channel hear it',
      ariaLabel: 'Soundboard',
    },
    [icon('music', 19)],
  )
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
    // Nobody gave us the space's newest key: most likely an old invite, after a ban.
    window.setTimeout(() => {
      if (this.stopped || !space.waitingForKey()) return
      toast('Nobody has let you in yet. If somebody was banned here, an old invite no longer works: ask for a new link.', 'warn', 15_000)
    }, KEY_WAIT_MS)
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
    saveScreen({ kind: 'space', room: space.room.id, channel: this.wantChannel ?? this.channel })

    void fetchIce(this.server).then((ice) => {
      if (!this.stopped) useServedIce(ice.iceServers, ice.relayOnly)
    })
    this.voice = space.voice

    space.extras = () => ({
      // The voice channel, or true for a share from outside voice.
      sharing: this.capture ? (this.voice?.state.channel ?? true) : undefined,
      // How long, not since when: the clocks of two devices differ.
      sharingFor: this.capture ? Math.max(0, Date.now() - this.sharedAt) : undefined,
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
    this.timers.push(window.setInterval(() => this.tickTimers(), 1000))
    this.timers.push(window.setInterval(() => void this.sampleLink(), LINK_EVERY_MS))
    this.boardButton.addEventListener('click', () => this.openBoard(this.boardButton))
    document.addEventListener('visibilitychange', this.onVisible)
    window.addEventListener(PLAYING_CHANGED, this.onPlaying)
    window.addEventListener(MUTED_CHANGED, this.onPlaying)
    window.addEventListener(STATUS_CHANGED, this.onPlaying)
    window.addEventListener('keydown', this.onShortcut)
    this.draw()
    this.status()
  }

  get sharingIn(): string | null {
    return this.capture ? this.space.room.id : null
  }

  private readonly onVisible = (): void => {
    this.announceMe()
    this.draw()
  }

  private readonly onPlaying = (): void => this.draw()

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
    const action = actionFor(ev)
    if (action) {
      ev.preventDefault()
      this.runShortcut(action)
      return
    }
    if (!(ev.metaKey || ev.ctrlKey) || ev.shiftKey || ev.altKey) return
    if (/^[1-9]$/.test(ev.key)) {
      const wanted = (this.chat?.channels() ?? [])[Number(ev.key) - 1]
      if (!wanted) return
      ev.preventDefault()
      this.openChannel(wanted)
      this.chatPanel.focus()
    }
  }

  private runShortcut(action: Action): void {
    if (action === 'search') this.openSearchBox()
    else if (action === 'mute') this.toggleMute()
    else if (action === 'deafen') this.toggleDeafen()
    else if (action === 'share') void this.toggleShare()
    else if (action === 'leave') this.leaveVoice()
    else {
      const names = this.chat?.channels() ?? []
      const wanted = names[names.indexOf(this.channel) + (action === 'channel-up' ? -1 : 1)]
      if (!wanted) return
      this.openChannel(wanted)
      this.chatPanel.focus()
    }
  }

  private toggleMute(): void {
    const state = this.voice?.state
    if (!state?.channel) return
    this.voice?.setMuted(!state.muted)
    this.draw()
  }

  private toggleDeafen(): void {
    const state = this.voice?.state
    if (!state?.channel) return
    this.voice?.setDeafened(!state.deafened)
    this.draw()
  }

  destroy(): void {
    if (this.stopped) return
    this.stopped = true
    document.removeEventListener('visibilitychange', this.onVisible)
    window.removeEventListener(PLAYING_CHANGED, this.onPlaying)
    window.removeEventListener(MUTED_CHANGED, this.onPlaying)
    window.removeEventListener(STATUS_CHANGED, this.onPlaying)
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
    setTitleFace(null)
  }

  // Only the cosmetic maps: a relay outage empties the roster while media keeps flowing.
  private prunePeers(): void {
    const alive = new Set((this.mesh?.peers() ?? []).map((p) => p.id))
    const known = new Set([
      ...this.sharers.keys(),
      ...this.away,
      ...this.statusBy.keys(),
      ...this.quiet.keys(),
      ...this.filming,
      ...this.typing.keys(),
      ...this.watchingBy.keys(),
      ...this.playingBy.keys(),
      ...this.sounding.keys(),
    ])
    for (const id of known) if (!alive.has(id)) this.forgetSession(id)
  }

  private forgetSession(id: string): void {
    this.sharers.delete(id)
    this.away.delete(id)
    this.statusBy.delete(id)
    this.quiet.delete(id)
    this.filming.delete(id)
    this.voiceSince.delete(id)
    this.typing.delete(id)
    this.watchingBy.delete(id)
    this.playingBy.delete(id)
    this.sounding.delete(id)
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

    const hadStatus = this.statusBy.get(from)
    const status = { mode: cleanPresence(data.status), text: cleanStatusText(data.statusText) }
    if (status.mode === 'online' && !status.text) this.statusBy.delete(from)
    else this.statusBy.set(from, status)
    if ((hadStatus?.mode ?? 'online') !== status.mode || (hadStatus?.text ?? '') !== status.text) this.draw()

    if (typeof data.voiceFor === 'number' && Number.isFinite(data.voiceFor) && data.voiceFor >= 0) {
      const since = Date.now() - data.voiceFor
      const had = this.voiceSince.get(from)
      // Announces repeat; the first answer is the best, unless they left and came back.
      if (!had || Math.abs(had - since) > 5000) this.voiceSince.set(from, since)
    } else {
      this.voiceSince.delete(from)
    }

    const wasQuiet = this.quiet.get(from)
    const quiet = data.deafened === true ? 'deafened' : data.muted === true ? 'muted' : null
    if (quiet) this.quiet.set(from, quiet)
    else this.quiet.delete(from)

    const wasFilming = this.filming.has(from)
    if (data.camera === true && typeof data.voice === 'string') this.filming.add(from)
    else this.filming.delete(from)
    if (wasFilming !== this.filming.has(from)) this.draw()

    const sharing =
      data.sharing === true ? NO_VOICE : typeof data.sharing === 'string' ? cleanChannel(data.sharing) : ''
    const wasSharing = this.sharers.get(from)
    if (sharing) this.sharers.set(from, sharing)
    else this.sharers.delete(from)
    if (sharing && !wasSharing && this.shareIsNew(sharing, data.sharingFor)) chirpStream()

    const game = cleanGameName(data.playing)
    const hadGame = this.playingBy.get(from)
    if (game) {
      const lasted = typeof data.playingFor === 'number' && Number.isFinite(data.playingFor) ? Math.max(0, data.playingFor) : 0
      // Announces repeat; keep the first start unless the game changed.
      const steam = cleanSteamId(data.steam)
      this.playingBy.set(from, hadGame?.name === game ? hadGame : { name: game, steam, since: Date.now() - lasted })
    } else {
      this.playingBy.delete(from)
    }

    const eyes = watchedSessions(data.watching)
    const hadEyes = (this.watchingBy.get(from) ?? []).join()
    if (eyes.length) this.watchingBy.set(from, eyes)
    else this.watchingBy.delete(from)

    if (wasQuiet !== this.quiet.get(from) || (hadGame?.name ?? '') !== game) this.draw()
    if (wasAway !== this.away.has(from) || (wasSharing ?? '') !== sharing || hadEyes !== eyes.join()) this.draw()
    if (!sharing && this.watched.has(from)) {
      this.dropTile(from)
      this.announceMe()
      this.draw()
    }
  }

  private noticeFresh(fresh: LogEvent[]): void {
    const chat = this.chat
    if (!chat) return
    this.doneTyping(fresh)
    // Only what you can read, from a channel you have not muted: a mention of you has its own sound.
    const heard = fresh.filter((e) => {
      if (e.kind !== 'said' || e.author === chat.me || !isNews(e.at)) return false
      const where = cleanChannel(String(e.body.channel ?? '')) || DEFAULT_CHANNEL
      return chat.mayEnter(chat.me, where) && chat.mayEnter(e.author, where) && !channelMuted(this.space.room.id, where)
    })
    if (heard.length) {
      const names = this.everybody()
      if (heard.some((e) => mentionsMe(String(e.body.text ?? ''), names, chat.me))) chirpMention()
      else chirpMessage()
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

  /** What somebody was typing has come: they are not typing now, whatever their last note said. */
  private doneTyping(fresh: LogEvent[]): void {
    const authors = new Set(fresh.filter((e) => e.kind === 'said').map((e) => e.author))
    if (authors.size === 0 || this.typing.size === 0) return
    const peers = this.peersById()
    let cleared = false
    for (const session of [...this.typing.keys()]) {
      if (!authors.has(peers.get(session)?.key ?? '')) continue
      this.typing.delete(session)
      cleared = true
    }
    if (cleared) this.showTyping()
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

  /** The sounds people added here, by wire id. */
  private allSounds(): Sound[] {
    return (this.chat?.boardSounds() ?? []).map((b) => ({ id: CUSTOM + b.id, label: b.label, emoji: b.emoji }))
  }

  private findSound(id: string): Sound | null {
    return this.allSounds().find((s) => s.id === id) ?? null
  }

  private findSoundByName(text: string): Sound | null {
    const want = text.trim().toLowerCase().replace(/\s+/g, '')
    if (!want) return null
    return this.allSounds().find((s) => s.label.toLowerCase().replace(/\s+/g, '') === want) ?? null
  }

  /** Decoded once, then kept: a sound somebody added is fetched and opened like any file. */
  private clip(id: string): Promise<AudioBuffer | null> {
    const had = this.clips.get(id)
    if (had) return had
    const board = this.chat?.boardSounds().find((b) => CUSTOM + b.id === id)
    if (!board) return Promise.resolve(null)
    const work = filesFor(this.space)
      .open(board.file)
      .then((blob) => blob.arrayBuffer())
      .then((bytes) => decodeClip(bytes))
      .catch(() => {
        this.clips.delete(id)
        return null
      })
    this.clips.set(id, work)
    return work
  }

  /** Opened ahead, so the first play of an added sound is not late. */
  private warmClips(): void {
    for (const b of this.chat?.boardSounds() ?? []) void this.clip(CUSTOM + b.id)
  }

  /** Resolves with how long it plays, or 0 when it does not play here. */
  private async play(id: string): Promise<number> {
    if (!id.startsWith(CUSTOM)) return 0
    const buffer = await this.clip(id)
    return buffer ? playClip(id, buffer) : 0
  }

  /** The talking ring round whoever played a sound, while it plays. No toast: the ring says who. */
  private ringFor(session: string, label: string, seconds: number): void {
    const ms = (seconds > 0 ? seconds : SOUND_RING_S) * 1000
    const until = Date.now() + ms
    this.sounding.set(session, { until, label })
    this.renderVoice()
    window.setTimeout(() => {
      if (this.stopped || this.sounding.get(session)?.until !== until) return
      this.sounding.delete(session)
      this.renderVoice()
    }, ms + 50)
  }

  private soundingNow(session: string): { until: number; label: string } | null {
    const on = this.sounding.get(session)
    return on && on.until > Date.now() ? on : null
  }

  private sendSound(id: string): void {
    if (!this.chat?.can('soundboard')) {
      toast('Your level cannot use the soundboard.', 'warn')
      return
    }
    const sound = this.findSound(id)
    if (!sound) return
    const here = this.voice?.state.channel
    if (!here) {
      toast('Join a voice channel to play sounds. Only the people in it hear them.', 'warn')
      return
    }
    // Played as fast as it is clicked; a flood beyond that is only thinned out.
    const now = Date.now()
    if (now - this.soundSentAt < SOUND_EVERY_MS) return
    this.soundSentAt = now
    this.mesh?.broadcast(JSON.stringify({ t: 'sound', s: sound.id, v: here }))
    if (this.voice?.state.deafened) {
      this.ringFor(this.selfId, sound.label, 0)
      return
    }
    void this.play(sound.id).then((seconds) => {
      if (!seconds) toast(`${sound.label} went out. Your own sounds are off in Settings.`, 'info', 4000)
      this.ringFor(this.selfId, sound.label, seconds)
    })
  }

  private takeSound(from: string, raw: string): boolean {
    const note = parseNote<{ s?: unknown; v?: unknown }>(raw, 'sound')
    if (!note) return false
    const sound = typeof note.s === 'string' ? this.findSound(note.s) : null
    if (!sound) return true
    // Played by somebody whose level has no soundboard: a changed app, so nobody hears it.
    if (!this.chat?.log.can(this.keyOf(from), 'soundboard')) return true
    // Only for the people standing in the same voice channel as the one who played it.
    const here = this.voice?.state.channel
    if (!here || note.v !== here || this.voice?.whereIs(from) !== here) return true
    if (!allowNow(this.soundHeard, this.keyOf(from), SOUND_EVERY_MS)) return true
    if (this.voice?.state.deafened) {
      this.ringFor(from, sound.label, 0)
      return true
    }
    void this.play(sound.id).then((seconds) => this.ringFor(from, sound.label, seconds))
    return true
  }

  private openBoard(anchor: HTMLElement | null): void {
    if (!this.chat?.can('soundboard')) {
      toast('Your level cannot use the soundboard.', 'warn')
      return
    }
    const button = anchor ?? this.voiceList.querySelector<HTMLElement>('button[aria-label="Soundboard"]')
    if (!button) {
      toast('Join a voice channel to play sounds.', 'warn')
      return
    }
    this.warmClips()
    const chat = this.chat
    openSoundboard({
      anchor: button,
      onPick: (id) => this.sendSound(id),
      sounds: this.allSounds(),
      onAdd: () => void this.addSound(),
      canChange: (id) => {
        const board = chat?.boardSounds().find((b) => CUSTOM + b.id === id)
        return !!board && !!chat && (board.maker === chat.me || chat.can('channels'))
      },
      onEdit: (id) => void this.editSound(id),
      onRemove: (id) => {
        const sound = this.findSound(id)
        if (!sound || !window.confirm(`Take ${sound.label} off the soundboard for everybody?`)) return
        void this.publish((c) => c.dropBoardSound(id.slice(CUSTOM.length)))
      },
    })
  }

  private async addSound(): Promise<void> {
    const pick = h('input', { type: 'file' })
    pick.accept = 'audio/*'
    const file = await new Promise<File | null>((ok) => {
      pick.addEventListener('change', () => ok(pick.files?.[0] ?? null), { once: true })
      pick.addEventListener('cancel', () => ok(null), { once: true })
      pick.click()
    })
    if (!file) return
    if (file.size > MAX_SOUND_BYTES) {
      toast(`A sound may be at most ${Math.round(MAX_SOUND_BYTES / 1024 / 1024)} MB.`, 'warn')
      return
    }
    let length = 0
    try {
      length = (await decodeClip(await file.arrayBuffer())).duration
    } catch {
      toast('That file is not a sound this browser can play.', 'warn')
      return
    }
    if (length > CUSTOM_MAX_S + 0.5) {
      toast(`A sound may be at most ${CUSTOM_MAX_S} seconds. That one is ${Math.round(length)}.`, 'warn')
      return
    }
    const answer = await askSound('Add a sound', file.name.replace(/\.[^.]+$/, '').slice(0, 24), '🔊', 'Add')
    const named = answer?.name.trim() ?? ''
    if (!answer || !named) return
    try {
      const sent = await filesFor(this.space).send(file, () => undefined, new AbortController().signal)
      const bytes = crypto.getRandomValues(new Uint8Array(8))
      const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
      await this.publish((c) => c.addBoardSound(id, named, answer.emoji || '🔊', sent))
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That sound could not be added.', 'bad')
    }
  }

  private async editSound(id: string): Promise<void> {
    const sound = this.findSound(id)
    if (!sound) return
    const answer = await askSound(`Change ${sound.label}`, sound.label, sound.emoji, 'Save')
    if (!answer) return
    const name = answer.name.trim() || sound.label
    if (name === sound.label && answer.emoji === sound.emoji) return
    await this.publish((c) => c.editBoardSound(id.slice(CUSTOM.length), name, answer.emoji))
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
      // The system notification comes from main.ts, for every space alike.
      if (!chat.mayEnter(chat.me, where) || !chat.mayEnter(e.author, where)) continue
      if (where === this.channel && !this.thread) continue
      if (channelMuted(this.space.room.id, where)) continue
      toast(`${who} mentioned you in #${where}`, 'info', 8000, {
        label: 'Go',
        run: () => this.openChannel(where),
      })
    }
  }

  private channelActions(channel: ChannelInfo): MenuItem[] {
    const room = this.space.room.id
    const mutedItself = channelMutedItself(room, channel.name)
    const mute: MenuItem = spaceMuted(room)
      ? { label: 'Muted with the space', note: 'Unmute the space to hear from it', run: () => muteSpace(room, false) }
      : {
          label: mutedItself ? 'Unmute' : 'Mute',
          lead: h('span', { class: 'menu-icon' }, [icon(mutedItself ? 'bell' : 'bell-off', 16)]),
          run: () => muteChannel(room, channel.name, !mutedItself),
        }
    if (!this.chat?.can('channels')) return [mute]
    const items: MenuItem[] = [
      mute,
      ...this.moveItems(channel.name, false),
      {
        label: 'Rename',
        note: `Shown instead of ${channel.name}`,
        run: async () => {
          const raw = (await ask('What should this channel be called?', { value: channel.label, ok: 'Rename' })) ?? ''
          const label = raw.trim().slice(0, 32)
          if (!label) return
          void this.publish((c) => c.labelChannel(channel.name, label))
        },
      },
      {
        label: channel.topic ? 'Change the topic' : 'Set a topic',
        note: channel.topic || 'A line saying what it is for',
        run: async () => {
          const raw = await ask('What is this channel for?', { value: channel.topic, ok: 'Save' })
          if (raw === null) return
          void this.publish((c) => c.setTopic(channel.name, raw.trim().slice(0, 140)))
        },
      },
    ]
    if (channel.name !== DEFAULT_CHANNEL) {
      items.push(this.whoMayEnter(channel, false))
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

  /** For whoever can change channels: the name, who may join, and, but for the default one, delete. */
  private voiceChannelActions(channel: ChannelInfo): MenuItem[] {
    const items: MenuItem[] = [
      ...this.moveItems(channel.name, true),
      {
        label: 'Rename',
        note: `Shown instead of ${channel.name}`,
        run: async () => {
          const raw = (await ask('What should this voice channel be called?', { value: channel.label, ok: 'Rename' })) ?? ''
          const label = raw.trim().slice(0, 32)
          if (!label) return
          void this.publish((c) => c.labelChannel(channel.name, label, true))
        },
      },
    ]
    if (channel.name === DEFAULT_VOICE) return items
    items.push(this.whoMayEnter(channel, true), {
      label: 'Delete',
      note: 'Anybody in it now is taken out',
      danger: true,
      run: () => {
        if (!window.confirm(`Delete the voice channel ${channel.label}? Anybody in it now is taken out.`)) return
        if (this.voice?.state.channel === channel.name) this.leaveVoice()
        void this.publish((c) => c.dropChannel(channel.name, true))
      },
    })
    return items
  }

  /** Keeps a channel to some levels. The default channels stay open to everybody. */
  private whoMayEnter(channel: ChannelInfo, voice: boolean): MenuItem {
    const levels = this.chat?.levels() ?? []
    const names = channel.levels.map((id) => levels.find((l) => l.id === id)?.name).filter(Boolean)
    return {
      label: voice ? 'Who can see and join' : 'Who can see it',
      note: names.length ? `Only ${names.join(', ')}` : 'Everybody',
      run: async () => {
        const choices = levels.filter((l) => l.id !== OWNER).map((l) => ({ id: l.id, name: l.name, colour: l.colour }))
        const picked = await pickSome(
          voice ? `Who can see and join ${channel.label}` : `Who can see ${channel.label}`,
          'Tick nobody for everybody. The owner, and whoever can change channels, always get in.',
          choices,
          channel.levels,
        )
        if (picked === null) return
        void this.publish((c) => c.setChannelLevels(channel.name, picked, voice))
      },
    }
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
        const sound = this.findSoundByName(arg)
        if (!sound) {
          const names = this.allSounds().map((s) => (s.id.startsWith(CUSTOM) ? s.label : s.id))
          toast(`No sound called ${arg}. There is: ${names.join(', ')}`, 'warn', 7000)
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
        void this.inviteLink().then(copyText).then((ok) =>
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
    this.closeNote()
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
    // From a note too, which sits in place of the channel it came from.
    if (m.channel !== this.channel || this.noteId) this.openChannel(m.channel)
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
    this.chatPanel.canRelocate = chat.can('relocate')
    this.chatPanel.relocateTargets = (m) =>
      chat.channelInfo().filter((c) => c.name !== m.channel && chat.mayEnter(m.author, c.name))
    this.chatPanel.personMenu = (key) => {
      if (key === chat.me) return []
      const role = chat.roles().get(key) ?? 'member'
      const here = this.roster().some((r) => r.key === key && r.here)
      return this.personMenu(key, role, false, here)
    }
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
    const note = this.noteId ? chat.notes().find((n) => n.id === this.noteId) : undefined
    if (this.noteId && !note) {
      toast('That note was deleted.', 'warn')
      this.closeNote()
    }
    if (note) {
      this.noteEditor.show(note)
      this.renderNoteHead(note.title)
    } else {
      this.renderChannelHead(info)
      this.markRead(this.channel)
    }
    this.showTyping()
    this.renderSpaceName(chat)
    if (chat.isClosed && !this.closing) void this.acceptClose()

    const people = this.roster()
    this.renderChannels()
    this.renderThreads()
    this.renderVoice()
    this.renderNotes()
    this.renderPeople(people)
    this.renderMe()
    this.renderShareButton()
    this.status()
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

  private renderNoteHead(title: string): void {
    const sig = `note\n${title}`
    if (this.channelTitleSig === sig) return
    this.channelTitleSig = sig
    clear(this.channelTitle)
    this.channelTitle.append(
      h('span', { class: 'channel-name' }, [icon('file', 18), h('span', { class: 'truncate', text: title })]),
    )
  }

  private renderNotes(): void {
    clear(this.noteList)
    const chat = this.chat
    if (!chat) return
    for (const note of chat.notes()) {
      const open = h(
        'button',
        {
          class: `rail-item grow${note.id === this.noteId ? ' on' : ''}`,
          title: `Open ${note.title}`,
          on: { click: () => this.openNote(note.id) },
        },
        [
          icon('file', 16),
          h('span', { class: 'truncate grow', text: note.title }),
        ],
      )
      const row = h('div', { class: 'row rail-row' }, [open])
      onContextMenu(row, () => this.noteActions(note))
      this.noteList.append(row)
    }
  }

  /** The note's own buttons: rename, who can see it, copy, and delete. */
  private noteTools(note: NoteInfo): HTMLElement[] {
    const tool = (name: IconName, label: string, run: () => void, danger = false): HTMLElement =>
      h('button', { class: `ghost icon-only tool-${name}${danger ? ' danger' : ''}`, title: label, ariaLabel: label, on: { click: run } }, [
        icon(name, 17),
      ])
    const out = [tool('edit', 'Rename', () => void this.renameNote(note))]
    if (this.mayKeepNote(note)) {
      out.push(tool(note.levels.length ? 'lock' : 'people', this.noteSeenBy(note), () => void this.pickNoteLevels(note)))
      out.push(tool('trash', 'Delete the note', () => void this.deleteNote(note), true))
    }
    return out
  }

  private async renameNote(note: NoteInfo): Promise<void> {
    const raw = await ask('What should this note be called?', { value: note.title, ok: 'Rename' })
    if (raw === null || !raw.trim() || raw.trim() === note.title) return
    void this.publish((c) => c.saveNote(note.id, raw.trim()))
  }

  private mayKeepNote(note: NoteInfo): boolean {
    return !!this.chat && (note.maker === this.chat.me || this.chat.can('channels'))
  }

  private noteSeenBy(note: NoteInfo): string {
    const levels = this.chat?.levels() ?? []
    const names = note.levels.map((id) => levels.find((l) => l.id === id)?.name).filter(Boolean)
    return names.length ? `Who can see it: only ${names.join(', ')}` : 'Who can see it: everybody'
  }

  private async pickNoteLevels(note: NoteInfo): Promise<void> {
    const levels = this.chat?.levels() ?? []
    const choices = levels.filter((l) => l.id !== OWNER).map((l) => ({ id: l.id, name: l.name, colour: l.colour }))
    const picked = await pickSome(
      `Who can see ${note.title}`,
      'Tick nobody for everybody. You, the owner, and whoever can change channels always see it.',
      choices,
      note.levels,
    )
    if (picked === null) return
    void this.publish((c) => c.setNoteLevels(note.id, picked))
  }

  private copyNote(note: NoteInfo): void {
    navigator.clipboard.writeText(note.text).then(
      () => toast('Copied.'),
      () => toast('Could not copy that.', 'warn'),
    )
  }

  private async deleteNote(note: NoteInfo): Promise<void> {
    const sure = await confirmDanger(`Delete ${note.title}?`, 'It goes for everybody in this space, and it cannot be undone.', 'Delete')
    if (!sure) return
    if (this.noteId === note.id) this.openChannel(this.channel)
    void this.publish((c) => c.dropNote(note.id))
  }

  /** The right click on a note in the list. */
  private noteActions(note: NoteInfo): MenuItem[] {
    const items: MenuItem[] = [
      { label: 'Open', run: () => this.openNote(note.id) },
      { label: 'Rename', run: () => void this.renameNote(note) },
      { label: 'Copy the markdown', run: () => this.copyNote(note) },
    ]
    if (this.mayKeepNote(note)) {
      items.push({ label: 'Who can see it', note: this.noteSeenBy(note).replace('Who can see it: ', ''), run: () => void this.pickNoteLevels(note) })
      items.push({ label: 'Delete', note: 'For everybody in this space', danger: true, run: () => void this.deleteNote(note) })
    }
    return items
  }

  private async newNote(): Promise<void> {
    const raw = await ask('What should the note be called?', { placeholder: 'Untitled', ok: 'Make' })
    if (raw === null) return
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    await this.publish((c) => c.saveNote(id, raw.trim() || 'Untitled', ''))
    this.openNote(id)
    this.noteEditor.focus()
  }

  private openNote(id: string): void {
    this.showRail(null)
    if (this.thread) {
      this.chatPanel.keepDraft()
      this.thread = null
      this.chatPanel.setThread(null)
      this.chatPanel.useDraft(this.channel)
    }
    this.closeSearch()
    this.noteId = id
    this.chatPanel.root.classList.add('hidden')
    this.drawNow()
  }

  /** Returns true when a note was open. */
  private closeNote(): boolean {
    if (!this.noteId) return false
    this.noteId = null
    this.noteEditor.hide()
    this.chatPanel.root.classList.remove('hidden')
    this.channelTitleSig = ''
    return true
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
    const picture = chat.spacePicture()
    const faceKey = `${this.room?.id ?? ''}|${named}|${picture.length}|${picture.slice(-24)}`
    if (this.room && this.spaceFace.dataset.key !== faceKey) {
      this.spaceFace.dataset.key = faceKey
      this.spaceFace.replaceChildren(spaceFace(this.room.id, named, 24, picture))
      void this.remember({})
    }
  }

  private renderMe(): void {
    const chat = this.chat
    if (!chat) return
    const name = chat.displayName
    const picture = chat.avatarOf(chat.me) || loadAvatar()
    const status = loadStatus()
    const sig = `${name}|${picture.length}|${picture.slice(-24)}|${status.mode}|${status.text}`
    if (this.meFace.dataset.sig === sig) return
    this.meFace.dataset.sig = sig
    this.meFace.replaceChildren(avatarOf(chat.me, name, picture, 32), myStatusDot())
    this.meName.textContent = name
    this.meName.title = status.text ? `${name}: ${status.text}` : name
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

  private status(): void {
    if (!this.chrome) return
    if (!this.loaded) {
      this.chrome.setStatus(['Opening...'])
      return
    }
    const up = this.serverUp()
    // Nobody reads the count, so it is kept out of sight for the tests.
    this.chrome.status.dataset.here = String(this.roster().filter((r) => r.here).length)
    const what = this.capture
      ? 'Sharing your screen'
      : this.watchingAnyone()
        ? 'Watching a shared screen'
        : `#${this.channel}`
    const name = this.capture ? 'Sharing your screen' : `#${this.channel}`
    const named = this.chat?.spaceName() ?? ''
    const picture = this.chat?.spacePicture() ?? ''
    const room = this.space.room.id
    this.chrome.setTitle(`Nook | ${this.mentions ? `(${this.mentions}) ` : ''}${name}`, {
      key: `space|${room}|${named}|${picture.length}|${picture.slice(-24)}`,
      make: () => spaceFace(room, named, 18, picture),
    })
    const serving = serverTag(this.space.channel?.serving ?? this.server)
    this.chrome.setStatus([what, ...(up ? [] : [`cannot reach ${serving}`])])
    this.chrome.status.title = up ? `Connected to ${serving}` : `Cannot reach ${serving}`
  }

  private watchServer(): void {
    if (this.serverUp()) {
      this.serverWarned = false
      this.offline?.classList.add('hidden')
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
      this.showOffline()
    }, SERVER_SILENCE_MS)
  }

  private showOffline(): void {
    if (!this.offline) return
    const words = this.offline.lastElementChild
    if (words) {
      words.textContent = `Cannot reach ${serverTag(this.server)} or any server in its cluster. Nothing syncs until one answers. They may be down, or this network may block them.`
    }
    this.offline.classList.toggle('hidden', !this.serverWarned)
  }

  private renderShell(): void {
    clear(this.root)
    this.dock.stop()
    this.dock = voiceDock(this.space)

    this.channelList = h('div', { class: 'rail-list' })
    this.voiceList = h('div', { class: 'rail-list' })
    this.threadList = h('div', { class: 'rail-list rail-threads' })
    this.noteList = h('div', { class: 'rail-list' })
    this.noteEditor = new NoteEditor({
      save: (id, title, text) => this.publish((c) => c.saveNote(id, title, text)),
      nameOf: (key) => this.chat?.nameOf(key) || shortKey(key),
      tools: (note) => this.noteTools(note),
    })
    this.peopleList = h('div', { class: 'rail-list' })
    this.voiceBar = h('div', { class: 'voice-bar voice-panel hidden' })
    this.stage = h('div', { class: 'stage hidden' })
    this.cameras = h('div', { class: 'camera-strip hidden', role: 'region', ariaLabel: 'Cameras' })
    for (const t of this.cameraTiles.values()) t.video.srcObject = null
    this.cameraTiles.clear()
    this.cameraButton = h('button', { class: 'voice-tool camera-button', on: { click: () => void this.toggleCamera() } })
    this.streamBar = h('div', { class: 'stream-bar hidden' })
    // No server answers: the ghost sleeps until one does.
    const offline = h('div', { class: 'offline-bar hidden', role: 'status' }, [
      ghost({ mood: 'sleeping', size: 24 }),
      h('span', { class: 'grow' }),
    ])
    offline.setAttribute('aria-live', 'polite')
    this.offline = offline
    this.showOffline()
    this.channelTitle = h('div', { class: 'row channel-head' }, [
      h('span', { class: 'channel-name' }, [icon('hash', 18), h('span', { class: 'truncate', text: this.channel })]),
    ])
    this.channelTitleSig = ''

    this.shareList = h('div', { class: 'rail-list share-list' })
    this.railShareButton = h('button', { class: 'rail-item share-start', on: { click: () => void this.toggleShare() } })
    this.shareStart = h('div', { class: 'rail-list' })
    this.shareButton = h('button', { class: 'voice-tool share-button' }, [icon('monitor', 19)])
    this.shareButton.addEventListener('click', () => void this.toggleShare())
    this.shareButtonSharing = null

    this.chatPanel = this.makeChatPanel()
    const left = this.leftRail()
    const right = h('div', { class: 'rail rail-right', role: 'complementary', ariaLabel: 'Who is here' }, [
      h('div', { class: 'rail-scroll' }, [this.peopleList]),
      desktopOffer(),
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
    this.peopleButton.append(icon('people', 21))
    this.paintPeopleButton()
    const narrow = window.matchMedia('(max-width: 780px)')
    const repaint = (): void => this.paintPeopleButton()
    narrow.addEventListener('change', repaint)
    this.unlisten.push(() => narrow.removeEventListener('change', repaint))

    this.shell = h('div', { class: 'space-grid loading' }, [
      scrim,
      left,
      h('div', { class: 'space-main' }, [
        h('div', { class: 'space-head row' }, [
          this.channelsButton,
          this.channelTitle,
          // Search first, then the actions.
          this.searchWrap,
          this.pinsButton,
          this.peopleButton,
        ]),
        offline,
        this.searchResults,
        this.streamBar,
        this.cameras,
        this.stage,
        this.chatPanel.root,
        this.noteEditor.root,
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
    panel.commands = COMMANDS
    panel.actions = {
      say: (text, replyTo, inThread, files) =>
        void this.publish((c) => c.say(text, this.channel, replyTo, inThread, false, files)),
      sayDirect: (to, text, files) => void this.publish((c) => c.sayDirect(to, text, files)),
      edit: (id, text) => void this.publish((c) => c.edit(id, text)),
      react: (id, emoji, on) => void this.publish((c) => c.react(id, emoji, on)),
      retract: (id) => void this.publish((c) => c.retract(id)),
      pin: (id, on) => void this.publish((c) => c.pin(id, on)),
      relocate: (id, channel) => {
        void this.publish((c) => c.relocate(id, channel))
        const label = this.chat?.channelInfo().find((c) => c.name === channel)?.label || channel
        toast(`Moved to ${label}.`)
      },
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
        ...(this.spaceRights().any
          ? [{ label: 'Space settings', lead: h('span', { class: 'menu-icon' }, [icon('cog', 16)]), run: () => void this.openSpaceSettings() }]
          : []),
        spaceMuted(this.space.room.id)
          ? {
              label: 'Unmute this space',
              lead: h('span', { class: 'menu-icon' }, [icon('bell', 16)]),
              run: () => muteSpace(this.space.room.id, false),
            }
          : {
              label: 'Mute this space',
              lead: h('span', { class: 'menu-icon' }, [icon('bell-off', 16)]),
              run: () => muteSpace(this.space.room.id, true),
            },
        { label: 'Leave', danger: true, lead: h('span', { class: 'menu-icon' }, [icon('leave', 16)]), run: () => void this.leaveSpace() },
      ],
    })

    this.meFace = h('span', { class: 'me-face' })
    this.meName = h('span', { class: 'me-name truncate' })
    const who = h('div', { class: 'me-who', role: 'button', tabIndex: 0, ariaLabel: 'Your status', title: 'Set your status', data: { menu: 'status' } }, [
      this.meFace,
      h('div', { class: 'me-text' }, [this.meName, this.chrome?.status ?? null]),
    ])
    onPress(who, () => openStatusMenu(who))
    who.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      openStatusMenu(who)
    })
    const me = h('div', { class: 'me-panel' }, [
      who,
      h(
        'button',
        {
          class: 'ghost icon-only',
          title: 'Your name, your ID, and this space',
          ariaLabel: 'Settings',
          on: { click: () => void this.openSettings() },
        },
        [icon('cog', 19)],
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
      [icon('plus', 18)],
    )
    this.newVoiceButton = h(
      'button',
      {
        class: 'ghost icon-only rail-add hidden',
        title: 'Make a voice channel',
        ariaLabel: 'Make a voice channel',
        on: { click: () => void this.newChannel(true) },
      },
      [icon('plus', 18)],
    )

    return h('div', { class: 'rail rail-left', role: 'navigation', ariaLabel: 'Channels, threads and conversations' }, [
      h('div', { class: 'space-title' }, [spaceMenu]),
      h('div', { class: 'rail-scroll' }, [
        h('div', { class: 'rail-head' }, [h('span', { class: 'eyebrow', text: 'Text' }), this.newTextButton]),
        this.channelList,
        h('div', { class: 'rail-head' }, [
          h('span', {
            class: 'eyebrow',
            text: 'Voice',
            title: 'Everybody standing in one hears everybody else.',
          }),
          this.newVoiceButton,
        ]),
        this.voiceList,
        h('div', { class: 'rail-head' }, [
          h('span', { class: 'eyebrow', text: 'Screen', title: 'Anybody here can share, in voice or not.' }),
        ]),
        this.shareList,
        this.shareStart,
        h('div', { class: 'rail-head' }, [
          h('span', { class: 'eyebrow', text: 'Notes', title: 'Notes in markdown that everybody here can read and change.' }),
          h(
            'button',
            {
              class: 'ghost icon-only rail-add',
              title: 'Make a note',
              ariaLabel: 'Make a note',
              on: { click: () => void this.newNote() },
            },
            [icon('plus', 18)],
          ),
        ]),
        this.noteList,
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
    this.slidePeople(this.membersHidden)
    this.paintPeopleButton()
  }

  /**
   * The people pane slides out to the right, and the chat grows into its room, or the other way.
   * The column closes to nothing with the grid's right padding, which is where the class leaves it.
   */
  private slidePeople(hide: boolean): void {
    const grid = this.shell
    const pane = grid.querySelector<HTMLElement>(':scope > .rail-right')
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    this.peopleSlide?.cancel()
    if (!pane || still) {
      grid.classList.toggle('members-hidden', hide)
      return
    }
    grid.classList.remove('members-hidden')
    // Too narrow for the pane at all: there is nothing to slide.
    if (getComputedStyle(pane).display === 'none') {
      grid.classList.toggle('members-hidden', hide)
      return
    }
    const style = getComputedStyle(grid)
    const left = style.gridTemplateColumns.split(' ')[0]
    const open = { gridTemplateColumns: `${left} minmax(0px, 1fr) 248px`, paddingRight: style.paddingLeft }
    const shut = { gridTemplateColumns: `${left} minmax(0px, 1fr) 0px`, paddingRight: '0px' }
    const timing = { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    grid.style.overflow = 'hidden'
    pane.style.minWidth = '248px'
    const slide = grid.animate(hide ? [open, shut] : [shut, open], timing)
    pane.animate(
      hide
        ? [{ transform: 'none', opacity: 1 }, { transform: 'translateX(24px)', opacity: 0 }]
        : [{ transform: 'translateX(24px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      timing,
    )
    this.peopleSlide = slide
    const done = (): void => {
      if (this.peopleSlide !== slide) return
      this.peopleSlide = null
      grid.style.overflow = ''
      pane.style.minWidth = ''
      grid.classList.toggle('members-hidden', hide)
    }
    slide.onfinish = done
    slide.oncancel = done
  }

  /** Whether the people are on screen, for a screen reader: the button itself looks the same. */
  private paintPeopleButton(): void {
    const narrow = window.matchMedia('(max-width: 780px)').matches
    const open = narrow ? this.railOpen === 'right' : !this.membersHidden
    this.peopleButton.setAttribute('aria-pressed', String(open))
  }

  private closeSettings(): void {
    this.settingsOpen = null
    clear(this.root)
    this.root.append(h('main', {}, [this.shell]))
    this.drawNow()
  }

  private async openSettings(start?: string): Promise<void> {
    const { settingsView } = await import('./settings-view')
    if (this.stopped) return
    clear(this.root)
    this.settingsOpen = 'user'
    this.root.append(
      settingsView({
        rename: (name, avatar) => this.rename(name, avatar),
        start,
        back: () => this.closeSettings(),
      }),
    )
  }

  /** What your level lets you change in this space's settings. */
  private spaceRights(): { space: boolean; levels: boolean; remove: boolean; any: boolean } {
    const space = this.chat?.can('space') === true
    const levels = this.chat?.can('levels') === true
    const remove = this.chat?.can('remove') === true
    return { space, levels, remove, any: space || levels || remove }
  }

  private async openSpaceSettings(start?: string): Promise<void> {
    const rights = this.spaceRights()
    if (!rights.any) {
      toast('Your level cannot change this space.', 'warn')
      return
    }
    const { spaceSettingsView } = await import('./space-settings')
    if (this.stopped) return
    clear(this.root)
    this.settingsOpen = 'space'
    this.root.append(
      spaceSettingsView({
        id: this.room?.id ?? '',
        name: this.chat?.spaceName() || 'Unnamed space',
        picture: this.chat?.spacePicture() ?? '',
        can: rights,
        levels: () => this.levelsEditor(),
        members: () => this.memberRows(),
        setLevel: (key, level) => this.setRole(key, level),
        kick: async (key) => {
          if (!window.confirm(`Remove ${this.chat?.nameOf(key) || shortKey(key)} from this space?`)) return
          await this.setRole(key, 'kicked')
        },
        ban: (key) => this.ban(key),
        invitesClosed: this.chat?.log.invitesClosed() ?? false,
        rename: () => this.renameSpace(),
        setPicture: (file) => this.setSpacePicture(file),
        reset: () => this.resetSpace(),
        remove: () => this.deleteSpace(),
        removed: [...(this.chat?.roles() ?? new Map<string, string>())]
          .filter(([key, role]) => role === 'kicked' && this.chat?.authority().mayRemove(this.chat.me, key))
          .map(([key]) => ({
            key,
            name: this.chat?.nameOf(key) || shortKey(key),
            banned: this.chat?.authority().isBanned(key) ?? false,
            restore: () => void this.setRole(key, 'member'),
          })),
        start,
        back: () => this.closeSettings(),
      }),
    )
  }

  /** Everybody in the space who is not removed, the highest level first, for the Members tab. */
  private memberRows(): MemberRow[] {
    const chat = this.chat
    if (!chat) return []
    const auth = chat.authority()
    const me = chat.me
    const mine = auth.levelOf(me).rank
    const avatars = chat.log.avatars()
    return chat.log
      .keyMembers()
      .map((key) => {
        const level = auth.levelOf(key)
        const choices = auth.mayPlace(me, key) ? auth.list().filter((l) => l.id !== OWNER && l.rank <= mine) : []
        return {
          key,
          name: key === me ? chat.displayName : chat.nameOf(key) || shortKey(key),
          picture: avatars.get(key) ?? '',
          you: key === me,
          level: { id: level.id, name: level.name, colour: level.colour ? roleInk(level.colour) : '' },
          choices: choices.map((l) => ({ id: l.id, name: l.name })),
          mayRemove: auth.mayRemove(me, key),
          rank: level.rank,
        }
      })
      .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))
      .map(({ rank: _rank, ...row }) => row)
  }

  /** A picture for the space, or null to take it away. */
  private async setSpacePicture(file: File | null): Promise<void> {
    if (!this.chat?.can('space')) {
      toast('Your level cannot change this space.', 'warn')
      return
    }
    let picture = ''
    if (file) {
      try {
        picture = await squareThumb(file, 96, MAX_SPACE_PICTURE)
      } catch (err) {
        toast(err instanceof Error ? err.message : 'That picture would not do.', 'warn')
        return
      }
    }
    await this.publish((c) => c.setSpacePicture(picture))
    await this.remember({})
    if (this.settingsOpen === 'space') void this.openSpaceSettings('overview')
  }

  private async renameSpace(): Promise<void> {
    if (!this.chat?.can('space')) {
      toast('Your level cannot rename this space.', 'warn')
      return
    }
    const raw = (await ask('Name this space', { value: this.chat.spaceName(), ok: 'Rename' })) ?? ''
    const name = raw.trim().slice(0, 32)
    if (!name) return
    await this.publish((c) => c.setSpaceName(name))
    await this.remember({ name })
    if (this.settingsOpen === 'space') void this.openSpaceSettings('overview')
  }

  private showRail(which: 'left' | 'right' | null): void {
    this.railOpen = which
    this.shell.classList.toggle('rail-left-open', which === 'left')
    this.shell.classList.toggle('rail-right-open', which === 'right')
    this.channelsButton.setAttribute('aria-expanded', String(which === 'left'))
    this.peopleButton.setAttribute('aria-expanded', String(which === 'right'))
    this.paintPeopleButton()
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

  /** A removal that also closes the old invites: after it, only a link made since lets a new person in. */
  private async ban(key: string): Promise<void> {
    const name = this.chat?.nameOf(key) || shortKey(key)
    const sure = window.confirm(
      `Ban ${name} from this space?\n\nThey are removed, and the old invite links stop letting anybody new in. Send new people a new link from Invite people.`,
    )
    if (sure) await this.setRole(key, 'kicked', true)
  }

  private async setRole(subject: string, role: string, ban = false): Promise<void> {
    const auth = this.chat?.authority()
    const me = this.chat?.me ?? ''
    const allowed =
      auth && (role === 'kicked' || auth.isKicked(subject) ? auth.mayRemove(me, subject) : auth.mayPlace(me, subject))
    if (!allowed) {
      toast('Your level cannot do that.', 'warn')
      return
    }
    await this.publish((c) => c.setRole(subject, role, ban))
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

  /**
   * The link to send somebody. After a ban the code alone lets nobody new in, so the link
   * carries a pass too: this person's own, made once and kept in the log for the others.
   */
  private async inviteLink(): Promise<string> {
    const chat = this.chat
    let pass = ''
    if (chat?.log.invitesClosed()) {
      pass = chat.log.passOf(chat.me)
      if (!pass) {
        pass = newPass()
        await this.publish((c) => c.addPass(pass))
      }
    }
    return roomLink(this.secret, this.locked, this.server, pass)
  }

  private async showInvite(): Promise<void> {
    const { qrSvg } = await import('./qr')
    const link = await this.inviteLink()
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
          h('div', {
            class: 'share-code',
            // After a ban the code needs its pass: the two are typed together.
            text: link.includes('~') ? `${formatSecret(this.secret)}~${link.split('~')[1].split('@')[0]}` : formatSecret(this.secret),
            title: 'The code for this space',
            data: { link },
          }),
          copy,
          frame,
          h('div', { class: 'tiny faint invite-scan', text: 'Or scan it with a phone.' }),
        ]),
      ]),
    )
    document.body.append(scrim)
  }

  private renderChannels(): void {
    if (this.channelDrag && !this.channelDrag.voice) return
    const chat = this.chat
    clear(this.channelList)
    const canEdit = chat?.can('channels') === true
    this.newTextButton.classList.toggle('hidden', !canEdit)
    const waiting = chat?.unread(this.read) ?? new Map()
    let mentions = 0
    for (const [, count] of waiting) mentions += count.mentions
    const liveChannels = new Set(this.sharers.values())

    // Kept from you now, by a change to the channel or to your level.
    if (chat && !chat.mayEnter(chat.me, this.channel)) queueMicrotask(() => this.openChannel(DEFAULT_CHANNEL))
    const wanted = this.wantChannel
    if (chat && wanted && chat.channels().includes(wanted)) {
      this.wantChannel = null
      queueMicrotask(() => this.openChannel(wanted))
    }

    for (const channel of chat?.channelInfo() ?? [{ name: DEFAULT_CHANNEL, label: DEFAULT_CHANNEL, topic: '', levels: [] }]) {
      const name = channel.name
      const muted = channelMuted(this.space.room.id, name)
      const news = muted ? undefined : waiting.get(name)
      const open = h(
        'button',
        {
          class: `rail-item grow${name === this.channel && !this.noteId ? ' on' : ''}${news ? ' unread' : ''}${muted ? ' muted' : ''}`,
          title: channel.topic || `Open ${channel.label}`,
          on: { click: () => this.openChannel(name) },
        },
        [
          icon('hash', 16),
          h('span', { class: 'truncate grow', text: channel.label }),
          muted ? h('span', { class: 'kept-mark', title: 'Muted' }, [icon('bell-off', 13)]) : null,
          liveChannels.has(name) ? h('span', { class: 'pill live', text: 'live' }) : null,
          news?.mentions
            ? h('span', { class: 'pill bad', text: `${news.mentions}`, title: 'You were mentioned' })
            : null,
        ],
      )
      const railRow = h('div', { class: 'row rail-row' }, [open])
      onContextMenu(railRow, () => this.channelActions(channel))
      if (canEdit) this.orderByHand(railRow, name, false)
      this.channelList.append(railRow)
    }
    // Share your screen comes with the channels, never before them.
    if (chat && !this.railShareButton.isConnected) this.shareStart.append(this.railShareButton)
    this.mentions = mentions
  }

  /** Somebody who may move people drags a person, from voice or from the list of people. */
  private dragPerson(el: HTMLElement, key: string): void {
    el.draggable = true
    el.addEventListener('dragstart', (ev) => {
      ev.stopPropagation()
      this.personDrag = key
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move'
        ev.dataTransfer.setData('text/plain', key)
      }
      el.classList.add('dragging')
    })
    el.addEventListener('dragend', () => {
      this.personDrag = null
      for (const row of this.voiceList.querySelectorAll('.drop-into')) row.classList.remove('drop-into')
      this.draw()
    })
  }

  /** A voice channel that takes a dragged person: their device is asked to join it. */
  private takePeople(row: HTMLElement, channel: ChannelInfo): void {
    row.addEventListener('dragover', (ev) => {
      if (!this.personDrag) return
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
      row.classList.add('drop-into')
    })
    row.addEventListener('dragleave', (ev) => {
      if (!(ev.relatedTarget instanceof Node && row.contains(ev.relatedTarget))) row.classList.remove('drop-into')
    })
    row.addEventListener('drop', (ev) => {
      row.classList.remove('drop-into')
      const key = this.personDrag
      if (!key) return
      ev.preventDefault()
      ev.stopPropagation()
      this.personDrag = null
      void this.moveTo(key, channel.name)
      this.draw()
    })
  }

  /** Somebody who keeps the channels drags one to a new place in its list, for everybody. */
  private orderByHand(row: HTMLElement, name: string, voice: boolean): void {
    row.draggable = true
    row.dataset.channel = name
    const unmark = (): void => row.classList.remove('drop-before', 'drop-after')
    const after = (ev: DragEvent): boolean => {
      const box = row.getBoundingClientRect()
      return ev.clientY > box.top + box.height / 2
    }
    const mine = (): boolean => !!this.channelDrag && this.channelDrag.voice === voice && this.channelDrag.name !== name
    row.addEventListener('dragstart', (ev) => {
      this.channelDrag = { name, voice }
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move'
        ev.dataTransfer.setData('text/plain', name)
      }
      row.classList.add('dragging')
    })
    row.addEventListener('dragend', () => {
      this.channelDrag = null
      this.draw()
    })
    row.addEventListener('dragover', (ev) => {
      if (!mine()) return
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
      const below = after(ev)
      row.classList.toggle('drop-after', below)
      row.classList.toggle('drop-before', !below)
    })
    row.addEventListener('dragleave', (ev) => {
      if (!(ev.relatedTarget instanceof Node && row.contains(ev.relatedTarget))) unmark()
    })
    row.addEventListener('drop', (ev) => {
      unmark()
      const dragged = this.channelDrag
      if (!dragged || !mine()) return
      ev.preventDefault()
      this.channelDrag = null
      this.moveChannel(dragged.name, voice, name, after(ev))
    })
  }

  /** Puts a channel just before or after another one, or up and down one place with no target. */
  private moveChannel(name: string, voice: boolean, target: string | number, below = false): void {
    const chat = this.chat
    if (!chat?.can('channels')) return
    const names = chat.channelInfo(voice).map((c) => c.name)
    const from = names.indexOf(name)
    if (from < 0) return
    names.splice(from, 1)
    let to: number
    if (typeof target === 'number') to = Math.max(0, Math.min(names.length, from + target))
    else {
      const at = names.indexOf(target)
      if (at < 0) return
      to = below ? at + 1 : at
    }
    names.splice(to, 0, name)
    if (to === from) {
      this.draw()
      return
    }
    void this.publish((c) => c.orderChannels(names, voice))
  }

  /** Move up and Move down, for a channel's menu: a drag is not there on a touch screen. */
  private moveItems(name: string, voice: boolean): MenuItem[] {
    const names = this.chat?.channelInfo(voice).map((c) => c.name) ?? []
    const at = names.indexOf(name)
    const items: MenuItem[] = []
    if (at > 0) items.push({ label: 'Move up', lead: h('span', { class: 'menu-icon' }, [icon('arrow-up', 16)]), run: () => this.moveChannel(name, voice, -1) })
    if (at >= 0 && at < names.length - 1) {
      items.push({ label: 'Move down', lead: h('span', { class: 'menu-icon' }, [icon('arrow-down', 16)]), run: () => this.moveChannel(name, voice, 1) })
    }
    return items
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
    if (this.channelDrag?.voice || this.personDrag) {
      this.renderVoiceBar()
      return
    }
    const chat = this.chat
    clear(this.voiceList)
    this.newVoiceButton.classList.toggle('hidden', !chat?.can('channels'))
    const here = this.voice?.state.channel ?? null
    const peers = this.peersById()
    const names = chat?.log.names() ?? new Map<string, string>()
    const avatars = chat?.log.avatars() ?? new Map<string, string>()
    // Kept from you now, or deleted, while you were in it.
    if (chat && here && (!chat.mayEnter(chat.me, here, true) || chat.log.wasDropped(here, true))) queueMicrotask(() => this.leaveVoice())
    const canEdit = chat?.can('channels') === true
    for (const channel of chat?.channelInfo(true) ?? [{ name: DEFAULT_VOICE, label: DEFAULT_VOICE, topic: '', levels: [] }]) {
      const name = channel.name
      const people = this.sessionsByPerson(this.voice?.membersOf(name) ?? [], peers)
      const join = h(
        'button',
        {
          class: 'voice-join',
          title:
            here === name
              ? 'You are in here. Click to leave.'
              : 'Join this voice channel. Everybody in it hears everybody else.',
          on: { click: () => this.clickVoice(name) },
        },
        [icon('volume', 16), h('span', { class: 'truncate grow', text: channel.label })],
      )
      const since = this.channelSince(name)
      const timer = since ? h('span', { class: 'voice-timer', title: 'How long somebody has been in here' }) : null
      if (timer && since) {
        timer.dataset.since = String(since)
        timer.textContent = clockFor(Date.now() - since)
      }
      const head = h('div', { class: `rail-item voice-head${here === name ? ' on' : ''}` }, [
        join,
        timer,
        people.size ? h('span', { class: 'pill', text: String(people.size) }) : null,
      ])
      head.addEventListener('click', (ev) => {
        if ((ev.target as Element).closest('button')) return
        this.clickVoice(name)
      })
      if (canEdit) onContextMenu(head, () => this.voiceChannelActions(channel))
      const row = h('div', { class: 'voice-channel' }, [head])
      if (canEdit) this.orderByHand(row, name, true)
      if (chat?.can('move')) this.takePeople(row, channel)
      for (const [key, ids] of people) {
        row.append(this.voiceMember(key, ids, peers, names.get(key) ?? '', avatars.get(key) ?? ''))
      }
      this.voiceList.append(row)
    }
    this.renderVoiceBar()
    this.renderCameras()
  }

  /** A tile for each camera that is on in your voice channel, yours too. */
  private renderCameras(): void {
    const voice = this.voice
    const here = voice?.state.channel ?? null
    const want = new Map<string, MediaStreamTrack>()
    if (voice && here) {
      for (const id of voice.membersOf(here)) {
        const track = id === this.selfId ? voice.cameraTrack : this.filming.has(id) ? voice.videoOf(id) : null
        if (track) want.set(id, track)
      }
    }
    for (const [id, t] of this.cameraTiles) {
      if (want.has(id)) continue
      t.video.srcObject = null
      t.tile.remove()
      this.cameraTiles.delete(id)
    }
    const peers = this.peersById()
    for (const [id, track] of want) {
      let t = this.cameraTiles.get(id)
      if (!t) {
        const video = document.createElement('video')
        video.autoplay = true
        video.muted = true
        video.playsInline = true
        video.className = 'camera-video'
        const tag = h('div', { class: 'stage-tag camera-tag' })
        const tile = h('div', { class: `camera-tile${id === this.selfId ? ' mine' : ''}` }, [video, tag])
        t = { tile, video, tag, track: null }
        this.cameraTiles.set(id, t)
        this.cameras.append(tile)
      }
      if (t.track !== track) {
        t.track = track
        t.video.srcObject = new MediaStream([track])
        void t.video.play().catch(() => undefined)
      }
      const key = id === this.selfId ? this.chat?.me ?? '' : peers.get(id)?.key ?? ''
      const name = id === this.selfId ? 'You' : (key && this.chat?.nameOf(key)) || peers.get(id)?.name || shortKey(key || id)
      if (t.tag.textContent !== name) t.tag.textContent = name
      t.tile.classList.toggle('talking', !!voice?.isTalking(id))
    }
    this.cameras.classList.toggle('hidden', this.cameraTiles.size === 0)
  }

  private async toggleCamera(): Promise<void> {
    const voice = this.voice
    if (!voice?.state.channel) return
    try {
      await voice.setCamera(!voice.cameraOn)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The camera did not start.', 'bad', 8000)
    }
    this.draw()
  }

  private renderCameraButton(): void {
    const on = this.voice?.cameraOn === true
    const label = on ? 'Turn off camera' : 'Turn on camera'
    if (this.cameraButton.getAttribute('aria-label') === label) return
    clear(this.cameraButton)
    this.cameraButton.setAttribute('aria-label', label)
    this.cameraButton.title = on ? 'Turn off your camera' : 'Turn on your camera for this voice channel'
    this.cameraButton.classList.toggle('on', on)
    this.cameraButton.append(icon(on ? 'video' : 'video-off', 19))
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
    const sounding = ids.map((id) => this.soundingNow(id)).find(Boolean)
    const talking = !!sounding || ids.some((id) => this.voice?.isTalking(id))
    const peer = mine ? null : [...peers.values()].find((p) => ids.includes(p.id) && p.name)
    const name = mine ? this.chat?.displayName ?? 'You' : peer?.name || logName || shortKey(key)
    const label = mine ? `${name} (you)` : name
    const sharing = mine
      ? (this.capture !== null ? this.selfId : null)
      : (ids.find((id) => this.sharers.has(id)) ?? null)
    const id = sharing ?? ids[0]
    const watching = this.watched.has(id)
    const member = h('div', { class: `voice-member${talking ? ' talking' : ''}${sounding ? ' sounding' : ''}` })
    if (sounding) member.dataset.sound = sounding.label
    if (!mine) {
      onContextMenu(member, () => [{ custom: this.volumeBlock(key, name) }])
      member.title = 'Right click for their volume'
      if (this.chat?.can('move')) {
        this.dragPerson(member, key)
        member.title = 'Drag to another voice channel to move them. Right click for their volume'
      }
    }
    const who = h('span', { class: 'truncate grow', text: label })
    const colour = this.chat?.levelOf(key).colour
    if (colour) who.style.color = roleInk(colour)
    member.append(h('i', { class: `dot ${talking ? 'talking' : 'good'}` }), avatarOf(key, name, avatar, 20), who)
    const own = this.voice?.state
    const quiet = mine
      ? own?.deafened
        ? 'deafened'
        : own?.muted
          ? 'muted'
          : null
      : ids.some((i) => this.quiet.get(i) === 'deafened')
        ? 'deafened'
        : (ids.map((i) => this.quiet.get(i)).find(Boolean) ?? null)
    if (quiet) {
      const deaf = quiet === 'deafened'
      member.append(
        h('span', { class: 'voice-quiet', title: deaf ? 'Deafened: hears nobody' : 'Muted' }, [
          icon('mic-off', 14),
          deaf ? icon('headphones-off', 14) : null,
        ]),
      )
    }
    if (mine ? this.voice?.cameraOn : ids.some((i) => this.filming.has(i))) {
      member.append(h('span', { class: 'voice-game voice-camera', title: 'Camera on' }, [icon('video', 14)]))
    }
    const game = mine ? playingNow() : (ids.map((i) => this.playingBy.get(i)).find(Boolean) ?? null)
    if (game) member.append(h('span', { class: 'voice-game', title: `Playing ${game.name}` }, [icon('game', 14)]))
    if (sharing !== null) {
      member.append(
        h('button', {
          class: `live-badge${watching ? ' on' : ''}`,
          text: 'Live',
          title: watching ? 'Stop watching' : `Watch ${label}`,
          ariaLabel: watching ? `Stop watching ${label}` : `Watch ${label}`,
          on: { click: () => this.watch(id) },
        }),
      )
    }
    return member
  }

  /** When the first of the people now in a voice channel came in. */
  private channelSince(name: string): number | null {
    let first = Infinity
    for (const id of this.voice?.membersOf(name) ?? []) {
      const at = id === this.selfId ? this.voice?.state.since : this.voiceSince.get(id)
      if (at && at < first) first = at
    }
    return Number.isFinite(first) ? first : null
  }

  private tickTimers(): void {
    const now = Date.now()
    for (const el of this.voiceList?.querySelectorAll<HTMLElement>('.voice-timer[data-since]') ?? []) {
      const text = clockFor(now - Number(el.dataset.since))
      if (el.textContent !== text) el.textContent = text
    }
  }

  private async sampleLink(): Promise<void> {
    if (!this.voice?.state.channel || this.linkBusy || document.hidden) {
      if (!this.voice?.state.channel) this.link = null
      return
    }
    this.linkBusy = true
    try {
      const peers = await this.voice.quality()
      const mean = (values: (number | null)[]): number | null => {
        const known = values.filter((v): v is number => v !== null)
        return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null
      }
      let serverMs: number | null = null
      const base = this.space.channel?.serving ?? this.server
      if (base) {
        const started = performance.now()
        const res = await fetch(`${base}/api/v1/health`, { mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(4000) }).catch(
          () => null,
        )
        if (res?.ok) serverMs = Math.round(performance.now() - started)
      }
      this.link = {
        peers,
        pingMs: mean(peers.map((p) => p.pingMs)),
        jitterMs: mean(peers.map((p) => p.jitterMs)),
        lossPct: mean(peers.map((p) => p.lossPct)),
        serverMs,
      }
      this.paintLink()
    } finally {
      this.linkBusy = false
    }
  }

  /** good, warn or bad, from the ping and the loss. */
  private linkGrade(): 'good' | 'warn' | 'bad' {
    const link = this.link
    if (!link) return 'good'
    const ping = link.pingMs ?? link.serverMs ?? 0
    const loss = link.lossPct ?? 0
    if (ping > 250 || loss > 5) return 'bad'
    if (ping > 120 || loss > 2) return 'warn'
    return 'good'
  }

  private linkWords(): string {
    const link = this.link
    const ping = link?.pingMs ?? link?.serverMs ?? null
    return ping === null ? 'Connected' : `${Math.round(ping)} ms ping`
  }

  private paintLink(): void {
    const state = this.voiceBar.querySelector('.voice-bar-state')
    if (!state) return
    const grade = this.linkGrade()
    state.classList.remove('good', 'warn', 'bad')
    state.classList.add(grade)
    const signal = this.voiceBar.querySelector('.voice-signal')
    if (signal) {
      signal.classList.remove('good', 'warn', 'bad')
      signal.classList.add(grade)
      signal.setAttribute('title', this.linkWords())
    }
  }

  private linkDetails(): HTMLElement {
    const link = this.link
    const ms = (v: number | null | undefined): string => (v === null || v === undefined ? '...' : `${Math.round(v)} ms`)
    const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '...' : `${v.toFixed(1)}%`)
    const line = (label: string, value: string): HTMLElement =>
      h('div', { class: 'row spread link-line' }, [h('span', { class: 'faint', text: label }), h('span', { text: value })])
    const box = h('div', { class: 'link-box' }, [
      h('div', { class: 'menu-volume-label', text: 'Connection' }),
      line('Average ping', ms(link?.pingMs)),
      line('Server', ms(link?.serverMs)),
      line('Jitter', ms(link?.jitterMs)),
      line('Packet loss', pct(link?.lossPct)),
    ])
    const peers = this.peersById()
    if (link?.peers.length) {
      box.append(h('div', { class: 'menu-line' }), h('div', { class: 'menu-volume-label', text: 'To each person' }))
      for (const p of link.peers) {
        const key = peers.get(p.peerId)?.key ?? ''
        const name = (key && this.chat?.nameOf(key)) || shortKey(key || p.peerId)
        box.append(line(name, `${ms(p.pingMs)}${p.lossPct ? ` · ${pct(p.lossPct)} lost` : ''}`))
      }
    } else if (link) {
      box.append(h('div', { class: 'tiny faint', text: 'Nobody else is in here, so the ping is to the server.' }))
    }
    return box
  }

  private renderVoiceBar(): void {
    const state = this.voice?.state
    this.voiceBar.classList.toggle('hidden', !state?.channel)
    if (state?.channel) {
      clear(this.voiceBar)
      const call = isCallChannel(state.channel)
      const grade = this.linkGrade()
      const signal = h(
        'button',
        {
          class: `ghost icon-only voice-signal ${grade}`,
          title: this.linkWords(),
          ariaLabel: 'Connection details',
          data: { menu: 'link' },
        },
        [icon('signal', 18)],
      )
      signal.addEventListener('click', () => {
        if (!this.link) void this.sampleLink()
        openMenu(signal, [{ custom: this.linkDetails() }])
      })
      this.renderCameraButton()
      const tools = [
        h(
          'button',
          {
            class: `voice-tool${state.muted ? ' danger on' : ''}`,
            title: state.muted ? 'Unmute' : 'Mute',
            ariaLabel: state.muted ? 'Unmute' : 'Mute',
            on: { click: () => this.voice?.setMuted(!state.muted) },
          },
          [icon(state.muted ? 'mic-off' : 'mic', 19)],
        ),
        h(
          'button',
          {
            class: `voice-tool${state.deafened ? ' danger on' : ''}`,
            title: state.deafened ? 'Undeafen' : 'Deafen: hear nobody, and mute yourself',
            ariaLabel: state.deafened ? 'Undeafen' : 'Deafen',
            on: { click: () => this.voice?.setDeafened(!state.deafened) },
          },
          [icon(state.deafened ? 'headphones-off' : 'headphones', 19)],
        ),
        this.cameraButton,
        ...(call || !this.chat?.can('soundboard') ? [] : [this.boardButton]),
        this.shareButton,
      ]
      this.voiceBar.append(
        h('div', { class: 'voice-bar-top' }, [
          // The signal shows how good the link is, in place of a dot, and opens the details.
          signal,
          h('div', { class: 'voice-bar-text' }, [
            h('span', { class: `voice-bar-state ${grade}` }, [h('span', { class: 'truncate', text: 'Connected' })]),
            h('span', {
              class: 'tiny faint truncate',
              text: call
                ? `Call with ${this.chat?.nameOf(this.space.call?.with ?? '') || 'somebody'}`
                : `${state.channel} / ${this.chat?.spaceName() || 'this space'}`,
            }),
          ]),
          h(
            'button',
            {
              class: 'voice-tool voice-leave',
              title: 'Leave voice',
              ariaLabel: 'Leave',
              on: { click: () => this.leaveVoice() },
            },
            [icon('phone-off', 24)],
          ),
        ]),
        h('div', { class: `voice-tools${tools.length === 3 ? ' three' : tools.length === 5 ? ' five' : ''}` }, tools),
      )
    }
  }

  /** A click on a voice channel joins it, or leaves it when you are in it already. */
  private clickVoice(name: string): void {
    if (this.voice?.state.channel === name) this.leaveVoice()
    else void this.joinVoice(name)
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
    // Only to a voice channel there is, that this person may go in, and not the one they are in.
    if (!this.chat.channelInfo(true).some((c) => c.name === channel)) return
    if (!this.chat.mayEnter(me, channel, true) || this.voice?.state.channel === channel) return
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
    this.space.leaveVoice()
    this.announceMe()
    this.draw()
  }

  private async moveTo(key: string, channel: string): Promise<void> {
    if (!this.room || !this.chat?.can('move')) return
    const sessions = (this.mesh?.peers() ?? []).filter((p) => p.key === key)
    // The device of theirs that is in voice, if one is: that is the one to move.
    const peer = sessions.find((p) => this.voice?.whereIs(p.id)) ?? sessions[0]
    if (!peer) {
      toast('They are not here right now.', 'warn', 4000)
      return
    }
    const label = this.chat.channelInfo(true).find((c) => c.name === channel)?.label ?? channel
    if (this.voice?.whereIs(peer.id) === channel) return
    if (!this.chat.mayEnter(key, channel, true)) {
      toast(`Their level may not go in ${label}.`, 'warn', 5000)
      return
    }
    const by = loadIdentity().pubkey
    const at = Date.now()
    const sig = await signClaim(['vmove', this.room.id, key, channel, at])
    void this.bus?.send({ type: 'vmove', to: peer.id, data: { channel, by, at, sig } })
    toast(this.voice?.whereIs(peer.id) ? `Moved them to ${label}` : `Asked them to join ${label}`, 'good', 4000)
  }

  private personMenu(key: string, role: string, you: boolean, here: boolean): MenuEntry[] {
    const actions = this.actionsFor(key, role, you, here)
    const game = you ? null : this.gameOf(key)
    // A person's volume is set in the voice channel on the left, where you hear them.
    const blocks: MenuEntry[][] = [game ? [{ custom: gameCard(game) }] : [], actions].filter((b) => b.length)
    return blocks.flatMap((b, i) => (i ? ['line' as const, ...b] : b))
  }

  /** What the person plays now, on any of their devices. */
  private gameOf(key: string): Playing | null {
    for (const peer of this.mesh?.peers() ?? []) {
      const game = peer.key === key ? this.playingBy.get(peer.id) : undefined
      if (game) return game
    }
    return null
  }

  private volumeBlock(key: string, name: string): HTMLElement {
    const value = h('span', { class: 'tiny faint' })
    const range = h('input', {
      type: 'range',
      min: '0',
      max: String(LOUDEST * 100),
      step: '1',
      ariaLabel: `Volume for ${name}`,
      title: 'Double click for 100%',
    })
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
    const set = (percent: number): void => {
      // Held a little at 100, where the slider is hard to land by hand.
      range.value = String(Math.abs(percent - 100) <= SNAP_PERCENT ? 100 : percent)
      setVolumeFor(key, Number(range.value) / 100)
      if (mutedFor(key)) setMutedFor(key, false)
      paint()
    }
    range.addEventListener('input', () => set(Number(range.value)))
    range.addEventListener('dblclick', () => set(100))
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
    if (here && !you && auth.can(me, 'move')) {
      // Every voice channel they may go in and are not in: a drag does the same, where there is a mouse.
      const theirs = (this.mesh?.peers() ?? []).filter((p) => p.key === key).map((p) => this.voice?.whereIs(p.id)).find(Boolean)
      const into = chat.channelInfo(true).filter((c) => c.name !== theirs && chat.mayEnter(key, c.name, true))
      if (into.length) {
        items.push('line', { heading: 'Move to' })
        for (const c of into) {
          items.push({
            label: c.label,
            lead: h('span', { class: 'menu-icon' }, [icon('volume', 16)]),
            note: c.name === standing ? 'The voice channel you are in' : undefined,
            run: () => void this.moveTo(key, c.name),
          })
        }
      }
    }
    // A level is changed in the space settings, under Members, not here.
    if (auth.mayRemove(me, key)) {
      items.push('line')
      if (role === 'kicked') {
        items.push({
          label: auth.isBanned(key) ? 'Unban' : 'Let back in',
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
        items.push({
          label: 'Ban',
          note: 'Remove them, and close the old invite links',
          danger: true,
          run: () => void this.ban(key),
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
        playing: null,
        status: 'online',
        statusText: '',
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
      playing: playingNow(),
      status: loadStatus().mode,
      statusText: loadStatus().text,
      sharing: this.capture !== null,
      voice: this.voice?.state.channel ?? null,
      talking: this.voice?.isTalking(this.selfId) ?? false,
    })

    for (const peer of this.mesh?.peers() ?? []) {
      const key = peer.key || peer.id
      const was = rows.get(key)
      const status = this.statusBy.get(peer.id)
      // Invisible: here for voice and calls, and listed with the people who are away.
      const hidden = status?.mode === 'invisible'
      if (hidden && was?.here) continue
      put(key, {
        name: peer.name || was?.name || '',
        here: !hidden,
        status: hidden ? 'online' : (status?.mode ?? 'online'),
        statusText: hidden ? '' : (status?.text ?? ''),
        away: this.away.has(peer.id) && !(was?.here && !was.away),
        playing: this.playingBy.get(peer.id) ?? was?.playing ?? null,
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
    if (this.personDrag) return
    clear(this.peopleList)
    const chat = this.chat
    const roles = chat?.roles() ?? new Map<string, string>()
    const avatars = chat?.log.avatars() ?? new Map<string, string>()

    const visible = order.filter((r) => (roles.get(r.key) ?? 'member') !== 'kicked' || r.you)
    const head = (text: string): HTMLElement => h('div', { class: 'rail-head' }, [h('span', { class: 'eyebrow', text })])
    const draw = (row: PersonRow): void => {
      this.peopleList.append(this.personRow(row, roles.get(row.key) ?? 'member', avatars.get(row.key) ?? ''))
    }

    // As Discord does: whoever is connected is under their level, the highest first, idle or
    // away ones too, and a plain member under Online. Whoever is not connected at all is under
    // Offline, whatever their level.
    const groups = new Map<string, { name: string; rank: number; rows: PersonRow[] }>()
    for (const row of visible) {
      const level = chat?.levelOf(row.key)
      const plain = !level || level.id === MEMBER
      const id = !row.here ? ':offline' : plain ? ':online' : level.id
      const name = !row.here ? 'Offline' : plain ? 'Online' : level.name
      // Online under every level, and Offline last of all.
      const rank = !row.here ? -2 : plain ? -1 : level.rank
      const group = groups.get(id) ?? { name, rank, rows: [] }
      group.rows.push(row)
      groups.set(id, group)
    }
    for (const group of [...groups.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))) {
      this.peopleList.append(head(`${group.name} · ${group.rows.length}`))
      for (const row of group.rows) draw(row)
    }
  }

  private personRow(row: PersonRow, role: string, avatar: string): HTMLElement {
    const label = row.name || shortKey(row.key)
    const level = this.chat?.levelOf(row.key)
    const shown = h('span', { class: 'truncate', text: row.you ? `${label} (you)` : label })
    if (level?.colour) shown.style.color = roleInk(level.colour)

    // Who is talking shows in the voice channel on the left, not here.
    const rowClass = `rail-person${row.here ? '' : ' away'}`
    const person = h('div', { class: rowClass }, [
      h('span', { class: 'person-face' }, [
        avatarOf(row.key, row.name, avatar, 32),
        row.here ? this.presenceDot(row) : null,
      ]),
      h('div', { class: 'person-text' }, [
        h('div', { class: 'row person-line' }, [
          shown,
          role === OWNER
            ? h('span', { class: 'crown', title: 'Made this space' }, [icon('crown', 12)])
            : null,
          role === 'kicked'
            ? h('span', { class: 'tiny faint', text: this.chat?.authority().isBanned(row.key) ? 'banned' : 'removed' })
            : null,
        ]),
        this.personDoing(row),
      ]),
    ])
    // A click, or a right click, opens what you can do about them. Your own row has nothing.
    if (!row.you) {
      person.dataset.menu = `person:${row.key}`
      person.tabIndex = 0
      person.setAttribute('role', 'button')
      person.setAttribute('aria-label', `Actions for ${label}`)
      person.classList.add('has-menu')
      const open = (): void => openMenu(person, this.personMenu(row.key, role, row.you, row.here))
      person.addEventListener('click', open)
      person.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return
        ev.preventDefault()
        open()
      })
      onContextMenu(person, () => this.personMenu(row.key, role, row.you, row.here))
    }
    if (!row.you && row.here && this.chat?.can('move')) this.dragPerson(person, row.key)
    return person
  }

  private presenceDot(row: PersonRow): HTMLElement {
    const look = presenceLook(row.status, row.away)
    return h('i', { class: `dot ${look.dot}`, title: row.you && row.status === 'invisible' ? 'Invisible: you show as offline' : look.words })
  }

  private personDoing(row: PersonRow): HTMLElement | null {
    if (row.sharing) {
      return h('span', { class: 'person-doing live' }, [h('i', { class: 'live-dot' }), 'Sharing their screen'])
    }
    if (row.statusText) {
      return h('span', { class: 'person-doing said', title: row.statusText }, [h('span', { class: 'truncate', text: row.statusText })])
    }
    if (row.playing) {
      const { name, since } = row.playing
      return h('span', { class: 'person-doing game', title: `Playing ${name} ${forHowLong(Date.now() - since)}` }, [
        icon('game', 12),
        h('span', { class: 'truncate', text: `Playing ${name}` }),
      ])
    }
    if (!row.voice) return null
    return h('span', { class: 'person-doing' }, [
      icon('volume-low', 11),
      isCallChannel(row.voice) ? 'In a call' : `In ${row.voice}`,
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
    const status = h('div', { class: 'gif-status tiny faint' })
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
        h(
          'button',
          {
            class: 'ghost icon-only pop-close',
            title: 'Close',
            ariaLabel: 'Close the GIF picker',
            on: { click: () => done() },
          },
          [icon('close', 18)],
        ),
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
      // Never up under the desktop app's title bar.
      pop.style.maxHeight = `${Math.round(at.top - 8 - viewArea().top)}px`
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onAway, true)

    const send = (g: Gif): void => {
      done()
      void this.publish((c) => c.say(gifLink(g), this.channel))
    }

    let asking = 0
    const run = async (): Promise<void> => {
      const mine = ++asking
      const wanted = box.value.trim()
      status.textContent = 'Looking...'
      // Grey tiles hold the grid's shape while the answer comes.
      if (grid.childElementCount === 0) {
        for (let i = 0; i < 12; i++) grid.append(h('div', { class: 'gif-choice gif-skeleton' }))
      }
      const { gifs, from } = await this.findGifs(wanted)
      if (mine !== asking || !pop.isConnected) return
      clear(grid)
      for (const g of gifs) {
        const cell = gifCell(g)
        cell.addEventListener('click', () => send(g))
        grid.append(cell)
      }
      if (gifs.length > 0) {
        clear(status)
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
    const pinned = chat
      .messages(this.channel)
      .filter((m) => m.pinned)
      .sort((a, b) => b.at - a.at)
    const list = h('div', { class: 'pin-list' })
    for (const m of pinned) {
      list.append(
        this.chatPanel.pinnedCard(m, () => {
          closeMenu()
          this.goTo(m)
        }),
      )
    }
    if (pinned.length === 0) list.append(h('div', { class: 'pin-empty faint', text: 'Nothing is pinned here yet.' }))
    openMenu(this.pinsButton, [{ heading: `Pinned in #${this.channel}` }, { custom: list }], { className: 'pins-menu' })
  }

  /** Opens the channel you were in last time, as soon as the space knows it. */
  resumeChannel(name: string): void {
    if (name === this.channel) return
    this.wantChannel = name
    this.draw()
    // History that never lists it: the channel is gone, and general it is.
    void this.space.ready.then(() => window.setTimeout(() => (this.wantChannel = null), RESUME_GIVE_UP_MS))
  }

  /** For a notification's click. Only a channel you may see. */
  openChannelNamed(name: string): void {
    if (this.chat?.channels().includes(name)) this.openChannel(name)
  }

  private openChannel(name: string): void {
    this.showRail(null)
    const hadNote = this.closeNote()
    if (name === this.channel && !this.thread) {
      if (hadNote) this.draw()
      return
    }
    this.chatPanel.keepDraft()
    this.channel = name
    this.thread = null
    this.chatPanel.setThread(null)
    this.chatPanel.setDirect(null)
    this.chatPanel.useDraft(name)
    this.readWhenOpened = this.read[name] ?? 0
    saveScreen({ kind: 'space', room: this.space.room.id, channel: name })
    this.stopWatching()
    this.draw()
  }

  /** "/poll Tea or coffee? tea, coffee, neither" in one line, or prompts for what is missing. */
  private async newPoll(line = ''): Promise<void> {
    const mark = line.search(/[?]/)
    let question = mark === -1 ? '' : line.slice(0, mark + 1).trim()
    let raw = mark === -1 ? '' : line.slice(mark + 1).trim()
    if (!question) question = (await ask('What is the question?', { value: line, ok: 'Next' }))?.trim() ?? ''
    if (!question) return
    if (!raw) raw = (await ask('The answers, separated by commas.', { value: 'Yes, No', ok: 'Ask' }))?.trim() ?? ''
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
    const levels = this.chat.levels().filter((l) => l.id !== OWNER).map((l) => ({ id: l.id, name: l.name, colour: l.colour }))
    const answer = await askChannel(voice, levels)
    if (answer === null) return
    const name = cleanChannel(answer.name)
    if (!name) {
      toast('A channel name needs a letter or a number in it.', 'warn')
      return
    }
    await this.publish((c) => c.makeChannel(name, voice, answer.levels))
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

    this.sharedAt = Date.now()
    chirpStream()
    this.showOwnPreview()
    this.announceMe()
    this.draw()
  }

  /**
   * A share that has just started, in your voice channel or outside voice, plays a sound. One
   * that was already going when this page first heard of it does not.
   */
  private shareIsNew(where: string, lasted: unknown): boolean {
    if (typeof lasted !== 'number' || !Number.isFinite(lasted) || lasted > SHARE_NEW_MS) return false
    return where === NO_VOICE || where === this.voice?.state.channel
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
    const mine = id === this.selfId
    const surface = new VideoSurface({
      muted: true,
      showVolume: true,
      close: mine
        ? { label: 'Stop sharing', icon: 'stop', run: () => void this.toggleShare() }
        : {
            label: 'Stop watching',
            icon: 'close',
            run: () => {
              this.dropTile(id)
              this.announceMe()
              this.draw()
            },
          },
    })
    // Your own screen has no tag: the tab above it says who is watching.
    const tag = h('div', { class: `stage-tag${mine ? ' hidden' : ''}` })
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

  /** Swaps the stage to one share, as a click in the rail does. */
  private switchTo(id: string): void {
    for (const other of [...this.watched.keys()]) if (other !== id) this.dropTile(other)
    if (this.watched.has(id)) {
      this.announceMe()
      this.draw()
      return
    }
    this.watch(id)
  }

  private renderShareList(live: LiveStream[], peers: Map<string, MeshPeer>): void {
    const sharing = this.capture !== null
    // A row like a channel's: what it does, in words.
    this.railShareButton.title = sharing ? 'Stop sharing your screen' : 'Anybody here can share, in voice or not'
    this.railShareButton.classList.toggle('danger', sharing)
    this.railShareButton.replaceChildren(
      icon(sharing ? 'stop' : 'monitor', 16),
      h('span', { class: 'truncate grow', text: sharing ? 'Stop sharing' : 'Share your screen' }),
    )

    clear(this.shareList)
    if (live.length === 0) return
    for (const one of live) {
      const eyes = one.you ? this.watchers.size : this.watcherNames(one.id, peers).length
      const channel = this.sharers.get(one.id)
      const where = one.you
        ? this.voice?.state.channel ?? ''
        : channel && channel !== NO_VOICE
          ? channel
          : ''
      const item = h(
        'button',
        {
          class: `rail-item share-item${this.watched.has(one.id) ? ' on' : ''}`,
          title: one.you ? 'Show your own screen' : `Watch ${one.name}`,
          on: { click: () => this.switchTo(one.id) },
        },
        [
          avatarOf(one.key || one.id, one.you ? (this.chat?.displayName ?? '') : one.name, this.chat?.avatarOf(one.key) ?? '', 20),
          h('span', { class: 'share-words' }, [
            h('span', { class: 'truncate', text: one.you ? 'Your screen' : one.name }),
            where || eyes
              ? h('span', {
                  class: 'tiny faint truncate',
                  text: [where ? `in ${where}` : '', eyes ? `${eyes} watching` : ''].filter(Boolean).join(' · '),
                })
              : null,
          ]),
          h('span', { class: 'share-live', text: 'Live' }),
        ],
      )
      item.dataset.share = one.you ? 'self' : 'peer'
      this.shareList.append(item)
    }
  }

  private renderStreams(): void {
    const peers = this.peersById()
    const live = this.liveHere(peers)
    this.renderShareList(live, peers)
    clear(this.streamBar)
    this.streamBar.classList.toggle('hidden', live.length === 0)

    for (const [id, entry] of this.watched) {
      if (id !== this.selfId) {
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
