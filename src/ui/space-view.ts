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
import { captureMicrophone, captureScreen, CaptureError, type ScreenCapture } from '../media/capture'
import { AudioMixer } from '../media/mixer'
import { Mesh } from '../net/mesh'
import { Voice } from '../net/voice'
import { UplinkMeter } from '../net/uplink'
import { deriveRoom, formatSecret, newPeerId, roomLink, type Room } from '../room'
import { HostPeer } from '../rtc/host-peer'
import { ViewerPeer } from '../rtc/viewer-peer'
import { NO_HARDWARE, probeHardwareEncoders, type HardwareProbe } from '../rtc/hardware'
import {
  availableCodecs,
  FPS_CHOICES,
  planFor,
  PRESETS,
  presetById,
  RESOLUTION_CHOICES,
  type CodecChoice,
  type PresetId,
  type QualityPlan,
} from '../rtc/quality'
import { SignalBus } from '../signal/bus'
import type { Envelope } from '../signal/envelope'
import { loadSettings, saveSettings, type HostSettings } from '../settings'
import { cleanName, mentionsMe } from '../chat'
import { forgetRoom, getRoom, noteRoom, tombstoneRoom } from '../store/db'
import { loadIdentity, saveDisplayName, shortKey, signClaim, verifyClaim } from '../store/identity'
import { settingsView } from './settings-view'
import { Archive, defaultArchive } from '../store/archive'
import { buzzNudge, chirpJoin, chirpLeave, chirpMessage, isNews, speak } from './sounds'
import { openSoundboard, playSound, soundById, soundByName, SOUNDS } from './soundboard'
import { gifCredential, searchGifs, serviceLabel, type Gif } from '../store/gifs'
import {
  DEFAULT_CHANNEL,
  DEFAULT_VOICE,
  cleanChannel,
  type ChannelInfo,
  type LogEvent,
  type Message,
} from '../store/log'
import { RoomChat } from '../store/room-chat'
import { ChatPanel, imageLinks } from './chat-panel'
import { clear, copyText, fmtKbps, h, labelled } from './dom'
import { icon } from './icons'
import { openMenu, type MenuItem } from './menu'
import { avatarOf } from './chat-panel'
import { loadAvatar } from './avatar'
import { qrSvg } from './qr'
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
/** One nudge per person, or per room, this often. The 2004 ration. */
const NUDGE_EVERY_MS = 20_000
/** A pile of arriving nudges is one shake, not a seizure. */
const NUDGE_COOL_MS = 5000

/** One sound this often, from here and from each other person. */
const SOUND_EVERY_MS = 1500

/** One spoken line this often, and the same ration taken of each sender. */
const TTS_EVERY_MS = 5000
/** The most a voice will be made to read in one go. */
const TTS_MAX_CHARS = 280

const TYPING_EVERY_MS = 2000
/** And how long that stays true without another word. */
const TYPING_FOR_MS = 5000

