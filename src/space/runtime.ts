/**
 * One space, running: its log, its channel on the server connection, its
 * signal bus, and who is in it. It runs for as long as you are in the space,
 * whether or not the space is on screen, which is how a direct message or a
 * mention in a space you are not looking at still arrives.
 *
 * The screen for a space (ui/space-view.ts) attaches to one of these while it
 * is open and lets go when it closes. Calls and screen shares belong to the
 * screen; everything that has to keep going belongs here.
 */

import { deriveRoom, newPeerId, type Room } from '../room'
import { fetchIce, serverTag } from '../backend'
import { Voice } from '../net/voice'
import { rtcConfig } from '../rtc/config'
import { cleanChannel } from '../store/log'
import { chirpJoin, chirpLeave } from '../ui/sounds'
import { Channel, connectionTo } from '../net/connection'
import { SpaceFiles } from '../net/files'
import { Mesh } from '../net/mesh'
import { SignalBus } from '../signal/bus'
import type { Envelope } from '../signal/envelope'
import type { LogEvent } from '../store/log'
import { loadIdentity } from '../store/identity'
import type { RoomNote } from '../store/notes'
import { RoomChat, type Unread } from '../store/room-chat'
import { bookFor, stable } from '../store/server-spaces'
import { loadAvatar } from '../ui/avatar'

/** How stale "when you were last here" may get before it is written again. */
const LAST_SEEN_MS = 60 * 60 * 1000
/** How long opening waits for the history before letting you type anyway. */
const LOAD_WAIT_MS = 6000

type NotePatch = Partial<{
  founder: string
  name: string
  read: Record<string, number>
  readDm: Record<string, number>
  closed: boolean
}>

export interface OpenSpace {
  secret: string
  locked: boolean
  password: string
  server: string
  /** True when this person is making the space, so they claim it. */
  fresh?: boolean
  name?: string
}

/** How long a call rings before it is given up on. */
const RING_MS = 30_000

/**
 * A call between two people: a voice channel only they may stand in, named
 * at random so nobody could guess it and, because of `admit`, useless to
 * anybody who learned it.
 */
export interface CallState {
  id: string
  channel: string
  /** The other person's key. */
  with: string
  outgoing: boolean
  /** Both are in it. */
  live: boolean
  since: number
}

/** Somebody calling this device, until it is answered, declined or given up. */
export interface Ringing {
  id: string
  from: string
  session: string
}

export const isCallChannel = (channel: string | null): boolean => !!channel && channel.startsWith('call-')

/** Every space running, so joining voice in one leaves it everywhere else. */
const running = new Set<SpaceRuntime>()

/** What the call screens listen to: rings, ends, and failures, from any space. */
export type CallNews =
  | { kind: 'ringing' | 'rang-out' | 'changed'; space: SpaceRuntime }
  | { kind: 'ended'; space: SpaceRuntime; reason: string }
  | { kind: 'failed'; space: SpaceRuntime; peer: string }

export function callNews(news: CallNews): void {
  window.dispatchEvent(new CustomEvent<CallNews>('cathode:call', { detail: news }))
}

export class SpaceRuntime {
  readonly secret: string
  readonly locked: boolean
  readonly password: string
  readonly server: string
  /** This tab's session in the space. Random, and gone with the tab. */
  readonly selfId = newPeerId()

  room!: Room
  chat!: RoomChat
  channel!: Channel
  bus!: SignalBus
  mesh!: Mesh
  /**
   * Voice, for as long as the space runs rather than for as long as it is on
   * screen: a call carries on while you read another space, or Home.
   */
  voice!: Voice
  call: CallState | null = null
  ringing: Ringing | null = null
  private ice: { iceServers: RTCIceServer[]; relayOnly: boolean } = { iceServers: [], relayOnly: false }
  private ringTimer = 0
  private voiceWas: string | null = null
  /** What this device knows about the space: its name, how far you have read. */
  note: RoomNote | null = null
  /** Resolves once the space is running and its history has been read. */
  readonly ready: Promise<void>

