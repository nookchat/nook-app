/**
 * A space.
 *
 * This is the app now. Chat is the thing, and a screen share is something that
 * happens inside a channel rather than the reason the room exists. There is no
 * host: everybody in a space is a peer, joined in a mesh, and the space carries
 * on whether or not anyone is sharing.
 *
 * Two kinds of connection live here, deliberately kept apart:
 *
 *   mesh     one data channel to every other member, made once, never
 *            renegotiated. Carries chat.
 *   share    the sharer opens a fresh connection to each watcher, exactly as
 *            before, and is always the offerer. Carries video and audio.
 *
 * Keeping them separate costs one extra handshake per pair while video is
 * running, and buys the absence of every glare and renegotiation problem that
 * one shared connection would have brought.
 */

import { checkSupport, hostBlocker } from '../diagnostics'
import { captureScreen, CaptureError, type ScreenCapture } from '../media/capture'
import { AudioMixer } from '../media/mixer'
import type { Mesh } from '../net/mesh'
import type { Voice } from '../net/voice'
import { UplinkMeter } from '../net/uplink'
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
import type { SpaceRuntime } from '../space/runtime'
import { spaces } from '../space/registry'
import { spaceFace, switcherButton } from './space-switcher'
import { filesFor, isCallChannel } from '../space/runtime'
import { voiceDock } from './call'
import { mutedFor, setMutedFor, setVolumeFor, volumeFor } from '../net/volume'
import { gifs as serverGifs, preview, serverHasGifs } from '../net/server-api'
import { loadIdentity, saveDisplayName, shortKey, signClaim, verifyClaim } from '../store/identity'
import { chirpMessage, isNews, speak } from './sounds'
import { openSoundboard, playSound, soundById, soundByName, SOUNDS } from './soundboard'
import { gifCredential, isClip, searchGifs, serviceLabel, type Gif } from '../store/gifs'
import {
  DEFAULT_CHANNEL,
  DEFAULT_VOICE,
  cleanChannel,
  type ChannelInfo,
  type LogEvent,
  type Message,
} from '../store/log'
import type { RoomChat } from '../store/room-chat'
import { ChatPanel, imageLinks } from './chat-panel'
import { clear, copyText, fmtKbps, h, onPress } from './dom'
import { icon } from './icons'
import { openMenu, type MenuItem, type MenuEntry } from './menu'
import { placeNear } from './emoji'
import { avatarOf } from './chat-panel'
import { loadAvatar } from './avatar'
import type { WindowChrome } from './shell'
import { toast } from './toast'
import { notify } from './notify'
import { VideoSurface } from './video-surface'

/**
 * How long somebody stays in the members list after their last word.
 *
 * A fortnight. Long enough that the people you talk to are always there, short
 * enough that a key used once and abandoned falls off instead of accumulating.
 */
const RECENT_MS = 14 * 24 * 60 * 60 * 1000

const STATS_MS = 2000

/** One person in the members list, however many tabs they have open. */
interface PersonRow {
  key: string
  name: string
  here: boolean
  ready: boolean
  talking: boolean
  sharing: boolean
  voice: string | null
  you: boolean
  /** Here, but with this space behind whatever they are actually doing. */
  away: boolean
}

/** How often to tell the room somebody is writing, at the very most. */

/** One sound this often, from here and from each other person. */
const SOUND_EVERY_MS = 1500

/** One spoken line this often, and the same ration taken of each sender. */
const TTS_EVERY_MS = 5000
/** The most a voice will be made to read in one go. */
const TTS_MAX_CHARS = 280

const TYPING_EVERY_MS = 2000
/** And how long that stays true without another word. */
const TYPING_FOR_MS = 5000

/**
 * What a slash offers. The panel lists them; runCommand is what they mean.
 *
 * takesName marks the ones whose first word is somebody in the room, so the
 * panel can finish the spelling. These are the commands that answer a wrong
 * name with "nobody here is called that", which is a thing worth never seeing.
 */
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

export class SpaceView {
  private readonly root: HTMLElement
  private readonly chrome: WindowChrome | null
  readonly secret: string
  /** The space, running: its log, its channel, and who is in it. */
  readonly space: SpaceRuntime
  private readonly selfId: string
  /** What this screen stops listening to when it closes. */
  private unlisten: (() => void)[] = []
  /** Where a direct message opens: outside the space, on the home screen. */
  private readonly onDirectOut: (space: SpaceRuntime, key: string) => void
  private settings: HostSettings = loadSettings()

  private room: Room | null = null
  private bus: SignalBus | null = null
  private mesh: Mesh | null = null
  private chat: RoomChat | null = null
  private chatPanel: ChatPanel | null = null

  private channel = DEFAULT_CHANNEL
  private drawQueued = false
  /** Whether a password went into deriving this room. Part of which room it is. */
  readonly locked: boolean
  /**
   * The server this space lives on. See backend.ts. Fixed for the life of
   * the space, because everybody in it has to agree.
   */
  readonly server: string
  private spaceTitle!: HTMLSpanElement
  private spaceFace!: HTMLSpanElement
  /** The GIF picker's way out, while it is open. */
  private gifClose: (() => void) | null = null
  /** Voice running in another space, with the way to end it. */
  private dock: { root: HTMLElement; stop(): void } = { root: h('div', { class: 'hidden' }), stop: () => undefined }
  private voice: Voice | null = null
  private stopped = false
  private timers: number[] = []
  /** Back to the list of spaces, from the close button or from leaving. */
  private readonly onLeave: () => void
  /** True once this device has given the space up, so nothing writes it back. */
  private forgotten = false
  /** True while this device is the one closing the space down. */
  private closing = false
  /**
   * True once the log has been read and the room can be drawn truthfully.
   *
   * Between the shell being laid out and the store answering there is about a
   * frame and a half, and it used to be spent showing a room that did not
   * exist: "Unnamed space", no messages, and nobody here. A third of a tenth of
   * a second of confident wrong is what a flash is.
   */
  private loaded = false
  /** True while the settings screen is up rather than the space itself. */
  private settingsOpen = false

  // Sharing, when this person is the one doing it.
  private capture: ScreenCapture | null = null
  private mixer: AudioMixer | null = null
  private outStream: MediaStream | null = null
  private readonly watchers = new Map<string, HostPeer>()
  private gpu: HardwareProbe = NO_HARDWARE
  private readonly uplink = new UplinkMeter()

  /**
   * Watching, when other people are sharing. One entry per screen on the
   * stage, our own preview included under our own session id, so two streams
   * split the stage rather than fighting over it. The preview entry has no
   * peer, because our own screen does not cross the network to reach us.
   */
  private readonly watched = new Map<
    string,
    { peer: ViewerPeer | null; surface: VideoSurface; tile: HTMLElement; tag: HTMLElement }
  >()
  /** Who is sharing, and in which channel. */
  private readonly sharers = new Map<string, string>()
  private streamBar!: HTMLDivElement

  /** The newest signed move heard per admin key, so a recorded one replays as nothing. */
  private readonly vmoveSeen = new Map<string, number>()
  /** Which streams each session says it is watching, from their announcements. */
  private readonly watchingBy = new Map<string, string[]>()
  /** When the last sound was played from here. */
  private soundSentAt = 0
  /** When each person was last allowed to make a noise here. */
  private readonly soundHeard = new Map<string, number>()
  /** When the last spoken line left here. */
  private ttsSentAt = 0
  /** When each sender was last given the floor, so a flood is not a filibuster. */
  private readonly ttsHeard = new Map<string, number>()
  /** Whether the no-relay warning has been said for this outage. */
  private serverWarned = false
  private serverTimer: number | null = null

  // Elements redrawn in place.
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
  private channelTitle!: HTMLDivElement
  private searchInput!: HTMLInputElement
  private searchWrap!: HTMLDivElement
  private searchResults!: HTMLDivElement
  /** The name list under the search box, while from: is being written. */
  private searchNames: HTMLDivElement | null = null
  private pinsButton!: HTMLButtonElement
  private channelsButton!: HTMLButtonElement
  private peopleButton!: HTMLButtonElement
  /** You, at the foot of the channels: your face, your name, and the status line. */
  private meFace!: HTMLSpanElement
  private meName!: HTMLSpanElement
  /** Whether the members column is folded away, on a screen wide enough for it. */
  private membersHidden = false
  /** Which rail is showing over the conversation, on a narrow screen. */
  private railOpen: 'left' | 'right' | null = null