/** What a slash offers. The panel lists them; runCommand is what they mean. */
const COMMANDS = [
  { name: 'me', note: 'Say what you are doing' },
  { name: 'dm', note: 'Write to one person' },
  { name: 'poll', note: 'Ask a question with answers' },
  { name: 'nick', note: 'Change your name' },
  { name: 'topic', note: 'Say what this channel is for' },
  { name: 'rename', note: 'Rename this channel' },
  { name: 'gif', note: 'Look for a GIF to send' },
  { name: 'sound', note: 'Play a noise for everybody' },
  { name: 'nudge', note: 'Shake somebody\u2019s window' },
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
  private readonly selfId = newPeerId()
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
  private readonly password: string
  /** True when this person just made the space, so they claim it. */
  private readonly fresh: boolean
  private readonly wantedName: string
  private spaceTitle!: HTMLSpanElement
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
  private archive: Archive | null = null

  /** The newest signed move heard per admin key, so a recorded one replays as nothing. */
  private readonly vmoveSeen = new Map<string, number>()
  /** The last line asked of each peer, so an answer that did not help is not asked for again. */
  private readonly pulled = new Map<string, number>()
  /** Which streams each session says it is watching, from their announcements. */
  private readonly watchingBy = new Map<string, string[]>()
  /** When each person, or the room, was last nudged from here. */
  private readonly nudgeSent = new Map<string, number>()
  /** The last shake taken, so a pile of nudges is one shake. */
  private lastShakeAt = 0
  /** When the last sound was played from here. */
  private soundSentAt = 0
  /** When each person was last allowed to make a noise here. */
  private readonly soundHeard = new Map<string, number>()
  /** When the last spoken line left here. */
  private ttsSentAt = 0
  /** When each sender was last given the floor, so a flood is not a filibuster. */
  private readonly ttsHeard = new Map<string, number>()
  /** Whether the no-relay warning has been said for this outage. */
  private relayWarned = false
  private relayTimer: number | null = null

  // Elements redrawn in place.
  private channelList!: HTMLDivElement
  private voiceList!: HTMLDivElement
  private newTextButton!: HTMLButtonElement
  private newVoiceButton!: HTMLButtonElement
  private directList!: HTMLDivElement
  private threadList!: HTMLDivElement
  private peopleList!: HTMLDivElement
  private voiceBar!: HTMLDivElement
  private shell!: HTMLElement
  private stage!: HTMLDivElement
  private shareButton!: HTMLButtonElement
  private sharePanel!: HTMLDivElement
  private channelTitle!: HTMLDivElement
  private searchInput!: HTMLInputElement
  private searchResults!: HTMLDivElement
  private pinsButton!: HTMLButtonElement
  private channelsButton!: HTMLButtonElement
  private peopleButton!: HTMLButtonElement
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
    secret: string,
    chrome: WindowChrome | null,
    onLeave: () => void,
    lock: { locked: boolean; password: string; fresh?: boolean; name?: string } = {
      locked: false,
      password: '',
    },
  ) {
    this.root = root
    this.secret = secret
    this.chrome = chrome
    this.locked = lock.locked
    this.password = lock.password
    this.fresh = lock.fresh === true
    this.wantedName = lock.name ?? ''
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

    try {
      this.room = await deriveRoom(this.secret, this.password)
    } catch {
      this.stage.append(h('div', { class: 'empty', text: 'That room code is not valid.' }))
      return
    }

    const identity = loadIdentity()
    /*
     * Write the space down before anything else touches the store.
     *
     * The lock and the password are known here and nowhere else, and the room
     * id is derived from both, so a note without them sends the next visit to a
     * different, empty room under the same code. It used to be written on the
     * first redraw, which is late enough that closing the tab straight away
     * left the space unopenable from the list.
     */
    await this.remember({})
    const note = await getRoom(this.room.id)
    const chat = new RoomChat(this.room.id, this.secret, note?.founder ?? '')
    chat.onChange = () => this.draw()
    chat.onDirect = () => this.draw()
    chat.onFounder = (pubkey) => void this.remember({ founder: pubkey })
    await chat.load()
    this.chat = chat
    this.chatPanel?.setMe(chat.me)
    this.chatPanel?.setName(chat.displayName)
    // Where this device had got to, per channel, and where the line goes today.
    this.read = { ...(note?.read ?? {}) }
    this.readDm = { ...(note?.readDm ?? {}) }
    chat.setDirectRead(this.readDm)
    this.openedAt = this.read[this.channel] ?? 0
    void chat.readDirect()

    const bus = new SignalBus(this.room, this.selfId)
    const voice = new Voice(bus, this.selfId)
    voice.onChange = () => this.draw()
    voice.onArrival = (arrived) => (arrived ? chirpJoin() : chirpLeave())
    this.voice = voice
    const mesh = new Mesh(bus, this.selfId, identity.name)
    mesh.extra = () => ({
      // Who this is, so the roster is a list of people rather than of tabs.
      key: identity.pubkey,
      sharing: this.capture ? this.channel : undefined,
      // Whose streams are on this screen, so everybody can say who is watching.
      watching: this.watchingAnyone()
        ? [...this.watched.keys()].filter((id) => id !== this.selfId)
        : undefined,
      voice: this.voice?.state.channel ?? undefined,
      /*
       * Whether this tab is on screen.
       *
       * Presence is not one bit. Somebody with the space open in a tab they
       * are not looking at is here in the sense that their device answers and
       * not in the sense that matters, which is whether they will read what you
       * write. Green and orange say the difference; being connected at all is
       * what the dot being there says.
       */
      away: document.hidden ? true : undefined,
    })
    mesh.onData = (from, raw) => void this.onMeshData(from, raw)
    mesh.onPeers = () => {
      this.prunePeers()
      this.draw()
    }
    /*
     * A new link gets our history at once, and sends us theirs for the same
     * reason. Both sides do it, so whoever has been away catches up without
     * anybody deciding who is in charge of remembering.
     */
    mesh.onReady = (peerId) => {
      for (const raw of chat.backfill()) mesh.sendTo(peerId, raw)
      // And how far back we reach, so a peer that is short can ask for more.
      mesh.sendTo(peerId, chat.summary())
    }
    bus.onMessage = (env) => void this.onSignal(env)
    bus.onHealth = () => {
      this.status()
      this.watchRelays()
    }
    bus.start()
    mesh.start()
    this.bus = bus
    this.mesh = mesh

    chat.onLocal = (event) => {
      for (const raw of chat.encode([event])) mesh.broadcast(raw)
      // And to the archive, if this space has one. Never waited on.
      this.archive?.push([event])
    }

    /*
     * The archive, if this space was given one. It is asked once on the way in
     * and told everything we hold, which is how a space that was empty for a
     * week catches up, and how an archive that has been away catches up itself.
     */
    if (this.room) {
      const archive = new Archive(this.room.id, this.room.key, this.room.write)
      // What this space was told, or the default, or nothing. A space that was
      // told the empty string was turned off here on purpose and stays off.
      const wanted = note?.archive !== undefined ? note.archive : defaultArchive()
      this.archive = archive
      if (wanted) {
        archive.use(wanted, note?.archiveAt ?? 0)
        void this.catchUp()
      }
    }

    // Whoever made the space claims it, once, and becomes its first admin.
    if (this.fresh && !chat.founder) {
      await chat.claimFounder()
      await this.remember({ founder: chat.me })
      if (this.wantedName) await chat.setSpaceName(this.wantedName)
    }
    await chat.announceName(chat.displayName, loadAvatar())
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
      this.searchInput?.focus()
      this.searchInput?.select()
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
    this.voice?.dispose()
    this.stopWatching()
    this.mesh?.stop()
    const bus = this.bus
    this.bus = null
    if (bus) window.setTimeout(() => bus.stop(), 200)
    document.title = 'Cathode'
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
    // A reload used to leave your old session standing in the voice channel
    // for ever, because nothing ever took a dead session's standing back.
    this.voice?.prune(alive)
  }

  // ---- signalling ----

  private async onSignal(env: Envelope): Promise<void> {
    await this.mesh?.handle(env)
    await this.voice?.handle(env)

    const data = (env.data ?? {}) as Record<string, unknown>
    switch (env.type) {
      case 'announce': {
        const standing = typeof data.voice === 'string' ? cleanChannel(data.voice) : ''
        this.voice?.noteAnnounce(env.from, standing || null)
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
        this.voice?.forget(env.from)
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

  private async onMeshData(from: string, raw: string): Promise<void> {
    // Somebody is writing. Not an event: it is true for four seconds and then
    // it is not, and a log is for things that stay true.
    if (this.takeTyping(from, raw)) return
    if (this.takeNudge(from, raw)) return
    if (this.takeSound(from, raw)) return
    if (this.takeSpoken(from, raw)) return
    if (this.takeSync(from, raw)) return

    const fresh = (await this.chat?.ingest(raw)) ?? []
    if (fresh.length === 0) return
    // Anything private that just arrived, opened before it is drawn.
    if (fresh.some((e) => e.kind === 'dm')) void this.chat?.readDirect()
    // Somebody else said something, and said it just now rather than last week.
    if (fresh.some((e) => e.kind === 'said' && e.author !== this.chat?.me && isNews(e.at))) {
      chirpMessage()
    }
    this.noticeMentions(fresh)
    // Pass on what was new, so a line reaches people we are not linked to.
    for (const wire of this.chat?.encode(fresh) ?? []) this.mesh?.broadcast(wire)
    /*
     * And to the archive, which only ever heard what this device said itself.
     *
     * Somebody else's message reached it only through the sweep below, on the
     * next time somebody opened the space. Everything written between one visit
     * and the next was held by the people who were there and by nobody who was
     * not, which is the one thing an archive is for.
     */
    this.archive?.push(fresh)
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
    return true
  }

  /**
   * A nudge, the way the messengers of 2004 did it: the window shakes, the
   * speaker rattles, and nothing is written down. It rides the mesh like a
   * typing notice, because it is true for half a second and then it is not.
   *
   * Named, it goes to one person's devices. Bare, it goes to the room. Both
   * ends shake, because feeling it land is what made it a nudge, and both
   * directions are rationed, because the same year taught everybody why.
   */
  private sendNudge(arg: string): void {
    const chat = this.chat
    if (!chat || !this.mesh) return

    // Whoever was named, or whoever this conversation is with, or the room.
    let key = ''
    const wanted = arg.trim().toLowerCase()
    if (wanted) {
      const found = [...this.everybody()].find(([, who]) => who.toLowerCase() === wanted)
      if (!found) {
        toast(`Nobody here is called ${arg.trim()}.`, 'warn')
        return
      }
      key = found[0]
    } else if (this.direct) {
      key = this.direct
    }

    const last = this.nudgeSent.get(key || '*') ?? 0
    if (Date.now() - last < NUDGE_EVERY_MS) {
      toast('Easy. One nudge every twenty seconds.', 'warn')
      return
    }

    if (key) {
      const sessions = this.mesh.peers().filter((p) => p.key === key)
      if (sessions.length === 0) {
        toast('They are not here right now.', 'warn')
        return
      }
      for (const p of sessions) this.mesh.sendTo(p.id, JSON.stringify({ t: 'nudge', d: 1 }))
      toast(`You nudged ${chat.nameOf(key) || shortKey(key)}.`, 'info')
    } else {
      this.mesh.broadcast(JSON.stringify({ t: 'nudge', c: this.channel }))
      toast(`You nudged #${this.channel}.`, 'info')
    }
    this.nudgeSent.set(key || '*', Date.now())
    this.shake()
    buzzNudge()
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
   * Rationed like the nudge, at both ends, because a voice that cannot be
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

  /** Returns true when this was a nudge rather than a pile of events. */
  private takeNudge(from: string, raw: string): boolean {
    if (!raw.startsWith('{"t":"nudge"')) return false
    let note: { t?: string; c?: unknown; d?: unknown }
    try {
      note = JSON.parse(raw) as { t?: string; c?: unknown; d?: unknown }
    } catch {
      return false
    }
    if (note.t !== 'nudge') return false
    const now = Date.now()
    if (now - this.lastShakeAt < NUDGE_COOL_MS) return true
    this.lastShakeAt = now

    const key = this.mesh?.peers().find((p) => p.id === from)?.key || ''
    const who = (key && this.chat?.nameOf(key)) || 'Somebody'
    const where =
      note.d === 1 ? 'you' : `#${typeof note.c === 'string' ? cleanChannel(note.c) : this.channel}`
    this.shake()
    buzzNudge()
    toast(`${who} nudged ${where}`, 'info', 4000)
    return true
  }

  /** The whole window jumps, briefly. MSN said it best. */
  private shake(): void {
    const el = document.body
    el.classList.remove('nudged')
    // Reading the width forces a layout, which is what lets the same
    // animation run again on the next nudge.
    void el.offsetWidth
    el.classList.add('nudged')
    window.setTimeout(() => el.classList.remove('nudged'), 700)
  }

  /**
   * Deep history, healed by asking. Returns true when this was sync talk
   * rather than a pile of events.
   *
   * The backfill on a fresh link is the newest 250 events, and that used to
   * be the end of it: a device away longer than that stayed short for ever,
   * because nothing ever went back for the rest. So each side says how far
   * back it reaches, whoever is short asks for the slice below where they
   * stop, and the answer ends with a fresh summary, so the asking repeats
   * until the two summaries agree. Asking the same line twice means the
   * answer did not help, and the asking stops there rather than looping.
   */
  private takeSync(from: string, raw: string): boolean {
    const isHave = raw.startsWith('{"t":"have"')
    const isPull = raw.startsWith('{"t":"pull"')
    if (!isHave && !isPull) return false
    const chat = this.chat
    if (!chat) return true
    let wire: { n?: unknown; low?: unknown; below?: unknown }
    try {
      wire = JSON.parse(raw) as { n?: unknown; low?: unknown; below?: unknown }
    } catch {
      return true
    }
    if (isPull && typeof wire.below === 'number') {
      for (const out of chat.below(wire.below)) this.mesh?.sendTo(from, out)
      this.mesh?.sendTo(from, chat.summary())
    } else if (isHave && typeof wire.n === 'number' && typeof wire.low === 'number') {
      const below = chat.wantPull({ n: wire.n, low: wire.low })
      if (below === null || this.pulled.get(from) === below) return true
      this.pulled.set(from, below)
      this.mesh?.sendTo(from, JSON.stringify({ t: 'pull', below }))
    }
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

      if (e.kind === 'dm') {
        if (String(e.body.to ?? '') !== chat.me) continue
        if (this.direct === e.author) continue
        toast(`${who} sent you a message`, 'info', 8000, {
          label: 'Read',
          run: () => this.openDirect(e.author),
        })
        // The text is sealed until readDirect has opened it, so the
        // notification says who rather than what, which is right for a private
        // message sitting on a lock screen anyway.
        notify(who, 'Sent you a private message', () => this.openDirect(e.author))
        continue
      }

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
        label: 'Rename it',
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
        label: 'Delete it',
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
      case 'nudge': {
        this.sendNudge(arg)
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
        const names = this.everybody()
        const wanted = arg.split(' ')[0]?.toLowerCase() ?? ''
        const found = [...names].find(([, who]) => who.toLowerCase() === wanted)
        if (!found) {
          toast(`Nobody here is called ${wanted || 'that'}.`, 'warn')
          return true
        }
        const text = arg.slice(wanted.length).trim()
        this.openDirect(found[0])
        if (text) void this.publish((c) => c.sayDirect(found[0], text))
        return true
      }
      case 'invite': {
        void copyText(roomLink(this.secret, this.locked)).then((ok) =>
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
  private openDirect(key: string | null): void {
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
  }

  /**
   * Trade histories with the archive, once, on the way in.
   *
   * Everything it has that we do not, and then, the first time this device ever
   * reads this archive, everything we have that it did not just hand us.
   *
   * That last part used to be the whole log, every single visit. The archive
   * cannot read what it holds, so it cannot recognise a line it already has,
   * and it kept every copy: a space opened a hundred times held a hundred
   * copies of its own history. The server drops the oldest half when a space
   * grows too large, so what those copies pushed out was the real history they
   * were copies of.
   */
  private async catchUp(): Promise<void> {
    if (!this.archive?.on || !this.chat) return
    // Nothing read from this archive yet, so what it holds is unknown and this
    // device's history may be the only copy of some of it.
    const first = this.archive.cursor === 0
    const found = await this.archive.fetch()
    if (found.length) {
      const fresh = await this.chat.absorb(found)
      if (fresh.length) this.draw()
    }
    if (first) {
      // Everything it did not just give us. Reading from the top is what makes
      // this exact rather than a guess.
      const held = new Set(found.map((e) => e.id))
      this.archive.push(this.chat.log.all().filter((e) => !held.has(e.id)))
    }
    await this.remember({})
  }

  /** Point this space at an archive, or at nothing. */
  async setArchive(url: string): Promise<boolean> {
    if (!this.room) return false
    const archive = this.archive ?? new Archive(this.room.id, this.room.key, this.room.write)
    this.archive = archive
    const accepted = archive.use(url)
    if (!accepted) {
      // Turned off here, said out loud, so a default set later does not turn it
      // back on behind your back.
      await this.remember({ archive: '' })
      return true
    }
    const alive = await archive.check()
    if (!alive) {
      archive.use('')
      return false
    }
    await this.remember({ archive: accepted })
    void this.catchUp()
    return true
  }

  get archiveAddress(): string {
    return this.archive?.address ?? ''
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
    this.channelTitle.append(h('span', { class: 'eyebrow', text: `#${here?.label ?? this.channel}` }))
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
    // Somebody with the right to do it has shut the space down. Not us: the
    // one who pressed the button has their own path out, and it waits for the
    // news to leave the building first.
    if (this.chat?.isClosed && !this.closing) void this.acceptClose()
    this.renderChannels()
    this.renderThreads()
    this.renderDirects()
    this.renderVoice()
    this.renderPeople()
    this.renderShareButton()
    this.status()
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

  /** Keep what this device knows about the space up to date. */
  private async remember(
    patch: Partial<{
      founder: string
      name: string
      archive: string
      read: Record<string, number>
      readDm: Record<string, number>
    }>,
  ): Promise<void> {
    if (!this.room || this.forgotten) return
    const existing = await getRoom(this.room.id)
    await noteRoom({
      room: this.room.id,
      secret: this.secret,
      lastSeen: Date.now(),
      // Falsy rather than missing all the way down: an empty name is "we have
      // not heard one yet", which must not overwrite one we heard last week.
      title: patch.name || this.chat?.spaceName() || existing?.title || '',
      locked: this.locked,
      // Kept so a locked space asks for its password once, not every visit.
      password: this.password || existing?.password || undefined,
      /*
       * An address, or the empty string, or nothing at all, and the three mean
       * different things. Empty is "turned off here on purpose" and has to
       * outlast a default being set later; nothing at all is "whatever the
       * default is". Only somebody saying so writes the empty string, which is
       * why it arrives as a patch rather than being read off an archive that is
       * merely not running.
       */
      archive: patch.archive ?? (this.archive?.address || existing?.archive),
      // A space that was closed stays closed, however it is opened again.
      closed: existing?.closed || undefined,
      read: patch.read ?? existing?.read,
      readDm: patch.readDm ?? existing?.readDm,
      archiveAt: this.archive?.cursor ?? existing?.archiveAt,
      founder: patch.founder ?? existing?.founder ?? this.chat?.founder ?? '',
    })
  }

  private status(): void {
    if (!this.chrome) return
    if (!this.loaded) {
      // Nothing true to say yet, so it says that rather than something else.
      this.chrome.setStatus(['Opening...'])
      return
    }
    const relays = this.bus?.healthList.filter((r) => r.status === 'open').length ?? 0
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
    this.chrome.setTitle(`Cathode | ${this.mentions ? `(${this.mentions}) ` : ''}${name}`)
    this.chrome.setStatus([
      what,
      `${people} here`,
      relays === 0 ? 'no relays' : `${relays} relay${relays === 1 ? '' : 's'}`,
    ])
  }

  /**
   * Say it loudly when no relay answers.
   *
   * Blocked relays look like a broken app: the space opens from disk, the
   * history draws, and then nobody arrives and nothing syncs, with no error
   * anywhere. A VPN did exactly this to a real person, who spent the evening
   * blaming the app. Ten seconds of silence from every relay is worth one
   * loud sentence, once per outage.
   */
  private watchRelays(): void {
    const open = () => this.bus?.healthList.filter((r) => r.status === 'open').length ?? 0
    if (open() > 0) {
      this.relayWarned = false
      if (this.relayTimer !== null) {
        window.clearTimeout(this.relayTimer)
        this.relayTimer = null
      }
      return
    }
    if (this.relayWarned || this.relayTimer !== null) return
    this.relayTimer = window.setTimeout(() => {
      this.relayTimer = null
      if (this.stopped || this.relayWarned || open() > 0) return
      this.relayWarned = true
      toast(
        'Cathode cannot reach a signal relay, so nobody new can be found and nothing will sync. A VPN or a firewall on this network is the usual cause.',
        'bad',
        12_000,
      )
    }, 10_000)
  }

  // ---- layout ----

  private renderShell(): void {
    clear(this.root)

    this.channelList = h('div', { class: 'rail-list' })
    this.voiceList = h('div', { class: 'rail-list' })
    this.directList = h('div', { class: 'rail-list' })
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
      h('span', { class: 'eyebrow', text: `#${this.channel}` }),
    ])

    this.shareButton = h('button', { class: 'primary grow' }, [icon('monitor', 15), 'Share screen'])
    this.shareButton.addEventListener('click', () => void this.toggleShare())

    this.sharePanel = h('div', { class: 'share-panel hidden' })

    this.chatPanel = new ChatPanel(loadIdentity().name, 'Chat')
    this.chatPanel.showNameField(false)
    this.chatPanel.onPoll = () => void this.newPoll()
    this.chatPanel.onTyping = () => this.sayTyping()
    this.chatPanel.onThread = (rootId) => this.openThread(rootId)
    this.chatPanel.onDirect = (key) => this.openDirect(key)
    this.chatPanel.onCommand = (line) => this.runCommand(line)
    this.chatPanel.onGif = () => void this.openGifPicker('')
    this.chatPanel.onSound = () => this.openBoard(this.chatPanel?.soundAnchor ?? null)
    this.chatPanel.commands = COMMANDS
    this.chatPanel.actions = {
      say: (text, replyTo, inThread) =>
        void this.publish((c) => c.say(text, this.channel, replyTo, inThread)),
      sayDirect: (to, text) => void this.publish((c) => c.sayDirect(to, text)),
      edit: (id, text) => void this.publish((c) => c.edit(id, text)),
      react: (id, emoji, on) => void this.publish((c) => c.react(id, emoji, on)),
      retract: (id) => void this.publish((c) => c.retract(id)),
      pin: (id, on) => void this.publish((c) => c.pin(id, on)),
      vote: (id, choice) => void this.publish((c) => c.vote(id, choice)),
      rename: (name) => this.rename(name),
    }
    // Cards under links, where the space has an archive to go and look.
    this.chatPanel.previewFor = (url) =>
      this.archive?.on ? this.archive.preview(url) : Promise.resolve(null)
    this.chatPanel.setEnabled(true)

    // Empty rather than a guess. The name arrives with the log.
    this.spaceTitle = h('span', { class: 'space-name truncate', text: '' })

    const left = h('div', { class: 'rail rail-left', role: 'navigation', ariaLabel: 'Channels, threads and conversations' }, [
      // Just the name. Renaming and clearing live in settings, where a thing
      // you do rarely and cannot undo belongs.
      h('div', { class: 'rail-head space-title' }, [this.spaceTitle]),
      h('div', { class: 'rail-head' }, [
        h('span', { class: 'eyebrow', text: 'Text channels' }),
        /*
         * Only the log's admins can make a channel, so only they get the
         * button. It used to show for everybody and do nothing for most of
         * them: the event went out, every peer ignored it, and the person who
         * clicked was left staring at a rail that had not changed.
         */
        (this.newTextButton = h('button', {
          class: 'ghost tiny-btn hidden',
          text: '+',
          title: 'Make a text channel',
          on: { click: () => void this.newChannel(false) },
        })),
      ]),
      this.channelList,
      h('div', { class: 'rail-head' }, [
        h('span', {
          class: 'eyebrow',
          text: 'Voice channels',
          title: 'Everybody standing in one hears everybody else.',
        }),
        (this.newVoiceButton = h('button', {
          class: 'ghost tiny-btn hidden',
          text: '+',
          title: 'Make a voice channel',
          on: { click: () => void this.newChannel(true) },
        })),
      ]),
      this.voiceList,
      h('div', { class: 'rail-head' }, [
        h('span', { class: 'eyebrow', text: 'Threads', title: 'Conversations hanging off a message' }),
      ]),
      this.threadList,
      h('div', { class: 'rail-head' }, [
        h('span', {
          class: 'eyebrow',
          text: 'Direct',
          title: 'Sealed so the room carries them and cannot read them',
        }),
      ]),
      this.directList,
      h('div', { class: 'grow' }),
      this.voiceBar,
      h('div', { class: 'rail-foot stack tight' }, [
        h('div', { class: 'row' }, [this.shareButton]),
        h('div', { class: 'row' }, [
          h(
            'button',
            { class: 'grow', title: 'Your name, your ID, and the look', on: { click: () => this.openSettings() } },
            [icon('shield', 14), 'Settings'],
          ),
          /*
           * The way out, and the only one there was not.
           *
           * The caption buttons went with the title bar, and leaving went with
           * them, so the list of spaces could be reached by editing the address
           * bar and no other way. Nothing is given up by pressing it: the space
           * stays on this device and the link still opens it.
           */
          h('button', {
            title: 'Back to your spaces. This one stays on this device.',
            ariaLabel: 'Your spaces',
            class: 'icon-only',
            on: { click: () => this.goHome() },
          }, [icon('home', 15)]),
        ]),
      ]),
    ])

    const right = h('div', { class: 'rail rail-right', role: 'complementary', ariaLabel: 'Who is here' }, [
      h('div', { class: 'rail-head' }, [h('span', { class: 'eyebrow', text: 'Members' })]),
      this.peopleList,
      h('div', { class: 'grow' }),
      this.inviteBox(),
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
        input: () => this.renderSearch(),
        keydown: (ev) => {
          if ((ev as KeyboardEvent).key === 'Escape') this.closeSearch()
        },
      },
    })
    this.searchResults = h('div', { class: 'search-results hidden' })

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
    this.peopleButton = h('button', {
      class: 'ghost icon-only rail-button',
      ariaLabel: 'Who is here',
      title: 'Who is here, and the invite',
      on: { click: () => this.showRail(this.railOpen === 'right' ? null : 'right') },
    })
    this.peopleButton.append(icon('people', 16))

    this.shell = h('div', { class: 'space-grid loading' }, [
      scrim,
      left,
      h('div', { class: 'space-main' }, [
        h('div', { class: 'space-head row spread' }, [
          this.channelsButton,
          this.channelTitle,
          this.pinsButton,
          this.searchInput,
          this.peopleButton,
        ]),
        this.searchResults,
        this.streamBar,
        this.stage,
        this.sharePanel,
        this.chatPanel.root,
      ]),
      right,
    ])

    this.root.append(h('main', {}, [this.shell]))
  }

  private openSettings(): void {
    clear(this.root)
    this.settingsOpen = true
    this.root.append(
      settingsView({
        rename: (name, avatar) => this.rename(name, avatar),
        archive: this.archiveAddress,
        setArchive: (url) => this.setArchive(url),
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
    if (this.settingsOpen) this.openSettings()
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
      `Leave ${name}? Its history goes from this device. Everybody else keeps theirs, and the link still works if you want back in.`,
    )
    if (!ok) return
    await this.forget(false)
    toast('Left, and forgotten on this device.', 'info')
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
   * Put this device's copy down and go back to the list.
   *
   * A space that was closed leaves a tombstone rather than nothing at all. See
   * tombstoneRoom: forgetting it outright means the link opens a fresh empty
   * room a minute later, which looks exactly like a space that lost everything.
   */
  private async forget(closed: boolean): Promise<void> {
    if (this.forgotten) return
    this.forgotten = true
    const room = this.room
    const note = room ? await getRoom(room.id) : null
    // The close, and the roles that decide whether it counts. Nothing else.
    const keep = (this.chat?.log.all() ?? []).filter(
      (e) => e.kind === 'close' || e.kind === 'role',
    )
    this.destroy()
    if (room) {
      if (closed && note) await tombstoneRoom(note, keep)
      else await forgetRoom(room.id)
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

  private inviteBox(): HTMLElement {
    const code = h('div', {
      class: 'share-code',
      text: formatSecret(this.secret),
      title: 'The code for this space',
      data: { link: roomLink(this.secret, this.locked) },
    })
    const copy = h('button', { class: 'grow' }, [icon('copy', 14), 'Copy invite'])
    copy.addEventListener('click', async () => {
      const ok = await copyText(roomLink(this.secret, this.locked))
      toast(ok ? 'Invite link copied.' : 'Could not copy. The code is above.', ok ? 'info' : 'warn')
    })
    const qr = h('button', { class: 'icon-only', title: 'Show a QR code', ariaLabel: 'Show a QR code' })
    qr.append(icon('qr', 14))
    qr.addEventListener('click', () => this.showQr())
    /*
     * The code, and two ways to hand it over. Nothing else.
     *
     * It used to explain itself underneath: the link in full, and a line about
     * sending the password separately. Both were true and neither was needed
     * every time you looked at the corner of the window. The code is the
     * thing; a lock on it says the rest.
     */
    return h('div', { class: 'stack tight' }, [
      h('div', { class: 'row spread' }, [
        h('span', { class: 'eyebrow', text: 'Invite' }),
        this.locked
          ? h('span', {
              class: 'tiny faint',
              title: 'This space has a password. Send it separately from the link.',
              text: 'locked',
            })
          : null,
      ]),
      code,
      h('div', { class: 'row' }, [copy, qr]),
    ])
  }

  private showQr(): void {
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
      frame.append(qrSvg(roomLink(this.secret, this.locked), { pixels: 240 }))
    } catch {
      frame.append(h('div', { class: 'small', text: 'This link is too long for a QR code.' }))
    }
    const scrim = h('div', {
      class: 'scrim',
      on: { click: (ev) => ev.target === scrim && close() },
    })
    scrim.append(
      h('div', { class: 'modal' }, [
        h('div', { class: 'row spread' }, [
          h('span', { class: 'eyebrow', text: 'Scan to join' }),
          h('button', { ariaLabel: 'Close', on: { click: close } }, [icon('close', 14)]),
        ]),
        frame,
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
            h('span', { class: 'truncate grow', text: `# ${channel.label}` }),
            sharingHere ? h('span', { class: 'pill good', text: 'live' }) : null,
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
        on: { click: () => openMenu(more, this.channelActions(channel)) },
      })
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
    if (threads.length === 0) {
      this.threadList.append(
        h('div', {
          class: 'tiny faint',
          style: { padding: '2px 7px' },
          text: 'None yet. Answer a message in a thread to start one.',
        }),
      )
      return
    }
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

  /** The people you have written to privately, most recent first. */
  private renderDirects(): void {
    clear(this.directList)
    const chats = this.chat?.directs() ?? []
    if (chats.length === 0) {
      this.directList.append(
        h('div', {
          class: 'tiny faint',
          style: { padding: '2px 7px' },
          text: 'Nobody yet. Use somebody\u2019s menu, or /dm.',
        }),
      )
      return
    }
    for (const talk of chats) {
      const label = talk.name || shortKey(talk.key)
      this.directList.append(
        h(
          'button',
          {
            class: `rail-item${this.direct === talk.key ? ' on' : ''}${talk.unread ? ' unread' : ''}`,
            on: { click: () => this.openDirect(talk.key) },
          },
          [
            avatarOf(talk.key, talk.name, this.chat?.avatarOf(talk.key) ?? '', 16),
            h('span', { class: 'truncate grow', text: label }),
            talk.unread ? h('span', { class: 'pill bad', text: `${talk.unread}` }) : null,
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
            icon('volume-low', 13),
            h('span', { class: 'truncate grow', text: name }),
            members.length ? h('span', { class: 'pill', text: String(members.length) }) : null,
          ],
        ),
      ])
      for (const id of members) {
        const talking = this.voice?.isTalking(id) ?? false
        const label =
          id === this.selfId
            ? `${this.chat?.displayName ?? 'You'} (you)`
            : this.mesh?.peers().find((p) => p.id === id)?.name || shortKey(id)
        row.append(
          h('div', { class: `voice-member${talking ? ' talking' : ''}` }, [
            h('i', { class: `dot ${talking ? 'talking' : 'good'}` }),
            h('span', { text: label }),
          ]),
        )
      }
      this.voiceList.append(row)
    }

    const state = this.voice?.state
    this.voiceBar.classList.toggle('hidden', !state?.channel)
    if (state?.channel) {
      clear(this.voiceBar)
      this.voiceBar.append(
        h('div', { class: 'row spread' }, [
          h('span', { class: 'tiny good truncate' }, [icon('volume-low', 12), ` ${state.channel}`]),
          h('span', { class: 'tiny faint', text: `${(this.voice?.connected ?? 0) + 1} in` }),
        ]),
        h('div', { class: 'row' }, [
          h('button', {
            class: `grow small${state.muted ? ' on' : ''}`,
            text: state.muted ? 'Unmute' : 'Mute',
            on: { click: () => this.voice?.setMuted(!state.muted) },
          }),
          h('button', {
            class: 'small danger',
            text: 'Leave',
            on: { click: () => this.leaveVoice() },
          }),
        ]),
      )
    }
  }

  private async joinVoice(name: string): Promise<void> {
    if (this.voice?.state.channel === name) return
    try {
      await this.voice?.join(name)
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
   * The ask came off a public relay, so it carries its own proof: the admin
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

  private leaveVoice(): void {
    this.voice?.dispose()
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
      label: `Message ${name}`,
      note: 'Privately, sealed to the two of you',
      run: () => this.openDirect(key),
    })

    if (chat.nameOf(key)) {
      items.push({
        label: `Mention ${name}`,
        note: 'Puts @' + name + ' in the message you are writing',
        run: () => {
          this.chatPanel?.insert(`@${name} `)
          this.chatPanel?.focus()
        },
      })
    }

    if (here) {
      items.push({
        label: `Nudge ${name}`,
        note: 'Shakes their window, the old way',
        run: () => this.sendNudge(name),
      })
    }

    items.push({
      label: 'Copy their ID',
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
        label: 'Make an admin',
        note: 'They can rename, pin, clear and remove people',
        run: () => void this.setRole(key, 'admin'),
      })
    } else if (key !== chat.founder) {
      items.push({
        label: 'Take admin away',
        run: () => void this.setRole(key, 'member'),
      })
    }
    if (role === 'kicked') {
      items.push({
        label: 'Let them back in',
        run: () => void this.setRole(key, 'member'),
      })
    } else if (key !== chat.founder) {
      items.push({
        label: `Remove ${name}`,
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

    let drawnOffline = false
    for (const row of order) {
      if (!row.here && !drawnOffline) {
        drawnOffline = true
        this.peopleList.append(
          h('div', { class: 'rail-head' }, [h('span', { class: 'eyebrow', text: 'Not here' })]),
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
        on: { click: () => openMenu(more, this.actionsFor(row.key, role, row.you, row.here)) },
      })
      more.append(icon('more', 14))

      this.peopleList.append(
        h('div', { class: `rail-person${row.here ? '' : ' away'}`, title: `ID ${row.key}` }, [
          /*
           * Green: here and reading. Orange: here with the tab put away.
           * Hollow: their device answers but the link between us is not up yet,
           * which is a second or two on the way in and is worth showing rather
           * than pretending either of the other two.
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
          h('div', { class: 'grow row', style: { minWidth: '0' } }, [
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
          row.voice
            ? h(
                'span',
                {
                  class: `pill${row.talking ? ' talking' : ''}`,
                  title: row.talking ? `Talking in ${row.voice}` : `In voice: ${row.voice}`,
                },
                [icon('volume-low', 11)],
              )
            : null,
          row.sharing ? h('span', { class: 'pill good', text: 'live' }) : null,
          actions.length ? more : null,
        ]),
      )
    }
  }

  /**
   * Where a search goes.
   *
   * Your own key first, because it is the one most people have: it is kept in
   * this browser, it works with no server at all, and a space that never runs
   * an archive can still find a GIF. The archive second, because when a space
   * does have one it is the better shape, holding the key on one machine
   * rather than on everybody's.
   *
   * Nothing third. A picker that opens and says what is missing beats a toast
   * that flashes past somebody who was looking at the grid.
   */
  private async findGifs(term: string): Promise<{ gifs: Gif[]; from: string }> {
    const held = gifCredential()
    if (held) {
      return { gifs: await searchGifs(term, held), from: serviceLabel(held.service) }
    }
    // The archive answers a term. It has nothing to say about an empty one,
    // so an empty box waits rather than asking a question with no question.
    if (this.archive?.on) {
      return { gifs: term.trim() ? await this.archive.gifs(term) : [], from: 'the archive' }
    }
    return { gifs: [], from: '' }
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
      if (!pop.contains(ev.target as Node)) done()
    }
    let timer: number | null = null
    const done = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      pop.remove()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onAway, true)
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
        const img = h('img', { class: 'gif-choice' })
        img.src = g.preview
        img.alt = ''
        img.loading = 'lazy'
        img.referrerPolicy = 'no-referrer'
        img.addEventListener('click', () => send(g.url))
        grid.append(img)
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
    box.focus()
    await run()
  }

  /** Why the grid is empty, said in the box rather than in a toast. */
  private gifTrouble(wanted: string, from: string): (string | Node)[] {
    if (from === '') {
      return [
        'GIF search needs a key, and there is nowhere here to keep one for you. ',
        'Paste your own under Settings, GIFs: it stays in this browser and is never said in a space. ',
        'A space with an archive can hold one instead, for everybody at once.',
      ]
    }
    if (!wanted) {
      return from === 'the archive'
        ? ['Type what to look for.']
        : ['Nothing came back. Type what to look for.']
    }
    return from === 'the archive'
      ? [`Nothing for "${wanted}". An archive with no Tenor key finds nothing; see server/README.md.`]
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
        'Anybody who has already saved a copy of the history keeps it. There is ' +
        'no server to take it back from them.',
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
    this.shareButton.append(
      icon(sharing ? 'stop' : 'monitor', 15),
      sharing ? 'Stop sharing' : 'Share screen',
    )
    this.shareButton.classList.toggle('danger', sharing)
    this.shareButton.classList.toggle('primary', !sharing)
    this.sharePanel.classList.toggle('hidden', !sharing)
    // The stage is only up for something you chose to put on it.
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

    this.showOwnPreview()
    this.buildSharePanel()
    this.announceMe()
    void this.publish((c) => c.say(`started sharing in #${this.channel}`, this.channel))
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

  /** Everybody sharing in the channel we are looking at, ourselves included. */
  private liveHere(): { id: string; name: string; you: boolean; key: string }[] {
    const out: { id: string; name: string; you: boolean; key: string }[] = []
    if (this.capture && this.channel) {
      out.push({ id: this.selfId, name: 'Your screen', you: true, key: this.chat?.me ?? '' })
    }
    for (const [id, channel] of this.sharers) {
      if (channel !== this.channel || id === this.selfId) continue
      const peer = this.mesh?.peers().find((p) => p.id === id)
      out.push({ id, name: peer?.name || shortKey(id), you: false, key: peer?.key ?? '' })
    }
    return out
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

  /** A few names in full, and a count for the rest. */
  private fewNames(names: string[]): string {
    if (names.length <= 3) return names.join(', ')
    return `${names.slice(0, 3).join(', ')} +${names.length - 3}`
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
        entry.tag.textContent = eyes.length
          ? `Your screen · watched by ${this.fewNames(eyes)}`
          : 'Your screen, as the others see it'
      } else {
        const whose = live.find((l) => l.id === id)?.name ?? 'a shared screen'
        const others = this.watcherNames(id)
        entry.tag.textContent = others.length
          ? `Watching ${whose}, with ${this.fewNames(others)}`
          : `Watching ${whose}`
      }
    }
    if (live.length === 0) return

    const watching = this.watched.size > 0
    this.streamBar.append(
      h('span', {
        class: 'eyebrow',
        text: live.length === 1 ? 'Live here' : `Live here (${live.length})`,
      }),
    )

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
          title:
            (one.you ? 'Show your own screen here' : `Put ${one.name} on your screen`) +
            (eyes.length ? `. Watching: ${eyes.join(', ')}` : ''),
          on: { click: () => this.watch(one.id) },
        },
        [
          avatarOf(one.key || one.id, one.name, this.chat?.avatarOf(one.key) ?? '', 18),
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
          text: 'Stop watching',
          title: 'Take every stream off your screen. Escape does the same.',
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
      this.renderSharePanel(plan, peers.length)
    }
    for (const [id, entry] of this.watched) {
      if (id === this.selfId || !entry.peer) continue
      const s = await entry.peer.sample()
      entry.surface.setBadges([
        { text: fmtKbps(s.kbps) },
        { text: `${s.width}x${s.height}` },
        { text: `${s.fps} fps` },
        ...(s.codec ? [{ text: s.codec }] : []),
      ])
    }
    void this.remember({})
  }

  // ---- the share controls ----

  private buildSharePanel(): void {
    clear(this.sharePanel)
    const presets = h('div', { class: 'chips' })
    for (const preset of PRESETS) {
      presets.append(
        h('button', {
          class: `chip${this.settings.presetId === preset.id ? ' on' : ''}`,
          text: preset.name,
          title: preset.useWhen,
          on: { click: () => void this.applyPreset(preset.id) },
        }),
      )
    }

    const resolution = h('div', { class: 'chips' })
    for (const choice of RESOLUTION_CHOICES) {
      resolution.append(
        h('button', {
          class: `chip${this.settings.maxHeight === choice.height ? ' on' : ''}`,
          text: choice.label,
          title: choice.note,
          on: {
            click: () => {
              this.settings.maxHeight = choice.height
              this.settings.presetId = 'custom'
              saveSettings(this.settings)
              void this.applyConstraints()
            },
          },
        }),
      )
    }

    const fps = h('div', { class: 'chips' })
    for (const choice of FPS_CHOICES) {
      fps.append(
        h('button', {
          class: `chip${this.settings.fps === choice.fps ? ' on' : ''}`,
          text: choice.label,
          title: choice.note,
          on: {
            click: () => {
              this.settings.fps = choice.fps
              this.settings.presetId = 'custom'
              saveSettings(this.settings)
              void this.applyConstraints()
            },
          },
        }),
      )
    }

    const mic = h('button', { text: 'Turn on the microphone' })
    mic.addEventListener('click', async () => {
      if (this.mixer?.hasMic) {
        this.mixer.stopMic()
        mic.textContent = 'Turn on the microphone'
        mic.classList.remove('on')
        return
      }
      try {
        this.mixer?.attachMic(await captureMicrophone())
        mic.textContent = 'Microphone is on'
        mic.classList.add('on')
      } catch (err) {
        toast(err instanceof CaptureError ? err.message : String(err), 'bad')
      }
    })

    this.planLine = h('div', { class: 'plan-box tiny' })

    this.sharePanel.append(
      h('div', { class: 'card stack tight' }, [
        h('div', { class: 'row spread' }, [
          h('span', { class: 'eyebrow', text: `Sharing in #${this.channel}` }),
          h('span', { class: 'pill good' }, [h('i', { class: 'dot live' }), 'live']),
        ]),
        presets,
        this.planLine,
        h('details', { class: 'adv' }, [
          h('summary', { text: 'Fine tuning' }),
          h('div', { class: 'stack tight' }, [
            labelled('Resolution', resolution),
            labelled('Frame rate', fps),
            mic,
          ]),
        ]),
      ]),
    )
    this.renderSharePanel(this.plan(1), 0)
  }

  private planLine: HTMLDivElement | null = null

  private renderSharePanel(plan: QualityPlan, watchers: number): void {
    if (!this.planLine) return
    const s = this.capture?.video.getSettings()
    const w = Math.round((s?.width ?? 1920) / plan.scaleDown)
    const hgt = Math.round((s?.height ?? 1080) / plan.scaleDown)
    this.planLine.textContent =
      `Each watcher gets ${w}x${hgt} at ${plan.maxFramerate} fps, about ${fmtKbps(plan.maxBitrateKbps)}. ` +
      `${watchers} watching.`
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
    this.buildSharePanel()
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
    this.buildSharePanel()
  }
}