  /** The latest each session said about itself, for a screen that opens later. */
  readonly presence = new Map<string, Envelope>()
  /** What the screen on show wants said about this session: sharing, voice, watching. */
  extras: () => Record<string, unknown> = () => ({})

  readonly listeners = {
    changed: new Set<() => void>(),
    signal: new Set<(env: Envelope) => void>(),
    data: new Set<(from: string, raw: string) => void>(),
    peers: new Set<() => void>(),
    fresh: new Set<(events: LogEvent[]) => void>(),
    status: new Set<() => void>(),
    voice: new Set<() => void>(),
  }

  private stopped = false
  private remembering: Promise<void> = Promise.resolve()

  constructor(open: OpenSpace) {
    this.secret = open.secret
    this.locked = open.locked
    this.password = open.password
    this.server = open.server
    running.add(this)
    this.ready = this.start(open)
  }

  private get book() {
    return bookFor(this.server)
  }

  private async start(open: OpenSpace): Promise<void> {
    this.room = await deriveRoom(this.secret, this.password)
    this.note = await this.book.get(this.room.id)
    // Written down before anything else, with the lock and password that make
    // it this room, so it is on your list even if the tab closes at once.
    await this.remember({})

    const identity = loadIdentity()
    const chat = new RoomChat(this.room.id, this.note?.founder ?? '')
    chat.onChange = () => this.emit('changed')
    chat.onDirect = () => this.emit('changed')
    chat.onFounder = (pubkey) => void this.remember({ founder: pubkey })
    chat.setDirectRead({ ...(this.note?.readDm ?? {}) })
    this.chat = chat

    const channel = new Channel(connectionTo(this.server), this.room, serverTag(this.server))
    channel.onEvents = (events) => void this.take(events)
    // Gone, on the server's word: the same as their own goodbye.
    channel.onLeft = (session) =>
      this.bus.deliver({ v: 1, id: `left:${session}:${Date.now()}`, from: session, t: Date.now(), type: 'bye' })
    channel.onRefused = (why) => console.warn(`[cathode] the server would not keep a write: ${why}`)
    this.channel = channel

    const bus = new SignalBus(this.room, this.selfId, [channel])
    const mesh = new Mesh(bus, this.selfId, identity.name)
    mesh.extra = () => ({
      // Who this is, so the roster is a list of people rather than of tabs.
      key: identity.pubkey,
      // Whether this tab is on screen: here, or here and looking elsewhere.
      away: document.hidden ? true : undefined,
      voice: this.voice?.state.channel ?? undefined,
      ...this.extras(),
    })
    mesh.onData = (from, raw) => this.emit('data', from, raw)
    mesh.onPeers = () => {
      this.voice?.prune(new Set(mesh.peers().map((p) => p.id)))
      this.emit('peers')
    }
    bus.onMessage = (env) => {
      mesh.handle(env)
      if (env.type === 'announce') {
        this.presence.set(env.from, env)
        const said = (env.data ?? {}) as Record<string, unknown>
        const standing = typeof said.voice === 'string' ? cleanChannel(said.voice) : ''
        this.voice?.noteAnnounce(env.from, standing || null)
      }
      if (env.type === 'bye') {
        this.presence.delete(env.from)
        this.voice?.forget(env.from)
      }
      void this.voice?.handle(env)
      this.callSignal(env)
      this.emit('signal', env)
    }
    bus.onHealth = () => this.emit('status')
    chat.onLocal = (event) => void channel.put([event])
    this.bus = bus
    this.mesh = mesh

    // The relay for calls, fetched now and not waited for: nothing needs it until somebody talks.
    void fetchIce(this.server).then((ice) => (this.ice = ice))
    const voice = new Voice(bus, this.selfId, () => rtcConfig(this.ice.iceServers, this.ice.relayOnly))
    voice.admit = (peer, channel) => !isCallChannel(channel) || (!!this.call && this.keyOf(peer) === this.call.with)
    voice.onArrival = (arrived, peer) => {
      if (arrived) chirpJoin()
      else chirpLeave()
      this.callArrival(arrived, peer)
    }
    voice.onFailed = (peer) => callNews({ kind: 'failed', space: this, peer })
    voice.onChange = () => {
      const now = voice.state.channel
      if (now !== this.voiceWas) {
        this.voiceWas = now
        mesh.announce()
      }
      this.emit('voice')
      callNews({ kind: 'changed', space: this })
    }
    this.voice = voice
    bus.start()
    mesh.start()
    document.addEventListener('visibilitychange', this.onVisible)

    // The history first: who runs the place, and whether your name is already
    // said, are both read from it. Not for ever, though.
    await Promise.race([channel.loaded, new Promise((r) => window.setTimeout(r, LOAD_WAIT_MS))])
    if (this.stopped) return
    void chat.readDirect()

    if (open.fresh && !chat.founder) {
      await chat.claimFounder()
      await this.remember({ founder: chat.me })
      if (open.name) await chat.setSpaceName(open.name)
    }
    await chat.announceName(chat.displayName, loadAvatar())
    this.emit('changed')
  }