  /** The thread being read, if any. Its root is a message in this space. */
  private thread: string | null = null
  /** The person being written to privately, if any. */
  private direct: string | null = null
  /** How far this device has read in each private conversation. */
  private readDm: Record<string, number> = {}
  /**
   * How far this device has read in each channel, and what it had read when the
   * channel was opened.
   *
   * Two marks rather than one. The stored mark moves as you read, so the badge
   * empties; the opening mark stays put, so the line drawn across the log stays
   * where you left off instead of sliding down with every arrival.
   */
  private read: Record<string, number> = {}
  private openedAt = 0
  /** Which peers have said their tab is in the background, by session id. */
  private readonly away = new Set<string>()
  /** Who is typing, by key, and when they last said so. */
  private readonly typing = new Map<string, { channel: string; at: number }>()
  private lastTypingSent = 0
  /** Unread mentions across the whole space, for the tab title. */
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
    chrome?.setActions({
      minimise: () => this.root.classList.toggle('rail-hidden'),
      maximise: () => [...this.watched.values()][0]?.surface.requestFullscreen(),
      close: () => {
        this.destroy()
        onLeave()
      },
    })
  }

  get isLive(): boolean {
    return this.capture !== null || this.watchingAnyone()
  }

  /** Whether any screen but our own preview is on the stage. */
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
    this.chatPanel?.setFiles(filesFor(space))
    const chat = space.chat
    this.chat = chat
    this.bus = space.bus
    this.mesh = space.mesh
    this.chatPanel?.setMe(chat.me)
    this.chatPanel?.setName(chat.displayName)
    // The channel it opens on, so what is half written there is kept on leaving it.
    this.chatPanel?.useDraft(this.channel)
    // Where this device had got to, per channel, and where the line goes today.
    this.read = { ...(space.note?.read ?? {}) }
    this.readDm = { ...(space.note?.readDm ?? {}) }
    this.openedAt = this.read[this.channel] ?? 0

    /*
     * Calls and screen shares belong to this screen. The space's TURN
     * credentials are fetched now and not waited for: nothing needs them
     * until somebody shares or talks.
     */
    void fetchIce(this.server).then((ice) => {
      if (!this.stopped) useServedIce(ice.iceServers, ice.relayOnly)
    })
    // Voice belongs to the space, so a call carries on when this screen goes.
    this.voice = space.voice

    // What this screen adds to who you are: what you share, watch and stand in.
    space.extras = () => ({
      sharing: this.capture ? this.voice?.state.channel ?? undefined : undefined,
      // Whose streams are on this screen, so everybody can say who is watching.
      watching: this.watchingAnyone()
        ? [...this.watched.keys()].filter((id) => id !== this.selfId)
        : undefined,
    })

    this.unlisten.push(
      space.on('changed', () => this.draw()),
      space.on('voice', () => this.draw()),
      space.on('signal', (env) => void this.onSignal(env)),
      space.on('data', (from, raw) => void this.onMeshData(from, raw)),
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
    // Who is here, and what they are doing, as they last said it.
    for (const env of space.presence.values()) void this.onSignal(env)

    // The rest of the cluster is known by now, so the address bar names it too.
    setLinkSecret(this.secret, this.locked, this.server)
    void probeHardwareEncoders(availableCodecs()).then((probe) => (this.gpu = probe))

    this.timers.push(window.setInterval(() => void this.tick(), STATS_MS))
    // Coming back to the tab is reading it, so the marks move then and not
    // while it was away.
    document.addEventListener('visibilitychange', this.onVisible)
    window.addEventListener('keydown', this.onShortcut)
    this.draw()
    this.status()
  }

  /** Back on screen: draw, which marks what is on it as read. */
  private readonly onVisible = (): void => {
    /*
     * Say so at once, in both directions.
     *
     * The roster is drawn from announcements that go out every few seconds, so
     * without this, coming back to the tab left you orange to everybody else
     * for as long as it took the next one to leave, and going away left you
     * green for the same. A change in whether you are looking is exactly the
     * moment worth spending a message on.
     */
    this.announceMe()
    this.draw()
  }

  /**
   * Search is one key away, the way it is everywhere else.
   *
   * Held as a field so it can be taken off the window again: a listener that
   * outlives the space it belongs to would search a room that is gone.
   */
  private readonly onShortcut = (ev: KeyboardEvent): void => {
    // A drawer over the conversation goes away on escape, before anything else
    // gets a look at the key.
    if (ev.key === 'Escape' && this.railOpen) {
      this.showRail(null)
      return
    }
    /*
     * Escape takes the stream off your screen. In fullscreen the browser
     * spends the same press on leaving fullscreen, and both happen at once,
     * which is what pressing escape on a fullscreen stream means: out.
     * Not while writing, though, where escape already means "put that down",
     * and not while a menu is up, where it means "close that".
     */
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
    // The microphone, from anywhere, including the middle of a sentence.
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === 'm') {
      ev.preventDefault()
      const state = this.voice?.state
      if (!state?.channel) {
        toast('You are not in a voice channel.', 'warn', 2500)
        return
      }
      this.voice?.setMuted(!state.muted)
      toast(state.muted ? 'Microphone on.' : 'Microphone muted.', 'info', 2000)
      this.draw()
      return
    }
    if (!(ev.metaKey || ev.ctrlKey)) return
    if (ev.key.toLowerCase() === 'k') {
      ev.preventDefault()
      this.openSearchBox()
      return
    }
    // The channels in the rail, in the order they are drawn.
    if (/^[1-9]$/.test(ev.key)) {
      const channels = this.chat?.channels() ?? []
      const wanted = channels[Number(ev.key) - 1]
      if (!wanted) return
      ev.preventDefault()
      this.openChannel(wanted)
      this.chatPanel?.focus()
    }
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
    // The space keeps running; this screen just stops listening to it, and
    // stops saying you are sharing or standing in voice.
    for (const off of this.unlisten) off()
    this.unlisten = []
    this.space.extras = () => ({})
    this.space.announce()
    this.bus = null
    useServedIce()
    void bookFor(this.server).flush()
    document.title = 'Nook'
  }

  /**
   * Forget what is filed under sessions the mesh no longer knows.
   *
   * Presence rides announcements keyed by session id, and a tab that dies
   * without a goodbye never takes its announcements back. The mesh evicts the
   * silent session, but the live pill, the away mark and the typing note kept
   * here stayed for ever: a ghost stream card wearing somebody's name, black
   * when clicked. Rejoining made it worse, because the person came back under
   * a fresh session beside their own remains.
   *
   * Only the cosmetic maps. The media connections are left alone on purpose:
   * a relay outage empties the roster while a working stream keeps flowing,
   * and cutting it for a missing announcement would turn every relay hiccup
   * into a dropped screen. Media has its own failure handling.
   */
  private prunePeers(): void {
    const alive = new Set((this.mesh?.peers() ?? []).map((p) => p.id))
    for (const id of [...this.sharers.keys()]) if (!alive.has(id)) this.sharers.delete(id)
    for (const id of [...this.away]) if (!alive.has(id)) this.away.delete(id)
    for (const id of [...this.typing.keys()]) if (!alive.has(id)) this.typing.delete(id)
    for (const id of [...this.watchingBy.keys()]) if (!alive.has(id)) this.watchingBy.delete(id)
  }

  // ---- signalling ----

  private async onSignal(env: Envelope): Promise<void> {
    await this.mesh?.handle(env)

    const data = (env.data ?? {}) as Record<string, unknown>
    switch (env.type) {
      case 'announce': {
        // Where they stand in voice is the space's to track: see space/runtime.ts.
        // Their tab is behind something else, or it is not.
        const wasAway = this.away.has(env.from)
        if (data.away === true) this.away.add(env.from)
        else this.away.delete(env.from)
        if (wasAway !== this.away.has(env.from)) this.draw()
        const sharing = typeof data.sharing === 'string' ? cleanChannel(data.sharing) : ''
        const was = this.sharers.get(env.from)
        if (sharing) this.sharers.set(env.from, sharing)
        else this.sharers.delete(env.from)
        if (was !== sharing) this.draw()
        // Which streams they are watching, so a stream can say who is there.
        // A string still counts, from a tab that has not reloaded since this
        // became a list.
        const eyesRaw = data.watching
        const eyes =
          typeof eyesRaw === 'string'
            ? [eyesRaw]
            : Array.isArray(eyesRaw)
              ? eyesRaw.filter((x): x is string => typeof x === 'string').slice(0, 12)
              : []
        const hadEyes = (this.watchingBy.get(env.from) ?? []).join()
        if (eyes.length) this.watchingBy.set(env.from, eyes)
        else this.watchingBy.delete(env.from)
        if (hadEyes !== eyes.join()) this.draw()
        // Somebody is sharing in the channel we are looking at, so ask to watch.
        /*
         * Somebody starting to share does not put their screen on yours.
         *
         * It used to: the first announcement was answered with a hello and the
         * picture arrived unasked. That is somebody else deciding what is on
         * your screen, and it costs you bandwidth you did not agree to spend.
         * The row of who is live is the offer; watching is a click.
         */
        if (was !== sharing) this.draw()
        // Whoever stopped comes off the stage. Nobody is put on in their place.
        if (!sharing && this.watched.has(env.from)) {
          this.dropTile(env.from)
          this.announceMe()
          this.draw()
        }
        return
      }
      case 'hello': {
        // Only meaningful when we are the one sharing.
        if (!this.outStream) return
        this.watchers.get(env.from)?.close()
        this.watchers.delete(env.from)
        this.admitWatcher(env.from)
        return
      }
      case 'offer': {
        // Only from somebody we asked. Anybody else's offer cannot put a
        // picture on this screen, asked for or not.
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
        /*
         * An ICE line names the connection it belongs to, because one person
         * can hold two with us at once: they watch our screen while we watch
         * theirs. It used to route on who sent it, watchers first, and with
         * both connections up every line of theirs fed the sharing one. The
         * watching one starved, never connected, and drew a black rectangle
         * until a reload emptied the watchers map. A line that does not say
         * (an older peer) falls back to the old guess.
         */
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
        this.watchers.get(env.from)?.close()
        this.watchers.delete(env.from)
        if (this.watched.has(env.from)) this.dropTile(env.from)
        // And everything cosmetic filed under the session that just left, or
        // a tab that said goodbye still leaves a live pill wearing its name.
        this.sharers.delete(env.from)
        this.away.delete(env.from)
        this.typing.delete(env.from)
        this.watchingBy.delete(env.from)
        this.draw()
        return
      }
      default:
        return
    }
  }

  /** Something arrived that was not here before: say so, the way a chat app does. */
  private noticeFresh(fresh: LogEvent[]): void {
    // Somebody else said something, and said it just now rather than last week.
    if (fresh.some((e) => e.kind === 'said' && e.author !== this.chat?.me && isNews(e.at))) {
      chirpMessage()
    }
    this.noticeMentions(fresh)
  }

  private async onMeshData(from: string, raw: string): Promise<void> {
    // Somebody is writing. Not an event: it is true for four seconds and then
    // it is not, and a log is for things that stay true.
    if (this.takeTyping(from, raw)) return
    if (this.takeSound(from, raw)) return
    if (this.takeSpoken(from, raw)) return
  }

  // ---- typing ----

  /**
   * Say that this person is writing, at most every two seconds.
   *
   * It goes over the mesh rather than into the log, and it names a channel, so
   * somebody typing in one channel does not appear to be typing in the one you
   * are reading. Nothing is stored and nothing is signed: the worst a liar can
   * do with it is claim to be about to say something.
   */
  private sayTyping(): void {
    const now = Date.now()
    if (now - this.lastTypingSent < TYPING_EVERY_MS) return
    this.lastTypingSent = now
    this.mesh?.broadcast(JSON.stringify({ t: 'typing', c: this.channel }))
  }

  /** Returns true when this was a typing note rather than a pile of events. */
  private takeTyping(from: string, raw: string): boolean {
    if (!raw.startsWith('{"t":"typing"')) return false
    let note: { t?: string; c?: unknown }
    try {
      note = JSON.parse(raw) as { t?: string; c?: unknown }
    } catch {
      return false
    }
    if (note.t !== 'typing') return false
    /*
     * Kept by session and resolved to a person when it is drawn.
     *
     * It used to be stored under whichever of the two was known at the time,
     * so a note that arrived before that peer's announcement was filed under
     * the session id and the next one under their key. One person, two slots,
     * and the line said they and a string of hex were both typing.
     */
    this.typing.set(from, {
      channel: typeof note.c === 'string' ? cleanChannel(note.c) : DEFAULT_CHANNEL,
      at: Date.now(),
    })
    this.showTyping()
    /*
     * And again once it has run out. Nothing else redraws on a timer, so a
     * line saying somebody is typing would otherwise stay up until the next
     * thing happened in the room.
     */
    window.setTimeout(() => {
      if (!this.stopped) this.showTyping()
    }, TYPING_FOR_MS + 100)
    return true
  }

  /**
   * The soundboard: a noise everybody hears at once.
   *
   * What crosses the wire is the name of a sound, not a sound. Every window
   * builds the noise itself out of oscillators, which is why this costs the
   * same as saying "hi" and cannot be used to push a file at the room.
   *
   * It goes nowhere near the log. A noise is true for one second and a log is
   * for things that stay true, so somebody who arrives later finds the room
   * as quiet as it actually is now.
   *
   * Nothing is said in the channel either. The toast names who pressed it,
   * which is enough to know who to blame, and leaves no scrollback to clear.
   */
  private sendSound(id: string): void {
    const sound = soundById(id)
    if (!sound) return
    const now = Date.now()
    if (now - this.soundSentAt < SOUND_EVERY_MS) {
      toast('One sound at a time.', 'warn')
      return
    }
    this.soundSentAt = now

    // The note goes out either way. Muting yourself is not muting the room,
    // and a mute that silently swallowed the press would look broken.
    if (this.direct) {
      const key = this.direct
      for (const p of this.mesh?.peers().filter((p) => p.key === key) ?? []) {
        this.mesh?.sendTo(p.id, JSON.stringify({ t: 'sound', s: sound.id, d: 1 }))
      }
    } else {
      this.mesh?.broadcast(JSON.stringify({ t: 'sound', s: sound.id, c: this.channel }))
    }

    if (!playSound(sound.id)) {
      toast(`${sound.label} went out. Your own sounds are off in Settings.`, 'info', 4000)
    }
  }

  /** Returns true when this was a sound rather than a pile of events. */
  private takeSound(from: string, raw: string): boolean {
    if (!raw.startsWith('{"t":"sound"')) return false
    let note: { t?: string; s?: unknown }
    try {
      note = JSON.parse(raw) as { t?: string; s?: unknown }
    } catch {
      return false
    }
    if (note.t !== 'sound') return false
    // A name from a newer version of the board. Nothing to play, and nothing
    // worth saying about it.
    const sound = typeof note.s === 'string' ? soundById(note.s) : null
    if (!sound) return true

    // Their ration, kept again here, because it was their client that promised
    // to keep it and a modified client promises nothing.
    const key = this.mesh?.peers().find((p) => p.id === from)?.key || from
    const now = Date.now()
    if (now - (this.soundHeard.get(key) ?? 0) < SOUND_EVERY_MS) return true
    this.soundHeard.set(key, now)

    if (playSound(sound.id)) {
      const who = (key && this.chat?.nameOf(key)) || 'Somebody'
      toast(`${who} played ${sound.label} ${sound.emoji}`, 'info', 3000)
    }
    return true
  }

  /** The board itself, hung off whichever button asked for it. */
  private openBoard(anchor: HTMLElement | null): void {
    const button = anchor ?? this.chatPanel?.soundAnchor
    if (!button) return
    openSoundboard({ anchor: button, onPick: (id) => this.sendSound(id) })
  }

  /**
   * A line said out loud as well as written down.
   *
   * The text goes into the log like any other message, so somebody who was
   * away can still read it. A small note rides the mesh beside it, and every
   * window that catches the note reads the line in the browser's own voice,
   * this one included, because hearing it land is the point. In a private
   * conversation the note goes only to that person's devices.
   *
   * Rationed at both ends, because a voice that cannot be
   * interrupted is a worse nuisance than a shaking window.
   */
  private sendSpoken(arg: string): void {
    const chat = this.chat
    if (!chat || !this.mesh) return
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

    if (this.direct) {
      const key = this.direct
      const sessions = this.mesh.peers().filter((p) => p.key === key)
      for (const p of sessions) this.mesh.sendTo(p.id, JSON.stringify({ t: 'tts', x: text }))
      void this.publish((c) => c.sayDirect(key, text))
    } else {
      this.mesh.broadcast(JSON.stringify({ t: 'tts', c: this.channel, x: text }))
      void this.publish((c) => c.say(text, this.channel))
    }
    speak(text)
  }

  /** Returns true when this was a spoken line rather than a pile of events. */
  private takeSpoken(from: string, raw: string): boolean {
    if (!raw.startsWith('{"t":"tts"')) return false
    let note: { t?: string; x?: unknown }
    try {
      note = JSON.parse(raw) as { t?: string; x?: unknown }
    } catch {
      return false
    }
    if (note.t !== 'tts') return false
    if (typeof note.x !== 'string') return true

    // The sender's ration, enforced again here, because it is their client
    // that promised to keep it.
    const key = this.mesh?.peers().find((p) => p.id === from)?.key || from
    const now = Date.now()
    if (now - (this.ttsHeard.get(key) ?? 0) < TTS_EVERY_MS) return true
    this.ttsHeard.set(key, now)

    speak(note.x.slice(0, TTS_MAX_CHARS))
    return true
  }

  /** Whoever has said something in the last few seconds, in this channel. */
  private showTyping(): void {
    const cutoff = Date.now() - TYPING_FOR_MS
    const peers = this.mesh?.peers() ?? []
    const people = new Map<string, string>()
    for (const [session, note] of this.typing) {
      if (note.at < cutoff) {
        this.typing.delete(session)
        continue
      }
      if (note.channel !== this.channel) continue
      // One name per person, however many tabs of theirs are typing.
      const key = peers.find((p) => p.id === session)?.key || session
      people.set(key, this.chat?.nameOf(key) || shortKey(key))
    }
    this.chatPanel?.setTyping([...people.values()])
  }

  // ---- unread, and being called by name ----

  /**
   * Mark this channel read up to whatever is in it now.
   *
   * Only what is on the screen. A channel you have not opened keeps its count,
   * and a message that arrives while you are looking at another channel is
   * still new when you get there.
   */
  private markRead(channel: string): void {
    /*
     * Not while the tab is put away.
     *
     * Visibility rather than focus. A window nobody can see is not being read,
     * which is the case worth getting right; a window sitting visible behind
     * another one is a coin toss either way, and focus is the reading that
     * makes a message go unread because somebody clicked their terminal.
     */
    if (typeof document !== 'undefined' && document.hidden) return
    const top = this.chat?.highWater(channel) ?? 0
    if (top <= (this.read[channel] ?? 0)) return
    this.read[channel] = top
    void this.remember({ read: this.read })
  }

  /** Somebody said your name, or wrote to you, while you were elsewhere. */
  private noticeMentions(fresh: LogEvent[]): void {
    const chat = this.chat
    if (!chat) return
    // The same list the panel draws with, so a mention of somebody who has just
    // arrived is noticed as well as marked.
    const names = this.everybody()
    for (const e of fresh) {
      if (e.author === chat.me || !isNews(e.at)) continue
      const who = chat.nameOf(e.author) || shortKey(e.author)

      // Direct messages are said on the home screen's behalf, for every space.
      if (e.kind === 'dm') continue

      if (e.kind !== 'said') continue
      const text = String(e.body.text ?? '')
      if (!mentionsMe(text, names, chat.me)) continue
      const where = cleanChannel(String(e.body.channel ?? '')) || DEFAULT_CHANNEL
      notify(`${who} in #${where}`, text, () => this.openChannel(where))
      if (where === this.channel && !this.thread && !this.direct) continue
      toast(`${who} mentioned you in #${where}`, 'info', 8000, {
        label: 'Go',
        run: () => this.openChannel(where),
      })
    }
  }

  // ---- channels ----

  /**
   * What an admin may do with a channel.
   *
   * Renaming changes what it is called and not what it is: every message ever
   * written carries the name it was written in, and nothing in this design
   * rewrites what was signed. So the name routes for ever and the label is what
   * anybody reads, which is what somebody fixing a typo wanted anyway.
   */
  private channelActions(channel: ChannelInfo): MenuItem[] {
    if (!this.chat?.isAdmin) return []
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

  // ---- slash commands ----

  /**
   * A line that starts with a slash.
   *
   * Returns true when it was one, which is what tells the panel to clear the
   * box. Anything unknown says so rather than being sent as a message, because
   * a typo'd command posted to everybody is the worst of both.
   */
  private runCommand(line: string): boolean {
    const [word, ...rest] = line.slice(1).split(' ')
    const name = word.toLowerCase()
    const arg = rest.join(' ').trim()
    const chat = this.chat
    if (!chat) return false

    const needsAdmin = (): boolean => {
      if (chat.isAdmin) return false
      toast('Only an admin can do that.', 'warn')
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
        // No name opens the board. A name plays it, which is what somebody
        // who already knows the board wants and is faster than opening it.
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
        /*
         * The arm and both underscores are escaped for the formatter, or it
         * eats them: the backslash is a shrug's shoulder and the underscores
         * are what it is standing on.
         */
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
        /*
         * The longest name this line starts with, rather than its first word,
         * because plenty of people are called two words and the box will now
         * spell those out for you.
         */
        const wanted = arg.toLowerCase()
        const found = [...this.everybody()]
          .filter(([, who]) => {
            const low = who.toLowerCase()
            return low !== '' && (wanted === low || wanted.startsWith(`${low} `))
          })
          .sort((a, b) => b[1].length - a[1].length)[0]
        if (!found) {
          toast(`Nobody here is called ${arg.split(' ')[0] || 'that'}.`, 'warn')
          return true
        }
        const text = arg.slice(found[1].length).trim()
        this.openDirect(found[0])
        if (text) void this.publish((c) => c.sayDirect(found[0], text))
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
        toast(
          COMMANDS.map((c) => `/${c.name}`).join('  '),
          'info',
          9000,
        )
        return true
      }
      default:
        toast(`There is no /${name}. Try /help.`, 'warn')
        return true
    }
  }

  // ---- private messages ----

  /**
   * Open a conversation with one person, or close the one that is open.
   *
   * It takes over the panel, the way a thread does, because it is the same
   * thing from the panel's side: a different slice of the same log, with a
   * different place for what you write to go.
   */
  /**
   * A private conversation opens outside the space, on the home screen, where
   * every conversation from every space is listed. It still belongs to this
   * space: that is where it is kept, and who it is with is somebody from here.
   */
  private openDirect(key: string | null): void {
    if (key) {
      this.onDirectOut(this.space, key)
      return
    }
    this.showRail(null)
    this.chatPanel?.keepDraft()
    this.direct = key
    this.thread = null
    this.chatPanel?.setThread(null)
    this.chatPanel?.setDirect(key)
    this.closeSearch()
    if (key) {
      this.chatPanel?.useDraft(`dm:${key}`)
      this.markDirectRead(key)
    } else {
      this.chatPanel?.useDraft(this.channel)
    }
    this.drawNow()
    if (key) this.chatPanel?.focus()
  }

  /** Whatever is on the screen in a private conversation counts as read. */
  private markDirectRead(key: string): void {
    if (typeof document !== 'undefined' && document.hidden) return
    const top = this.chat?.directHighWater(key) ?? 0
    if (top <= (this.readDm[key] ?? 0)) return
    this.readDm[key] = top
    this.chat?.setDirectRead(this.readDm)
    void this.remember({ readDm: this.readDm })
  }

  // ---- threads ----

  /**
   * Open the thread hanging off a message, or close the one that is open.
   *
   * The thread takes over the panel rather than opening a third column. There
   * is no room for one on a laptop beside two rails, and a thread is a
   * conversation you are reading rather than a thing you glance at.
   */
  private openThread(rootId: string | null): void {
    this.showRail(null)
    this.chatPanel?.keepDraft()
    this.thread = rootId
    this.chatPanel?.useDraft(rootId ? `thread:${rootId}` : this.channel)
    this.chatPanel?.setThread(rootId)
    this.closeSearch()
    this.drawNow()
    if (rootId) this.chatPanel?.focus()
  }

  // ---- search ----

  /**
   * Everything in this space that matches, newest first.
   *
   * Every channel and every thread, because "where did I say that" is the
   * question being asked and the answer is rarely in the channel you happen to
   * be standing in.
   */
  private renderSearch(): void {
    const raw = this.searchInput.value.trim()
    clear(this.searchResults)
    this.searchResults.classList.toggle('hidden', raw.length === 0)
    if (!raw || !this.chat) return

    /*
     * from: in: has: and the words.
     *
     * Worth having because the question is rarely "where is this word": it is
     * "what did she say in that channel about the release", and the three
     * filters are the difference between forty hits and four. Anything that is
     * not a filter is a word to look for, so a stray colon costs nothing.
     */
    const filters = { from: '', in: '', has: '' }
    const words: string[] = []
    for (const part of raw.split(/\s+/)) {
      const at = part.indexOf(':')
      const key = at === -1 ? '' : part.slice(0, at).toLowerCase()
      const value = at === -1 ? '' : part.slice(at + 1).toLowerCase()
      if (value && (key === 'from' || key === 'in' || key === 'has')) filters[key] = value
      else words.push(part.toLowerCase())
    }
    const query = words.join(' ')

    const names = this.chat.log.names()
    const channels = this.chat.channelInfo()
    const hits = this.chat.log
      .messages()
      .filter((m) => {
        if (query && !m.text.toLowerCase().includes(query)) return false
        if (filters.from) {
          const who = (names.get(m.author) ?? '').toLowerCase()
          if (!who.startsWith(filters.from) && !m.author.startsWith(filters.from)) return false
        }
        if (filters.in) {
          const label = (channels.find((c) => c.name === m.channel)?.label ?? m.channel).toLowerCase()
          if (!m.channel.startsWith(filters.in) && !label.startsWith(filters.in)) return false
        }
        if (filters.has === 'link' && !/https?:\/\//.test(m.text)) return false
        if (filters.has === 'image' && imageLinks(m.text).length === 0) return false
        if (filters.has === 'code' && !m.text.includes('`')) return false
        if (filters.has === 'poll' && !m.poll) return false
        return true
      })
      .sort((a, b) => b.lamport - a.lamport)
      .slice(0, 40)

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
        text: `${hits.length}${hits.length === 40 ? '+' : ''} in this space`,
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

  /** Take somebody to a message, wherever it is. */
  private goTo(m: Message): void {
    this.closeSearch()
    if (m.inThread && m.replyTo) this.openThread(m.replyTo)
    else if (this.thread) this.openThread(null)
    if (m.channel !== this.channel) this.openChannel(m.channel)
    this.drawNow()
    window.setTimeout(() => this.chatPanel?.jump(m.id), 40)
  }

  private closeSearch(): void {
    this.searchInput.value = ''
    this.searchResults.classList.add('hidden')
    clear(this.searchResults)
    this.closeSearchNames()
    this.searchWrap?.classList.remove('open')
  }

  /**
   * The people, while from: is being written in the search box.
   *
   * The same offer the chat box makes when a command wants a person, because
   * the question is the same one: how does the room spell them. What goes in
   * is the first word of the name, which is all a filter split on spaces can
   * hold, and it is enough because from: matches the start of a name.
   */
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
          // The blur a click causes would close the list before the pick, so
          // the pick happens on the way down.
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

  /** Arrows, Enter, Tab and Escape, while that list is up. */
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
      const chosen = options[at === -1 ? 0 : at]
      const who = chosen?.textContent ?? ''
      if (who) this.takeSearchName(who)
      ev.preventDefault()
      return true
    }
    // Escape puts the list down first, which leaves the search you typed alone.
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
    // A filter is one word, so a name of two takes the first of them.
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

  // ---- chat ----

  /**
   * Write something. The sending is the log's job, not this one's.
   *
   * See RoomChat.onLocal: every event written anywhere goes out through one
   * hook, so a new kind of event cannot be added and quietly not shared.
   */
  private async publish(make: (chat: RoomChat) => Promise<unknown>): Promise<void> {
    if (!this.chat) return
    await make(this.chat)
  }

  /**
   * Redraw at most once a frame.
   *
   * Announcements, presence sweeps, chat merges and the stats tick all want a
   * redraw, and together they were rebuilding the rail many times a second. That
   * is wasted work, and it made the buttons move under the pointer.
   */
  private draw(): void {
    if (this.stopped || this.drawQueued) return
    this.drawQueued = true
    requestAnimationFrame(() => {
      this.drawQueued = false
      this.drawNow()
    })
  }

  private drawNow(): void {
    if (this.stopped || !this.chat) return
    if (!this.loaded) {
      this.loaded = true
      this.shell.classList.remove('loading')
    }
    if (this.chatPanel) this.chatPanel.canPin = this.chat.isAdmin
    this.chatPanel?.setNames(this.everybody(), this.chat.log.avatars())
    this.chatPanel?.setReadMark(this.thread ? 0 : this.openedAt)
    /*
     * A thread, or the channel. The thread is the same panel showing a
     * different slice of the same log, which is why replying, reacting,
     * editing and pinning all work in it without a line of their own.
     */
    if (this.direct) {
      const name = this.chat.nameOf(this.direct) || shortKey(this.direct)
      this.chatPanel?.setIntro({
        title: name,
        text: `This is the start of your private conversation with ${name}. It is sealed so that only the two of you can read it.`,
      })
      this.chatPanel?.setDirect(this.direct, name)
      this.chatPanel?.render(this.chat.directWith(this.direct))
      this.chatPanel?.setTitle(name)
      this.markDirectRead(this.direct)
    } else if (this.thread) {
      const thread = this.chat.threadOf(this.thread)
      // The root going away takes the thread with it: there is nothing left to
      // hang it on, and a thread whose question is gone is a list of answers.
      if (thread.length === 0) {
        this.openThread(null)
        return
      }
      this.chatPanel?.render(thread)
      this.chatPanel?.setTitle(`Thread in #${this.channel}`)
    } else {
      const info = this.chat.channelInfo().find((c) => c.name === this.channel)
      const label = info?.label ?? this.channel
      this.chatPanel?.setIntro({
        title: `Welcome to #${label}`,
        text: info?.topic || `This is the start of #${label}.`,
      })
      this.chatPanel?.render(this.chat.messages(this.channel))
      this.chatPanel?.setTitle('Chat')
    }
    // The pushpin shows when the channel on screen has something pinned.
    const pinnedHere =
      this.direct || this.thread
        ? 0
        : this.chat.messages(this.channel).filter((m) => m.pinned).length
    this.pinsButton.classList.toggle('hidden', pinnedHere === 0)
    if (pinnedHere > 0) {
      this.pinsButton.title =
        pinnedHere === 1 ? 'One pinned message' : `${pinnedHere} pinned messages`
    }

    // The header says what the rail says: the label an admin chose, and the
    // line about what the channel is for when there is one.
    const here = this.chat.channelInfo().find((c) => c.name === this.channel)
    clear(this.channelTitle)
    this.channelTitle.append(
      h('span', { class: 'channel-name' }, [icon('hash', 18), h('span', { class: 'truncate', text: here?.label ?? this.channel })]),
    )
    if (here?.topic) {
      this.channelTitle.append(h('span', { class: 'channel-topic truncate', text: here.topic }))
    }
    // Whatever is on the screen counts as read.
    this.markRead(this.channel)
    this.showTyping()
    /*
     * The name, and the label shown when there is not one yet.
     *
     * Kept apart on purpose. Writing the label down as the title is how the
     * list came to say "Unnamed space" for a space that has a name, and how a
     * space that had one lost it here the moment it was opened before its
     * history arrived.
     */
    const named = this.chat?.spaceName() ?? ''
    const label = named || 'Unnamed space'
    if (this.spaceTitle.textContent !== label) {
      this.spaceTitle.textContent = label
      if (named) void this.remember({ name: named })
    }
    // The colour comes from the room id, which is known a moment after the name box is.
    const faceKey = `${this.room?.id ?? ''}|${named}`
    if (this.room && this.spaceFace.dataset.key !== faceKey) {
      this.spaceFace.dataset.key = faceKey
      this.spaceFace.replaceChildren(spaceFace(this.room.id, named, 24))
    }
    // Somebody with the right to do it has shut the space down. Not us: the
    // one who pressed the button has their own path out, and it waits for the
    // news to leave the building first.
    if (this.chat?.isClosed && !this.closing) void this.acceptClose()
    this.renderChannels()
    this.renderThreads()
    this.renderVoice()
    this.renderPeople()
    this.renderMe()
    this.renderShareButton()
    this.status()
  }

  /** Your own face and name at the foot of the channels. Redrawn only when they change. */
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

  /**
   * Everybody worth naming, by key.
   *
   * The log knows whoever has ever written a profile here. The mesh knows who
   * is connected right now, which includes somebody who joined a moment ago and
   * whose profile is still on its way. Both, so a person who is plainly in the
   * room can be tagged as soon as they are in it.
   */
  private everybody(): Map<string, string> {
    const names = new Map(this.chat?.log.names() ?? [])
    for (const peer of this.mesh?.peers() ?? []) {
      if (!peer.key || !peer.name) continue
      if (!names.has(peer.key)) names.set(peer.key, peer.name)
    }
    return names
  }

  /** Keep this space's note up to date. The space does the keeping. */
  private remember(patch: Parameters<SpaceRuntime['remember']>[0]): Promise<void> {
    if (this.forgotten) return Promise.resolve()
    return this.space.remember(patch)
  }

  private status(): void {
    if (!this.chrome) return
    if (!this.loaded) {
      // Nothing true to say yet, so it says that rather than something else.
      this.chrome.setStatus(['Opening...'])
      return
    }
    const up = (this.bus?.healthList.filter((r) => r.status === 'open').length ?? 0) > 0
    // The same count the list on the right draws, worked out the same way. See
    // roster(): one row per person, whatever they have open.
    const people = this.hereNow()
    const what = this.capture
      ? 'Sharing your screen'
      : this.watchingAnyone()
        ? 'Watching a shared screen'
        : `#${this.channel}`
    // The app first, then where you are. A count of mentions rather than of
    // messages: the number on a tab has to be one worth turning for.
    const name = this.capture ? 'Sharing your screen' : `#${this.channel}`
    this.chrome.setTitle(`Nook | ${this.mentions ? `(${this.mentions}) ` : ''}${name}`)
    // Who is here, and the server only when it is not answering: that is the one time it is news.
    const serving = serverTag(this.space.channel?.serving ?? this.server)
    this.chrome.setStatus([what, `${people} here`, ...(up ? [] : [`cannot reach ${serving}`])])
    // Which one, for whoever wants to know, on the line itself.
    this.chrome.status.title = up ? `Connected to ${serving}` : `Cannot reach ${serving}`
  }

  /**
   * Say it loudly when no server answers.
   *
   * A blocked server looks like a broken app: nobody arrives and nothing
   * syncs, with no error anywhere. A VPN did exactly this to a real person,
   * who spent the evening blaming the app. Ten seconds of silence from every
   * server in the cluster is worth one loud sentence, once per outage.
   */
  private watchServer(): void {
    const open = () => this.bus?.healthList.filter((r) => r.status === 'open').length ?? 0
    if (open() > 0) {
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
      if (this.stopped || this.serverWarned || open() > 0) return
      this.serverWarned = true
      toast(
        `Nook cannot reach ${serverTag(this.server)} or any server in its cluster, so nothing will sync until one answers. They may be down, or this network may block them.`,
        'bad',
        12_000,
      )
    }, 10_000)
  }

  // ---- layout ----

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
    /*
     * The row of who is live in this channel.
     *
     * More than one person can share at once, which the wiring always allowed
     * and nothing ever showed: a watcher attached to whoever announced first
     * and had no way to look at anybody else. One button each, and the one you
     * are watching is pressed in.
     */
    this.streamBar = h('div', { class: 'stream-bar hidden' })
    this.channelTitle = h('div', { class: 'row channel-head' }, [
      h('span', { class: 'channel-name' }, [icon('hash', 18), h('span', { class: 'truncate', text: this.channel })]),
    ])

    // Sharing lives in the voice panel: a screen is shared with a call.
    this.shareButton = h('button', { class: 'ghost icon-only share-button' }, [icon('monitor', 17)])
    this.shareButton.addEventListener('click', () => void this.toggleShare())


    this.chatPanel = new ChatPanel(loadIdentity().name, 'Chat')
    this.chatPanel.showNameField(false)
    this.chatPanel.onPoll = () => void this.newPoll()
    this.chatPanel.onTyping = () => this.sayTyping()
    this.chatPanel.onThread = (rootId) => this.openThread(rootId)
    this.chatPanel.onDirect = (key) => this.openDirect(key)
    this.chatPanel.onCommand = (line) => this.runCommand(line)
    this.chatPanel.streamLive = (key, channel) => this.sharerByKey(key, channel) !== null
    this.chatPanel.onWatch = (key, channel) => this.joinStream(key, channel)
    this.chatPanel.onGif = () => void this.openGifPicker('')
    this.chatPanel.onSound = () => this.openBoard(this.chatPanel?.soundAnchor ?? null)
    this.chatPanel.commands = COMMANDS
    this.chatPanel.actions = {
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
    // Cards under links: the server goes and looks.
    this.chatPanel.previewFor = (url) => preview(this.server, url)
    this.chatPanel.setEnabled(true)

    // Empty rather than a guess. The name arrives with the log.
    this.spaceTitle = h('span', { class: 'space-name truncate', text: '' })
    this.spaceFace = h('span', { class: 'space-face-slot' })
    /*
     * The space's name is the switcher, the way every chat app does it: every
     * other space is behind it, and under them this one's own actions, all of
     * them rare (inviting, settings, leaving).
     */
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
        [icon('settings', 17)],
      ),
      // Home is in the switcher at the top, on a phone too, inside the channels drawer.
    ])

    const left = h('div', { class: 'rail rail-left', role: 'navigation', ariaLabel: 'Channels, threads and conversations' }, [
      // Just the name. Renaming and clearing live in settings, where a thing
      // you do rarely and cannot undo belongs.
      h('div', { class: 'space-title' }, [spaceMenu]),
      h('div', { class: 'rail-scroll' }, [
      h('div', { class: 'rail-head' }, [
        h('span', { class: 'eyebrow', text: 'Text channels' }),
        /*
         * Only the log's admins can make a channel, so only they get the
         * button. It used to show for everybody and do nothing for most of
         * them: the event went out, every peer ignored it, and the person who
         * clicked was left staring at a rail that had not changed.
         */
        (this.newTextButton = h(
          'button',
          {
            class: 'ghost icon-only rail-add hidden',
            title: 'Make a text channel',
            ariaLabel: 'Make a text channel',
            on: { click: () => void this.newChannel(false) },
          },
          [icon('plus', 15)],
        )),
      ]),
      this.channelList,
      h('div', { class: 'rail-head' }, [
        h('span', {
          class: 'eyebrow',
          text: 'Voice channels',
          title: 'Everybody standing in one hears everybody else.',
        }),
        (this.newVoiceButton = h(
          'button',
          {
            class: 'ghost icon-only rail-add hidden',
            title: 'Make a voice channel',
            ariaLabel: 'Make a voice channel',
            on: { click: () => void this.newChannel(true) },
          },
          [icon('plus', 15)],
        )),
      ]),
      this.voiceList,
      this.threadList,
      ]),
      this.dock.root,
      this.voiceBar,
      me,
    ])

    const right = h('div', { class: 'rail rail-right', role: 'complementary', ariaLabel: 'Who is here' }, [
      h('div', { class: 'rail-scroll' }, [this.peopleList]),
    ])

    /*
     * Search.
     *
     * Every event ever seen here is already on this device, so this is a scan
     * over memory rather than a request to anybody. That is worth saying out
     * loud: the thing a chat app usually needs a search cluster for is a loop
     * over an array when the history belongs to you.
     */
    /*
     * The pins, behind a pushpin rather than pinned over the room.
     *
     * They used to be a strip above the conversation, every one of them, all
     * the time, which taxed every reader to save a rare looker-up a click.
     * The pushpin appears when this channel has pins and opens the list.
     */
    this.pinsButton = h('button', {
      class: 'ghost icon-only hidden',
      ariaLabel: 'Pinned messages',
      title: 'Pinned in this channel',
      on: { click: () => this.openPins() },
    })
    this.pinsButton.append(icon('pin', 15))

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
        blur: () => this.closeSearchNames(),
      },
    })
    this.searchResults = h('div', { class: 'search-results hidden' })
    /*
     * Search is an icon until it is wanted, then a field, and an icon again
     * when it is left empty. Ctrl or Cmd with K opens it too.
     */
    const searchBox = h('label', { class: 'search-box' }, [icon('search', 14), this.searchInput])
    const searchToggle = h(
      'button',
      {
        class: 'ghost icon-only search-toggle',
        ariaLabel: 'Search',
        title: 'Search this space (Ctrl K)',
        on: { click: () => this.openSearchBox() },
      },
      [icon('search', 17)],
    )
    this.searchWrap = h('div', { class: 'search-wrap' }, [searchToggle, searchBox])
    this.searchInput.addEventListener('focus', () => this.searchWrap.classList.add('open'))
    this.searchInput.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (!this.searchInput.value && document.activeElement !== this.searchInput) this.searchWrap.classList.remove('open')
      }, 150)
    })

    /*
     * The two rails are drawers on a phone.
     *
     * There is not room for three columns on a screen four hundred pixels wide,
     * and the old answer was to stack the channel list on top of the
     * conversation and give it a third of the height for ever. These slide in
     * over the conversation when they are asked for, and go away again when
     * anything in them is used.
     */
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
    this.channelsButton.append(icon('menu', 16))
    /*
     * Who is here. A drawer on a phone, and on a wide screen the column it
     * opens folds away instead, for the conversation or a screen share that
     * wants the width.
     */
    this.peopleButton = h('button', {
      class: 'ghost icon-only people-button',
      ariaLabel: 'Who is here',
      title: 'Who is here, and the invite',
      on: {
        click: () => {
          if (window.matchMedia('(max-width: 780px)').matches) {
            this.showRail(this.railOpen === 'right' ? null : 'right')
            return
          }
          this.membersHidden = !this.membersHidden
          this.shell.classList.toggle('members-hidden', this.membersHidden)
          this.peopleButton.classList.toggle('on', !this.membersHidden)
        },
      },
    })
    this.peopleButton.classList.add('on')
    this.peopleButton.append(icon('people', 16))

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

  private async openSettings(): Promise<void> {
    // Loaded the first time it is wanted: most visits never open it.
    const { settingsView } = await import('./settings-view')
    if (this.stopped) return
    clear(this.root)
    this.settingsOpen = true
    this.root.append(
      settingsView({
        rename: (name, avatar) => this.rename(name, avatar),
        space: {
          name: this.chat?.spaceName() || 'Unnamed space',
          admin: this.chat?.isAdmin === true,
          rename: () => this.renameSpace(),
          reset: () => this.resetSpace(),
          leave: () => this.leaveSpace(),
          remove: () => this.deleteSpace(),
          // Removed people live here rather than in the rail, with the one
          // thing an admin can still do about them.
          removed: [...(this.chat?.roles() ?? new Map<string, string>())]
            .filter(([, role]) => role === 'kicked')
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
    if (!this.chat?.isAdmin) {
      toast('Only an admin can rename this space.', 'warn')
      return
    }
    const raw = window.prompt('Name this space', this.chat.spaceName()) ?? ''
    const name = raw.trim().slice(0, 32)
    if (!name) return
    await this.publish((c) => c.setSpaceName(name))
    await this.remember({ name })
    // The card that holds the button shows the name. Renaming from it and
    // leaving it saying the old name is the same disagreement in one screen.
    if (this.settingsOpen) void this.openSettings()
  }

  /** Slide a rail in over the conversation, or put both away. */
  private showRail(which: 'left' | 'right' | null): void {
    this.railOpen = which
    this.shell.classList.toggle('rail-left-open', which === 'left')
    this.shell.classList.toggle('rail-right-open', which === 'right')
    // A button that opens a drawer says whether the drawer is open.
    this.channelsButton?.setAttribute('aria-expanded', String(which === 'left'))
    this.peopleButton?.setAttribute('aria-expanded', String(which === 'right'))
  }

  /** Back to the list of spaces, keeping this one. */
  private openSearchBox(): void {
    this.searchWrap.classList.add('open')
    this.searchInput.focus()
    this.searchInput.select()
  }

  private goHome(): void {
    this.destroy()
    this.onLeave()
  }

  /**
   * Walk out of a space and take this device's copy with you.
   *
   * Local, and it says so. Nothing is announced, because leaving is nobody
   * else's business and there is no membership list on a server to be struck
   * off. The link keeps working, so coming back is the same click it was.
   */
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

  /**
   * Shut a space down for everybody who reads the log.
   *
   * Admins only, checked here for the message and in the log for the answer:
   * every device works out for itself whether the close was signed by somebody
   * with the right to write it, so a close from anybody else changes nothing
   * anywhere.
   */
  private async deleteSpace(): Promise<void> {
    if (!this.chat?.isAdmin) {
      toast('Only an admin can delete this space.', 'warn')
      return
    }
    const name = this.chat.spaceName() || 'this space'
    const ok = window.confirm(
      `Delete ${name} for everybody? Every device in it now, and every device that syncs later, forgets the space and its history. It cannot be undone, and anybody who exported a copy first still has that copy.`,
    )
    if (!ok) return
    this.closing = true
    await this.publish((c) => c.closeSpace())
    // A moment for the close to reach whoever is connected, since leaving takes
    // the connections with it.
    await new Promise((done) => window.setTimeout(done, 400))
    await this.forget(true)
    toast('Deleted. Everybody who is here, or who syncs later, loses it too.', 'info', 7000)
  }

  /** Somebody else deleted it while we were standing in it. */
  private async acceptClose(): Promise<void> {
    if (this.forgotten) return
    await this.forget(true)
    toast('An admin deleted this space.', 'warn', 7000)
  }

  /**
   * Take the space off your list, and go back to the list.
   *
   * A space that was closed keeps its note, marked closed, rather than going
   * altogether: forgetting it outright means the link opens a fresh empty room
   * a minute later, which looks exactly like a space that lost everything.
   */
  private async forget(closed: boolean): Promise<void> {
    if (this.forgotten) return
    const room = this.room
    // A closed space keeps its note, marked closed, so its link says why it is gone.
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

  private async setRole(subject: string, role: 'admin' | 'member' | 'kicked'): Promise<void> {
    if (!this.chat?.isAdmin) {
      toast('Only an admin can do that.', 'warn')
      return
    }
    await this.publish((c) => c.setRole(subject, role))
  }

  private rename(name: string, avatar?: string): void {
    this.mesh?.setName(name)
    this.chatPanel?.setName(name)
    void this.publish((c) => c.announceName(name, avatar))
  }

  /**
   * Inviting people: the link, a way to copy it, and a code a phone can scan.
   * Rare, so it opens from the space's menu rather than living on screen.
   */
  private async showInvite(): Promise<void> {
    const { qrSvg } = await import('./qr')
    const link = roomLink(this.secret, this.locked, this.server)
    const close = (): void => {
      scrim.remove()
      window.removeEventListener('keydown', onKey)
    }
    // A dialog you cannot dismiss with Escape is a dialog that traps people.
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
          h('button', { class: 'ghost icon-only', ariaLabel: 'Close', on: { click: close } }, [icon('close', 16)]),
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

  // ---- channels and people ----

  private renderChannels(): void {
    clear(this.channelList)
    this.newTextButton.classList.toggle('hidden', !this.chat?.isAdmin)
    // What is waiting, per channel, worked out once for the whole rail.
    const waiting = this.chat?.unread(this.read) ?? new Map()
    let mentions = 0
    for (const [, count] of waiting) mentions += count.mentions

    for (const channel of this.chat?.channelInfo() ?? [{ name: DEFAULT_CHANNEL, label: DEFAULT_CHANNEL, topic: '' }]) {
      const name = channel.name
      const sharingHere = [...this.sharers.values()].includes(name)
      const news = waiting.get(name)
      const open = h(
          'button',
          {
            class: `rail-item grow${name === this.channel && !this.direct ? ' on' : ''}${news ? ' unread' : ''}`,
            title: channel.topic || `Open ${channel.label}`,
            on: { click: () => this.openChannel(name) },
          },
          [
            icon('hash', 16),
            h('span', { class: 'truncate grow', text: channel.label }),
            sharingHere ? h('span', { class: 'pill live', text: 'live' }) : null,
            /*
             * A count only when somebody used your name. The rest is a change
             * of weight on the channel: a number on everything that moved is a
             * number you learn to ignore, and then you ignore the one that
             * mattered as well.
             */
            news?.mentions
              ? h('span', { class: 'pill bad', text: `${news.mentions}`, title: 'You were mentioned' })
              : null,
          ],
        )
      const more = h('button', {
        class: 'ghost tiny-btn person-more',
        title: `What you can do with ${channel.label}`,
        ariaLabel: `Actions for ${channel.label}`,
        data: { menu: `channel:${name}` },
      })
      onPress(more, () => openMenu(more, this.channelActions(channel)))
      more.append(icon('more', 14))
      this.channelList.append(
        h('div', { class: 'row rail-row' }, [open, this.chat?.isAdmin ? more : null]),
      )
    }
    /*
     * The tab carries it too, for a window that is not on top. Kept here and
     * written by status(), which is the one place the title is set: two writers
     * meant whichever ran last won, and the count lost.
     */
    this.mentions = mentions
    this.status()
  }

  /**
   * The threads in this space, the one that moved last at the top.
   *
   * A thread could only be found from the message it hangs off, which works for
   * ten minutes and not for tomorrow. Four of them here, because this is a way
   * back to a conversation rather than a second inbox.
   */
  private renderThreads(): void {
    clear(this.threadList)
    const threads = this.chat?.threads() ?? []
    // Nothing to say about threads until there is one.
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
    clear(this.voiceList)
    this.newVoiceButton.classList.toggle('hidden', !this.chat?.isAdmin)
    const here = this.voice?.state.channel ?? null
    for (const name of this.chat?.channels(true) ?? [DEFAULT_VOICE]) {
      const members = this.voice?.membersOf(name) ?? []
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
            members.length ? h('span', { class: 'pill', text: String(new Set(members.map((m) => (m === this.selfId ? this.chat?.me : this.mesh?.peers().find((p) => p.id === m)?.key) || m)).size) }) : null,
          ],
        ),
      ])
      /*
       * One row a person, not a session. A tab that died without a word stands
       * in the channel until the server notices, and the same person coming
       * back meanwhile was drawn twice, the old and the new.
       */
      const people = new Map<string, string[]>()
      for (const id of members) {
        const peer = id === this.selfId ? null : this.mesh?.peers().find((p) => p.id === id)
        const key = id === this.selfId ? this.chat?.me ?? id : peer?.key || id
        people.set(key, [...(people.get(key) ?? []), id])
      }
      for (const [key, ids] of people) {
        const mineRow = ids.includes(this.selfId)
        const talking = ids.some((id) => this.voice?.isTalking(id))
        const peer = mineRow ? null : this.mesh?.peers().find((p) => ids.includes(p.id) && p.name)
        const name = mineRow ? this.chat?.displayName ?? 'You' : peer?.name || this.chat?.nameOf(key) || shortKey(key)
        const label = mineRow ? `${name} (you)` : name
        // Sharing: a red LIVE that puts their screen on yours.
        const sharing = mineRow ? (this.capture !== null ? this.selfId : null) : (ids.find((id) => this.sharers.has(id)) ?? null)
        const live = sharing !== null
        const id = sharing ?? ids[0]
        const watching = this.watched.has(id)
        const member = h('div', { class: `voice-member${talking ? ' talking' : ''}` })
        // A right click on somebody in voice: how loud they are, for you.
        if (!mineRow) {
          member.addEventListener('contextmenu', (ev) => {
            ev.preventDefault()
            openMenu(member, [{ custom: this.volumeBlock(key, name) }])
          })
          member.title = 'Right click for their volume'
        }
        member.append(
          h('i', { class: `dot ${talking ? 'talking' : 'good'}` }),
          avatarOf(key, name, this.chat?.avatarOf(key) ?? '', 20),
          h('span', { class: 'truncate grow', text: label }),
        )
        if (live) {
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
        row.append(member)
      }
      this.voiceList.append(row)
    }

    const state = this.voice?.state
    this.voiceBar.classList.toggle('hidden', !state?.channel)
    if (state?.channel) {
      clear(this.voiceBar)
      /*
       * Connected, and where: the strip every voice app has at the foot of its
       * channel list, with the two things you reach for while talking.
       */
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
            text: '',
            title: state.muted ? 'Unmute' : 'Mute',
            ariaLabel: state.muted ? 'Unmute' : 'Mute',
            on: { click: () => this.voice?.setMuted(!state.muted) },
          },
          [icon(state.muted ? 'mic-off' : 'mic', 17)],
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
          [icon('phone-off', 17)],
        ),
      )
    }
    // The soundboard plays into the call, so it is there while you are in one.
    this.chatPanel?.showSoundboard(Boolean(state?.channel))
  }

  private async joinVoice(name: string): Promise<void> {
    if (this.voice?.state.channel === name) return
    try {
      await this.space.joinVoice(name)
    } catch (err) {
      // Long enough to read the way to the permission switch it names.
      toast(err instanceof Error ? err.message : String(err), 'bad', 9000)
      return
    }
    this.announceMe()
    this.draw()
  }

  /**
   * Somebody with the authority to has asked us to stand somewhere else.
   *
   * The ask came through the server, so it carries its own proof: the admin
   * signed the room, our key, the channel and the time with the same identity
   * key that signs their events, and the signature is checked against the
   * log's own idea of who is an admin. It used to lean on presence
   * announcements instead, and an announcement is not signed, so any member
   * could claim an admin's key in theirs and be believed.
   *
   * The time is not compared with our clock, because two machines disagree
   * enough to break things, and that lesson is already written in
   * signal/envelope.ts. It has to climb per admin key instead, so a recorded
   * ask replays as nothing for as long as this tab lives. After a reload one
   * replay of a real admin's real ask could land once more; what that buys is
   * a toast, from somebody who was trusted to send it in the first place.
   *
   * If we are already in a voice channel the microphone is already open and
   * the move just happens. If we are not, it cannot: a browser will not open a
   * microphone without the person asking for it, so this offers rather than
   * does. That is a real limit, not a courtesy, and it is the honest way round
   * anyway.
   */
  private async onMoved(data: Record<string, unknown>): Promise<void> {
    const asked = typeof data.channel === 'string' ? data.channel : ''
    const by = typeof data.by === 'string' ? data.by : ''
    const at = typeof data.at === 'number' ? data.at : 0
    const sig = typeof data.sig === 'string' ? data.sig : ''
    const channel = cleanChannel(asked)
    if (!channel || !by || !sig || !this.room || !this.chat) return

    const me = loadIdentity().pubkey
    if (!(await verifyClaim(['vmove', this.room.id, me, asked, at], sig, by))) return
    if (this.chat.roleOf(by) !== 'admin') return
    if (at <= (this.vmoveSeen.get(by) ?? 0)) return
    this.vmoveSeen.set(by, at)

    const who = this.chat.nameOf(by) || 'An admin'

    if (this.voice?.state.channel) {
      await this.voice.join(channel).catch(() => undefined)
      toast(`${who} moved you to ${channel}`, 'good', 5000)
      this.announceMe()
      this.draw()
      return
    }

    toast(`${who} asked you to join ${channel}`, 'good', 12_000, {
      label: 'Join',
      run: () => void this.joinVoice(channel),
    })
  }

  /** Ring somebody, and go to your conversation with them, where the call shows. */
  private async callPerson(key: string): Promise<void> {
    try {
      await this.space.startCall(key)
      this.openDirect(key)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The call could not start.', 'warn', 6000)
    }
  }

  private leaveVoice(): void {
    // A screen is shared with the call, so it goes when you do.
    if (this.capture) this.stopSharing()
    this.space.leaveVoice()
    this.announceMe()
    this.draw()
  }

  /**
   * Move somebody into a voice channel. Admins only, and the ask is signed:
   * the room, their key, the channel and the time, under our identity key, so
   * the other side has proof rather than an announcement anybody could fake.
   */
  private async moveTo(key: string, channel: string): Promise<void> {
    if (!this.room) return
    for (const peer of this.mesh?.peers() ?? []) {
      if (peer.key !== key) continue
      const by = loadIdentity().pubkey
      const at = Date.now()
      const sig = await signClaim(['vmove', this.room.id, key, channel, at])
      void this.bus?.send({ type: 'vmove', to: peer.id, data: { channel, by, at, sig } })
      toast(`Asked them to join ${channel}`, 'good', 4000)
      return
    }
    toast('They are not here right now.', 'warn', 4000)
  }

  /**
   * What you may do about somebody, in words.
   *
   * Worked out fresh when the menu opens rather than when the row is drawn, so
   * a menu cannot offer to promote somebody who was promoted while it sat
   * there. An empty list means there is nothing to offer, and then there is no
   * button either: an ellipsis that opens nothing is a promise the interface
   * does not keep.
   */
  /** Somebody's menu: how loud they are to you while they are in voice, then what you can do about them. */
  private personMenu(key: string, role: string, you: boolean, here: boolean): MenuEntry[] {
    const actions = this.actionsFor(key, role, you, here)
    const talks = !you && (this.mesh?.peers() ?? []).some((p) => p.key === key && this.voice?.whereIs(p.id))
    if (!talks) return actions
    const name = this.chat?.nameOf(key) || shortKey(key)
    return actions.length ? [{ custom: this.volumeBlock(key, name) }, 'line', ...actions] : [{ custom: this.volumeBlock(key, name) }]
  }

  /**
   * How loud somebody is, for you: a slider and a mute, kept on this device
   * and told to nobody. See net/volume.ts.
   */
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

  private actionsFor(key: string, role: string, you: boolean, here: boolean): MenuItem[] {
    const chat = this.chat
    if (!chat || you) return []
    const items: MenuItem[] = []
    const name = chat.nameOf(key) || shortKey(key)

    /*
     * Tag them, from the list of who is here.
     *
     * Typing an @ and picking from the list works and is faster once you know
     * it is there. This is for the other half of the time: you are looking at
     * the person in the members list, and the thing you want is to say their
     * name to the room.
     */
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

    if (chat.nameOf(key)) {
      items.push({
        label: 'Mention',
        note: 'Puts @' + name + ' in the message you are writing',
        run: () => {
          this.chatPanel?.insert(`@${name} `)
          this.chatPanel?.focus()
        },
      })
    }


    items.push({
      label: 'Copy ID',
      note: shortKey(key),
      run: () => {
        void copyText(key).then((ok) =>
          toast(ok ? 'ID copied.' : 'Could not copy the ID.', ok ? 'info' : 'warn'),
        )
      },
    })

    if (!chat.isAdmin) return items

    const standing = this.voice?.state.channel
    // Move them into the voice channel we are standing in. Only when we are in
    // one, because "move them here" needs a here, and only while they are about.
    if (here && standing) {
      items.push({
        label: `Move to ${standing}`,
        note: 'Asks their device to join the voice channel you are in',
        run: () => void this.moveTo(key, standing),
      })
    }
    if (role !== 'admin') {
      items.push({
        label: 'Make admin',
        note: 'They can rename, pin, clear and remove people',
        run: () => void this.setRole(key, 'admin'),
      })
    } else if (key !== chat.founder) {
      items.push({
        label: 'Remove admin',
        run: () => void this.setRole(key, 'member'),
      })
    }
    if (role === 'kicked') {
      items.push({
        label: 'Unban',
        run: () => void this.setRole(key, 'member'),
      })
    } else if (key !== chat.founder) {
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
    return items
  }

  /** One announcement carries the name, what we are sharing, and where we stand. */
  private announceMe(): void {
    this.mesh?.announce()
  }

  /**
   * One row per person, not one per connection.
   *
   * A person is their key. A session is a tab, and a tab that closes and opens
   * again is a new one, so a list keyed by session showed somebody who stepped
   * out and came back as two people: the row they left behind still had their
   * name on it, and the new one had said nothing yet, so it had nothing to show
   * but a key. Both were the same person all along.
   *
   * So everybody the log has heard of gets a row, live or not, and whoever is
   * here right now lights their own row up. That also gives the offline half of
   * the space somewhere to live, instead of a second list underneath the first.
   */
  /**
   * Who is in this space, as people rather than as connections.
   *
   * One answer, used by the list on the right and by the count along the
   * bottom. They were worked out separately, and disagreed: the list showed one
   * row per person and the status bar counted one per session, so somebody with
   * a second tab open, or a tab that had just been reloaded, was two.
   */
  private roster(): PersonRow[] {
    const chat = this.chat
    const names = chat?.log.names() ?? new Map<string, string>()
    const rows = new Map<string, PersonRow>()

    const put = (key: string, patch: Partial<PersonRow>): void => {
      const was = rows.get(key)
      rows.set(key, {
        key,
        name: '',
        here: false,
        ready: false,
        talking: false,
        sharing: false,
        voice: null,
        you: false,
        away: false,
        ...was,
        ...patch,
      })
    }

    /*
     * Everybody the log knows about who has been about lately.
     *
     * Not everybody it has ever heard of. A key is made per device and per
     * browser profile, so somebody who joins from their phone, then their
     * laptop, then a private window is three keys as far as the log is
     * concerned, and all three answer to the same name. Listing the lot meant
     * seeing the same person two or three times over, some of them with a name
     * and some with nothing but a key, which is exactly what it looked like.
     *
     * So the list is of people, not of records: here now, or heard from in the
     * last fortnight. Nothing is deleted, and an old key that says something
     * comes straight back.
     */
    const seen = chat?.lastSeen() ?? new Map<string, number>()
    const cutoff = Date.now() - RECENT_MS
    for (const [key, name] of names) {
      if ((seen.get(key) ?? 0) < cutoff) continue
      put(key, { name })
    }

    put(chat?.me ?? 'you', {
      name: chat?.displayName ?? 'You',
      here: true,
      ready: true,
      you: true,
      away: typeof document !== 'undefined' && document.hidden,
      sharing: this.capture !== null,
      voice: this.voice?.state.channel ?? null,
      talking: this.voice?.isTalking(this.selfId) ?? false,
    })

    /*
     * Whoever is connected right now. Their announcement carries their key, so
     * this lands on the row the log already has, and two tabs belonging to one
     * person land on the same row rather than making a second one.
     */
    for (const peer of this.mesh?.peers() ?? []) {
      const key = peer.key || peer.id
      const was = rows.get(key)
      put(key, {
        name: peer.name || was?.name || '',
        here: true,
        // Either tab being on screen means the person is looking, and either
        // link being up means they can be reached.
        ready: peer.ready || was?.ready === true,
        away: this.away.has(peer.id) && !(was?.here && !was.away),
        sharing: this.sharers.has(peer.id) || was?.sharing === true,
        voice: this.voice?.whereIs(peer.id) ?? was?.voice ?? null,
        talking: this.voice?.isTalking(peer.id) === true || was?.talking === true,
      })
    }

    /*
     * Two rows with the same name, one here and one not, is the same person on
     * a second device far more often than it is two people. Drop the one that
     * is not here: it says nothing the live row does not, and it is the thing
     * that looked like a duplicate.
     */
    const hereByName = new Set(
      [...rows.values()].filter((r) => r.here && r.name).map((r) => r.name.toLowerCase()),
    )
    for (const [key, row] of rows) {
      if (!row.here && row.name && hereByName.has(row.name.toLowerCase())) rows.delete(key)
    }
    /*
     * And your own name on another key, here or not, is you on a device that
     * was never linked to this one: the phone and the laptop each made their
     * own key and were both given your name. It goes into your row rather
     * than standing beside it as a second you. Linking the devices makes them
     * one key, which is the cure; this is so it never looks like two of you.
     */
    const mine = (chat?.displayName ?? '').toLowerCase()
    if (mine) {
      for (const [key, row] of rows) {
        if (!row.you && row.name.toLowerCase() === mine) rows.delete(key)
      }
    }

    // You first, then whoever is here, then the rest, alphabetically within each.
    return [...rows.values()].sort((a, b) => {
      if (a.you !== b.you) return a.you ? -1 : 1
      if (a.here !== b.here) return a.here ? -1 : 1
      return (a.name || a.key).localeCompare(b.name || b.key)
    })
  }

  /** How many people are in the space right now, counting you. */
  private hereNow(): number {
    return this.roster().filter((r) => r.here).length
  }

  private renderPeople(): void {
    clear(this.peopleList)
    const chat = this.chat
    const roles = chat?.roles() ?? new Map<string, string>()
    const order = this.roster()

    /*
     * Two groups with a count each, the way every chat app says it: who is
     * here, and who has been lately. The count is the one the status line
     * says, worked out from the same rows.
     */
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
      /*
       * Somebody removed is removed: they do not stand in the list wearing a
       * label. Letting them back in lives in the space settings, where the
       * rare admin act belongs. Your own row stays even then, so being removed
       * is something you can see rather than infer.
       */
      if (role === 'kicked' && !row.you) continue
      const label = row.name || shortKey(row.key)
      const actions = this.actionsFor(row.key, role, row.you, row.here)
      const more = h('button', {
        class: 'ghost tiny-btn person-more',
        title: `What you can do about ${label}`,
        ariaLabel: `Actions for ${label}`,
        data: { menu: `person:${row.key}` },
      })
      onPress(more, () => openMenu(more, this.personMenu(row.key, role, row.you, row.here)))
      more.append(icon('more', 14))

      /*
       * What they are doing, under the name, when they are doing something:
       * sharing a screen, or standing in a voice channel.
       */
      const doing = row.sharing
        ? h('span', { class: 'person-doing live' }, [h('i', { class: 'live-dot' }), 'Sharing their screen'])
        : row.voice
          ? h('span', { class: `person-doing${row.talking ? ' talking' : ''}` }, [
              icon('volume-low', 11),
              isCallChannel(row.voice)
                ? row.talking
                  ? 'Talking in a call'
                  : 'In a call'
                : row.talking
                  ? `Talking in ${row.voice}`
                  : `In ${row.voice}`,
            ])
          : null

      this.peopleList.append(
        h('div', { class: `rail-person${row.here ? '' : ' away'}${row.talking ? ' talking' : ''}`, title: `ID ${row.key}` }, [
          h('span', { class: 'person-face' }, [
            avatarOf(row.key, row.name, chat?.avatarOf(row.key) ?? '', 32),
            /*
             * Green: here and reading. Orange: here with the tab put away.
             * Hollow: their device answers but the link between us is not up
             * yet, which is a second or two on the way in and is worth showing
             * rather than pretending either of the other two.
             */
            row.here
              ? h('i', {
                  class: `dot ${!row.ready ? 'idle' : row.away ? 'warn' : 'good'}`,
                  title: !row.ready
                    ? 'Connecting'
                    : row.away
                      ? 'Here, but looking at something else'
                      : 'Here',
                })
              : null,
          ]),
          h('div', { class: 'person-text' }, [
          h('div', { class: 'row person-line' }, [
            h('span', { class: 'truncate', text: row.you ? `${label} (you)` : label }),
            /*
             * A crown, rather than the word admin under the name.
             *
             * It was a second line of text per person, which made the list of
             * who is here twice as tall to say a thing about one of them. The
             * title carries the word for anybody hovering, and for a screen
             * reader.
             */
            role === 'admin'
              ? h('span', { class: 'crown', title: 'Runs this space' }, [icon('crown', 12)])
              : null,
            role === 'kicked' ? h('span', { class: 'tiny faint', text: 'removed' }) : null, // your own row only
          ]),
          doing,
          ]),
          actions.length ? more : null,
        ]),
      )
    }
  }

  /**
   * Where a search goes.
   *
   * Your own key first, because it is the one most people have: it is kept in
   * this browser, and it works whatever the server offers. The server second,
   * when it holds a key, because that keeps the key on one machine rather than
   * on everybody's.
   *
   * Nothing third. A picker that opens and says what is missing beats a toast
   * that flashes past somebody who was looking at the grid.
   */
  private async findGifs(term: string): Promise<{ gifs: Gif[]; from: string }> {
    const held = gifCredential()
    if (held) {
      return { gifs: await searchGifs(term, held), from: serviceLabel(held.service) }
    }
    // The server answers a term, when it holds a key. It has nothing to say
    // about an empty one, so an empty box waits rather than asking nothing.
    if (!(await serverHasGifs(this.server))) return { gifs: [], from: '' }
    return { gifs: term.trim() ? await serverGifs(this.server, term) : [], from: 'the server' }
  }

  /**
   * A grid of GIFs, one click from being said.
   *
   * The box stays open and searches again on every pause in typing, because
   * the first word rarely finds the right GIF and closing the picker to type
   * /gif again is the reason nobody used this.
   *
   * The click sends the plain https link. The chat already draws a lone
   * picture link as the picture, so the link is the whole payload and nothing
   * new travels.
   */
  private async openGifPicker(term: string): Promise<void> {
    // The GIF button again, with nothing to search for: closed, the way a toggle is.
    if (this.gifClose) {
      const close = this.gifClose
      close()
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
    // A press on the GIF button is left to the button, which closes it.
    const onAway = (ev: PointerEvent): void => {
      const target = ev.target as Node
      if (pop.contains(target) || this.chatPanel?.gifAnchor.contains(target)) return
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
    /*
     * Above the button that opened it, its right edge on the button's, the
     * way the emoji picker hangs off its own: a picker in the middle of the
     * screen is a picker the eye has to go and find.
     */
    const place = (): void => {
      const at = this.chatPanel?.gifAnchor.getBoundingClientRect()
      if (!at || at.width === 0) return
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
      const direct = this.direct
      if (direct) void this.publish((c) => c.sayDirect(direct, url))
      else void this.publish((c) => c.say(url, this.channel))
    }

    /*
     * One search at a time, and only the newest one draws.
     *
     * Typing "cat" fires three searches and they can come back in any order,
     * so the answer to a question nobody is asking any more is dropped rather
     * than painted over the answer to the one that is.
     */
    let asking = 0
    const run = async (): Promise<void> => {
      const mine = ++asking
      const wanted = box.value.trim()
      status.textContent = 'Looking...'
      const { gifs, from } = await this.findGifs(wanted)
      if (mine !== asking || !pop.isConnected) return
      clear(grid)
      for (const g of gifs) {
        // Some results have no picture in them at all, only the clip. Those
        // are played in the grid rather than left as an empty square.
        const cell = isClip(g.preview) ? h('video', { class: 'gif-choice' }) : h('img', { class: 'gif-choice' })
        if (cell instanceof HTMLVideoElement) {
          cell.src = g.preview
          cell.autoplay = true
          cell.loop = true
          cell.muted = true
          cell.playsInline = true
          cell.setAttribute('muted', '')
          cell.setAttribute('playsinline', '')
          void cell.play().catch(() => undefined)
        } else {
          cell.src = g.preview
          cell.alt = ''
          cell.loading = 'lazy'
          cell.referrerPolicy = 'no-referrer'
        }
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
      const key = (ev as KeyboardEvent).key
      if (key !== 'Enter') return
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

  /** Why the grid is empty, said in the box rather than in a toast. */
  private gifTrouble(wanted: string, from: string): (string | Node)[] {
    if (from === '') {
      return [
        'GIF search needs a key. Paste one under Settings, GIFs, or ask whoever runs the server to set one.',
      ]
    }
    if (!wanted) {
      return from === 'the server'
        ? ['Type what to look for.']
        : ['Nothing came back. Type what to look for.']
    }
    return from === 'the server'
      ? [`Nothing for "${wanted}". A server with no Tenor key finds nothing; see server/README.md.`]
      : [`Nothing for "${wanted}". Check the key under Settings, GIFs, if this keeps happening.`]
  }

  /** The pinned messages of this channel, as a list that goes to each one. */
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
    if (name === this.channel && !this.thread && !this.direct) return
    this.chatPanel?.keepDraft()
    this.channel = name
    this.thread = null
    this.direct = null
    this.chatPanel?.setThread(null)
    this.chatPanel?.setDirect(null)
    this.chatPanel?.useDraft(name)
    // Where the line goes, taken once on the way in. See ChatPanel.setReadMark:
    // moving it as messages arrive rubs out the thing you came back to read.
    this.openedAt = this.read[name] ?? 0
    // Watching follows the channel: leave whatever was on the old one, and do
    // not start anything new. Whoever is live here is offered, not applied.
    this.stopWatching()
    this.draw()
  }

  /**
   * Ask a question.
   *
   * Prompts rather than a dialog, because a poll is three short answers and a
   * question, and a form for that is more window than it is worth.
   */
  /**
   * Ask a question with a fixed set of answers.
   *
   * There is no button for it any more. A poll is a rare thing to write and it
   * had a permanent seat next to the message box, which is a lot of furniture
   * for something most people press once a month. It is /poll now, and the
   * whole thing can be written on one line:
   *
   *   /poll Tea or coffee? tea, coffee, neither
   */
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

  /**
   * Empty the space, for everybody.
   *
   * Worth being honest about in the asking, because the word reset promises
   * more than any of this can deliver: it stops the history being shown and
   * throws it away on every device that reads the log, and somebody who kept a
   * copy still has a copy. Names, roles and channels stay, or this would take
   * the room apart rather than empty it.
   */
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
    // The button only shows for admins, but every peer would ignore the event
    // anyway, so say so here rather than let the click land as silence.
    if (!this.chat?.isAdmin) {
      toast('Only an admin can make a channel.', 'warn')
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

  // ---- sharing ----

  private renderShareButton(): void {
    const sharing = this.capture !== null
    clear(this.shareButton)
    const label = sharing ? 'Stop sharing' : 'Share screen'
    this.shareButton.setAttribute('aria-label', label)
    this.shareButton.title = sharing ? 'Stop sharing your screen' : 'Share your screen with this voice channel'
    this.shareButton.append(icon(sharing ? 'stop' : 'monitor', 17))
    this.shareButton.classList.toggle('danger', sharing)
    this.shareButton.classList.toggle('on', sharing)
    // The stage is only up for something you chose to put on it.
    this.stage.classList.toggle('hidden', this.watched.size === 0)
    this.renderStreams()
  }

  /**
   * Share, or stop. A screen is shared with a voice channel, the way it is in
   * every voice app: you are in the call, and your screen is part of it.
   */
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

  private admitWatcher(peerId: string): void {
    if (!this.outStream) return
    const peer = new HostPeer({
      viewerId: peerId,
      stream: this.outStream,
      mode: this.settings.mode,
      codec: this.settings.codec,
      hardware: this.gpu.hardware,
      // ICE says which of our two possible connections it belongs to, because
      // this person may be watching us while we watch them. See the ice case.
      send: (type, data) =>
        void this.bus?.send({
          type,
          to: peerId,
          data: type === 'ice' ? { ...(data as Record<string, unknown>), side: 'host' } : data,
        }),
      onChange: () => this.draw(),
      onFailed: (reason) => toast(reason, 'bad', 8000),
      onChat: () => undefined,
    })
    this.watchers.set(peerId, peer)
    void peer.setPlan(this.plan(this.watchers.size))
  }

  /** Everybody sharing in this space, ourselves included. */
  private liveHere(): { id: string; name: string; you: boolean; key: string }[] {
    const out: { id: string; name: string; you: boolean; key: string }[] = []
    if (this.capture) {
      out.push({ id: this.selfId, name: 'Your screen', you: true, key: this.chat?.me ?? '' })
    }
    for (const [id] of this.sharers) {
      if (id === this.selfId) continue
      const peer = this.mesh?.peers().find((p) => p.id === id)
      out.push({ id, name: peer?.name || shortKey(id), you: false, key: peer?.key ?? '' })
    }
    return out
  }

  /** The session of this person's stream, if it is still up. */
  private sharerByKey(key: string, _channel = ''): string | null {
    for (const [id] of this.sharers) {
      if (id === this.selfId) continue
      const peer = this.mesh?.peers().find((p) => p.id === id)
      if (peer?.key === key) return id
    }
    return null
  }

  /**
   * Walk in on a stream from the message that announced it.
   *
   * The message may be old and the reader may be standing in another channel,
   * so this goes where the stream is first, then puts it on. The channel move
   * takes everything else off the stage, the way walking in always does.
   */
  private joinStream(key: string, _channel = ''): void {
    const id = this.sharerByKey(key)
    if (!id) {
      toast('That stream has ended.', 'warn')
      return
    }
    if (!this.watched.has(id)) this.watch(id)
  }

  /**
   * Put somebody's stream on the stage, or take it back off.
   *
   * A second stream splits the stage rather than replacing the first: each
   * one is its own connection, its own surface, and its own tile. Asking is
   * a hello, and the offer comes back per connection, the same way it does
   * for the first one.
   */
  private watch(peerId: string): void {
    if (this.watched.has(peerId)) {
      this.dropTile(peerId)
      this.announceMe()
      this.draw()
      return
    }
    if (peerId === this.selfId) {
      // Your own screen is already on this device. No round trip for it.
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
      onChat: () => undefined,
      onChatReady: () => undefined,
    })
    void this.bus?.send({ type: 'hello', to: peerId })
    // Say so at once, so the sharer's "watched by" line moves when you do.
    this.announceMe()
    this.draw()
  }

  /** A screen's place on the stage: a surface, and the line saying whose it is. */
  private addTile(id: string): {
    peer: ViewerPeer | null
    surface: VideoSurface
    tile: HTMLElement
    tag: HTMLElement
  } {
    const surface = new VideoSurface({ muted: true, showVolume: true })
    const tag = h('div', { class: 'stage-tag' })
    const tile = h('div', { class: 'stage-tile' }, [surface.root, tag])
    this.stage.append(tile)
    const entry = { peer: null as ViewerPeer | null, surface, tile, tag }
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

  /** Who has a session's stream on their screen, by name, newest announcement wins. */
  private watcherNames(sharer: string): string[] {
    const peers = this.mesh?.peers() ?? []
    const names = new Set<string>()
    const note = (session: string): void => {
      const p = peers.find((x) => x.id === session)
      names.add(p ? p.name || shortKey(p.key || session) : shortKey(session))
    }
    for (const [session, targets] of this.watchingBy) {
      if (targets.includes(sharer) && session !== this.selfId) note(session)
    }
    // For our own stream the connections themselves are the surer answer.
    if (sharer === this.selfId) for (const id of this.watchers.keys()) note(id)
    return [...names]
  }

  /**
   * Who is live here, as an offer rather than an instruction.
   *
   * This is the only way a screen gets onto yours, which is the point: one
   * button each, nothing pressed in until you press it, and a way back off.
   */
  private renderStreams(): void {
    const live = this.liveHere()
    clear(this.streamBar)
    this.streamBar.classList.toggle('hidden', live.length === 0)

    // The name on every picture, so a split stage says whose screen each one
    // is, and who else is standing in front of it.
    for (const [id, entry] of this.watched) {
      if (id === this.selfId) {
        const eyes = this.watcherNames(this.selfId)
        entry.tag.textContent = eyes.length ? `Your screen · ${eyes.length} watching` : 'Your screen'
        entry.tag.title = eyes.length ? `Watching: ${eyes.join(', ')}` : 'Nobody is watching yet'
      } else {
        const whose = live.find((l) => l.id === id)?.name ?? 'a shared screen'
        entry.tag.dataset.who = whose
        if (!entry.tag.textContent?.startsWith(whose)) entry.tag.textContent = whose
      }
    }
    if (live.length === 0) return

    const watching = this.watched.size > 0
    this.streamBar.append(h('span', { class: 'eyebrow', text: 'Live' }))

    for (const one of live) {
      const on = this.watched.has(one.id)
      const label = one.you
        ? this.watchers.size > 0
          ? `Your screen · ${this.watchers.size} watching`
          : 'Your screen'
        : one.name
      const eyes = this.watcherNames(one.id)
      const tab = h(
        'button',
        {
          class: `stream-tab${on ? ' on' : ''}`,
          title: (one.you ? 'Show your own screen' : `Watch ${one.name}`) + (eyes.length ? `. Watching: ${eyes.join(', ')}` : ''),
          on: { click: () => this.watch(one.id) },
        },
        [
          avatarOf(one.key || one.id, one.you ? (this.chat?.displayName ?? '') : one.name, this.chat?.avatarOf(one.key) ?? '', 18),
          h('span', { class: 'truncate', text: label }),
          h('span', { class: 'live-dot', title: 'Live' }),
        ],
      )
      // What the card means rather than what it says, for anything that has
      // to find one without reading the copy off it.
      tab.dataset.watch = one.you ? 'self' : 'peer'
      this.streamBar.append(tab)
    }

    if (watching) {
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

  /** Everything off the stage at once, our own preview included. */
  private stopWatching(): void {
    const was = this.watchingAnyone()
    for (const id of [...this.watched.keys()]) this.dropTile(id)
    if (was) this.announceMe()
  }

  /** Your own screen, on your own stage, so you can see what you are giving away. */
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
    /*
     * How the picture is arriving, said once, beside whose it is, rather than
     * in four badges piled on top of the name. The numbers are for a person
     * who wants them, in the title.
     */
    for (const [id, entry] of this.watched) {
      if (id === this.selfId || !entry.peer) continue
      const s = await entry.peer.sample()
      const size = s.height ? ` · ${s.height}p` : ''
      entry.tag.textContent = `${entry.tag.dataset.who ?? ''}${size}`
      entry.tile.title = `${s.width}x${s.height}, ${s.fps} fps, ${fmtKbps(s.kbps)}${s.codec ? `, ${s.codec}` : ''}`
    }
  }

  // ---- the share controls ----

  /**
   * The one control a sharer needs: what kind of thing is being shown, which
   * decides whether sharpness or smoothness wins. It sits on your own preview.
   */
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