  /** On screen or not, said at once in every space. */
  private readonly onVisible = (): void => {
    this.mesh.announce()
  }

  private async take(events: unknown[]): Promise<void> {
    const fresh = await this.chat.absorb(events)
    if (fresh.length === 0) return
    if (fresh.some((e) => e.kind === 'dm')) void this.chat.readDirect()
    if (fresh.some((e) => e.kind === 'space')) void this.remember({})
    this.emit('fresh', fresh)
  }

  private emit(what: 'changed' | 'peers' | 'status' | 'voice'): void
  private emit(what: 'signal', env: Envelope): void
  private emit(what: 'data', from: string, raw: string): void
  private emit(what: 'fresh', events: LogEvent[]): void
  private emit(what: keyof SpaceRuntime['listeners'], ...args: unknown[]): void {
    for (const fn of this.listeners[what] as Set<(...a: unknown[]) => void>) {
      try {
        fn(...args)
      } catch (err) {
        console.error('[cathode]', err)
      }
    }
  }

  /** Listen, and get back the way to stop. */
  on<K extends keyof SpaceRuntime['listeners']>(
    what: K,
    fn: SpaceRuntime['listeners'][K] extends Set<infer F> ? F : never,
  ): () => void {
    const set = this.listeners[what] as Set<typeof fn>
    set.add(fn)
    return () => set.delete(fn)
  }

  /** Say what this session is doing, now. */
  announce(): void {
    this.mesh?.announce()
  }

  /** What is waiting, across every channel, and how much of it names you. */
  unread(): { count: number; mentions: number; direct: number } {
    if (!this.chat) return { count: 0, mentions: 0, direct: 0 }
    let count = 0
    let mentions = 0
    for (const [, u] of this.chat.unread(this.note?.read ?? {}) as Map<string, Unread>) {
      count += u.count
      mentions += u.mentions
    }
    const direct = this.chat.directs().reduce((sum, d) => sum + d.unread, 0)
    return { count, mentions, direct }
  }

  /**
   * Keep the note up to date, one change at a time, and only when something
   * in it changed. Run side by side, each read the note before the others had
   * written it, and the last to land won.
   */
  remember(patch: NotePatch): Promise<void> {
    const own: NotePatch = {
      ...patch,
      read: patch.read ? { ...patch.read } : undefined,
      readDm: patch.readDm ? { ...patch.readDm } : undefined,
    }
    this.remembering = this.remembering.then(() => this.rememberNow(own)).catch(() => undefined)
    return this.remembering
  }

  private async rememberNow(patch: NotePatch): Promise<void> {
    if (!this.room || this.stopped) return
    const existing = this.note
    const next: RoomNote = {
      room: this.room.id,
      secret: this.secret,
      server: this.server,
      lastSeen: Date.now(),
      // An empty name is "not heard one yet", which must not overwrite one heard last week.
      title: patch.name || this.chat?.spaceName() || existing?.title || '',
      locked: this.locked,
      password: this.password || existing?.password || undefined,
      closed: patch.closed || existing?.closed || undefined,
      read: patch.read ?? existing?.read,
      readDm: patch.readDm ?? existing?.readDm,
      founder: patch.founder ?? existing?.founder ?? this.chat?.founder ?? '',
    }
    if (patch.readDm) this.chat?.setDirectRead(patch.readDm)
    this.note = next
    const plain = (n: RoomNote): string => {
      const { lastSeen: _lastSeen, ...rest } = n
      return stable(rest)
    }
    if (existing && Date.now() - existing.lastSeen < LAST_SEEN_MS && plain(existing) === plain(next)) return
    await this.book.put(next)
  }

  /** Stop: leave the space's channel and take nothing further. */
  // ---- voice ----

  /**
   * Stand in a voice channel here, and in no other space's. Must run from a
   * click, because it opens the microphone.
   */
  async joinVoice(channel: string): Promise<void> {
    if (this.voice.state.channel === channel) return
    for (const other of running) if (other !== this && other.voice?.state.channel) other.leaveVoice()
    if (this.call && this.call.channel !== channel) this.endCall()
    await this.voice.join(channel)
    chirpJoin()
  }

  leaveVoice(): void {
    if (this.call) {
      this.endCall()
      return
    }
    if (!this.voice?.state.channel) return
    this.voice.leave()
    chirpLeave()
  }

  private keyOf(session: string): string {
    return this.mesh?.peers().find((p) => p.id === session)?.key ?? ''
  }

  private sessionsOf(key: string): string[] {
    return (this.mesh?.peers() ?? []).filter((p) => p.key === key && p.id !== this.selfId).map((p) => p.id)
  }

  /** Whether somebody could be rung right now: some tab of theirs is here. */
  reachable(key: string): boolean {
    return this.sessionsOf(key).length > 0
  }

  // ---- calls between two people ----

  /** Ring somebody. From a click: it opens the microphone at once, so it is ready when they answer. */
  async startCall(key: string): Promise<void> {
    const sessions = this.sessionsOf(key)
    if (sessions.length === 0) throw new Error('They are not here right now, so they cannot be called.')
    const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
    this.call = { id, channel: `call-${id}`, with: key, outgoing: true, live: false, since: Date.now() }
    try {
      await this.joinVoice(this.call.channel)
    } catch (err) {
      this.call = null
      throw err
    }
    const me = this.chat.me
    for (const session of sessions) void this.bus.send({ type: 'ring', to: session, data: { call: id, by: me } })
    this.ringTimer = window.setTimeout(() => {
      if (this.call?.id === id && !this.call.live) this.endCall('No answer.')
    }, RING_MS)
    callNews({ kind: 'changed', space: this })
  }

  /** Pick up. From a click, for the microphone. */
  async answer(): Promise<void> {
    const ring = this.ringing
    if (!ring) return
    this.clearRinging()
    this.call = { id: ring.id, channel: `call-${ring.id}`, with: ring.from, outgoing: false, live: false, since: Date.now() }
    try {
      await this.joinVoice(this.call.channel)
    } catch (err) {
      this.call = null
      void this.bus.send({ type: 'ring-no', to: ring.session, data: { call: ring.id } })
      throw err
    }
    // The caller has been waiting in it all along, so they never arrive: they are simply there.
    if (this.otherIsIn(this.call)) {
      this.call.live = true
      this.call.since = Date.now()
    }
    callNews({ kind: 'changed', space: this })
  }

  /** Whether the other person of a call is standing in it, by their key, not by whoever else walked in. */
  private otherIsIn(call: CallState): boolean {
    return this.voice.membersOf(call.channel).some((id) => id !== this.selfId && this.keyOf(id) === call.with)
  }

  decline(): void {
    const ring = this.ringing
    if (!ring) return
    this.clearRinging()
    void this.bus.send({ type: 'ring-no', to: ring.session, data: { call: ring.id } })
  }

  /** Put the phone down, whether or not the other end ever picked up. */
  endCall(reason = ''): void {
    const call = this.call
    if (!call) return
    this.call = null
    window.clearTimeout(this.ringTimer)
    // Still ringing on their end: stop it there too.
    if (call.outgoing && !call.live) {
      for (const session of this.sessionsOf(call.with)) void this.bus?.send({ type: 'ring-stop', to: session, data: { call: call.id } })
    }
    if (this.voice?.state.channel === call.channel) {
      this.voice.leave()
      chirpLeave()
    }
    callNews({ kind: 'ended', space: this, reason })
  }

  private clearRinging(): void {
    if (!this.ringing) return
    this.ringing = null
    window.clearTimeout(this.ringTimer)
    callNews({ kind: 'rang-out', space: this })
  }

  /** The other person walked into the call, or out of it. */
  private callArrival(arrived: boolean, session: string): void {
    const call = this.call
    if (!call || this.voice.state.channel !== call.channel || this.keyOf(session) !== call.with) return
    if (arrived) {
      call.live = true
      call.since = Date.now()
      window.clearTimeout(this.ringTimer)
      callNews({ kind: 'changed', space: this })
    } else if (!this.otherIsIn(call)) {
      this.endCall('Call ended.')
    }
  }

  private callSignal(env: Envelope): void {
    const data = (env.data ?? {}) as Record<string, unknown>
    const id = typeof data.call === 'string' && /^[0-9a-f]{16}$/.test(data.call) ? data.call : ''
    if (!id) return
    switch (env.type) {
      case 'ring': {
        // Only from who it says it is from: the key their own presence names.
        const by = typeof data.by === 'string' ? data.by : ''
        if (!by || this.keyOf(env.from) !== by) return
        if (this.call || this.ringing || this.voice.state.channel) {
          void this.bus.send({ type: 'ring-busy', to: env.from, data: { call: id } })
          return
        }
        this.ringing = { id, from: by, session: env.from }
        this.ringTimer = window.setTimeout(() => {
          if (this.ringing?.id === id) this.clearRinging()
        }, RING_MS)
        callNews({ kind: 'ringing', space: this })
        return
      }
      case 'ring-no':
      case 'ring-busy': {
        if (this.call?.outgoing && this.call.id === id && !this.call.live && this.keyOf(env.from) === this.call.with) {
          this.endCall(env.type === 'ring-busy' ? 'They are on another call.' : 'They declined.')
        }
        return
      }
      case 'ring-stop': {
        if (this.ringing?.id === id && this.ringing.session === env.from) this.clearRinging()
        return
      }
      default:
        return
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    running.delete(this)
    this.endCall()
    this.voice?.dispose()
    document.removeEventListener('visibilitychange', this.onVisible)
    this.mesh?.stop()
    const bus = this.bus
    if (bus) window.setTimeout(() => bus.stop(), 200)
    for (const set of Object.values(this.listeners)) set.clear()
  }
}

const fileStores = new WeakMap<SpaceRuntime, SpaceFiles>()

/**
 * Where a space's files go and come from: its server, the one it is talking
 * to first, and its write token, which a server wants before it keeps
 * anything. One per space, so what one view opened another draws at once.
 */
export function filesFor(space: SpaceRuntime): SpaceFiles {
  let held = fileStores.get(space)
  if (!held) {
    held = new SpaceFiles(space.server, space.room.id, space.room.write, () => space.channel?.serving ?? space.server)
    fileStores.set(space, held)
  }
  return held
}
