import { fetchIce, serverTag } from '../backend'
import { Channel, connectionTo } from '../net/connection'
import { SpaceFiles } from '../net/files'
import { Mesh } from '../net/mesh'
import { Voice } from '../net/voice'
import { heardAt } from '../net/volume'
import { deriveRoom, newPeerId, type Room } from '../room'
import { rtcConfig } from '../rtc/config'
import { SignalBus } from '../signal/bus'
import type { Envelope } from '../signal/envelope'
import { loadIdentity } from '../store/identity'
import { cleanChannel, type LogEvent } from '../store/log'
import type { RoomNote } from '../store/notes'
import { PREFS_CHANGED } from '../store/prefs'
import { RoomChat } from '../store/room-chat'
import { bookFor, stable } from '../store/server-spaces'
import { adoptAvatar, avatarKnown, avatarSavedAt, loadAvatar } from '../ui/avatar'
import { chirpJoin, chirpLeave } from '../ui/sounds'

const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000
const HISTORY_WAIT_MS = 6000
const RING_TIMEOUT_MS = 30_000

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

interface CallState {
  id: string
  channel: string
  /** The other person's key. */
  with: string
  outgoing: boolean
  live: boolean
  since: number
}

interface Ringing {
  id: string
  from: string
  session: string
}

export const isCallChannel = (channel: string | null): boolean => !!channel && channel.startsWith('call-')

const runningSpaces = new Set<SpaceRuntime>()

export type CallNews =
  | { kind: 'ringing' | 'rang-out' | 'changed'; space: SpaceRuntime }
  | { kind: 'ended'; space: SpaceRuntime; reason: string }
  | { kind: 'failed'; space: SpaceRuntime; peer: string }

function callNews(news: CallNews): void {
  window.dispatchEvent(new CustomEvent<CallNews>('nook:call', { detail: news }))
}

export class SpaceRuntime {
  readonly secret: string
  readonly locked: boolean
  readonly password: string
  readonly server: string
  readonly selfId = newPeerId()

  room!: Room
  chat!: RoomChat
  channel!: Channel
  bus!: SignalBus
  mesh!: Mesh
  voice!: Voice
  call: CallState | null = null
  ringing: Ringing | null = null
  note: RoomNote | null = null
  readonly ready: Promise<void>
  readonly presence = new Map<string, Envelope>()
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

  private ice: { iceServers: RTCIceServer[]; relayOnly: boolean } = { iceServers: [], relayOnly: false }
  private ringTimer = 0
  private voiceWas: string | null = null
  private stopped = false
  private rememberQueue: Promise<void> = Promise.resolve()

  constructor(open: OpenSpace) {
    this.secret = open.secret
    this.locked = open.locked
    this.password = open.password
    this.server = open.server
    runningSpaces.add(this)
    this.ready = this.start(open)
  }

  private get book() {
    return bookFor(this.server)
  }

  private async start(open: OpenSpace): Promise<void> {
    this.room = await deriveRoom(this.secret, this.password)
    this.note = await this.book.get(this.room.id)
    // First, so the space is on your list even if the tab closes at once.
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
    channel.onLeft = (session) =>
      this.bus.deliver({ v: 1, id: `left:${session}:${Date.now()}`, from: session, t: Date.now(), type: 'bye' })
    channel.onRefused = (why) => console.warn(`[nook] the server would not keep a write: ${why}`)
    this.channel = channel

    const bus = new SignalBus(this.room, this.selfId, [channel])
    const mesh = new Mesh(bus, this.selfId, identity.name)
    mesh.extra = () => ({
      key: identity.pubkey,
      away: document.hidden ? true : undefined,
      voice: this.voice?.state.channel ?? undefined,
      muted: this.voice?.state.channel && this.voice.state.muted ? true : undefined,
      deafened: this.voice?.state.channel && this.voice.state.deafened ? true : undefined,
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

    void fetchIce(this.server).then((ice) => (this.ice = ice))
    const voice = new Voice(bus, this.selfId, () => rtcConfig(this.ice.iceServers, this.ice.relayOnly))
    voice.admit = (peer, channel) => !isCallChannel(channel) || (!!this.call && this.keyOf(peer) === this.call.with)
    voice.onArrival = (arrived, peer) => {
      if (arrived) chirpJoin()
      else chirpLeave()
      this.callArrival(arrived, peer)
    }
    voice.onFailed = (peer) => callNews({ kind: 'failed', space: this, peer })
    voice.volumeOf = (peer) => heardAt(this.keyOf(peer))
    voice.onChange = () => {
      const { channel: now, muted, deafened } = voice.state
      const said = `${now}:${muted}:${deafened}`
      if (said !== this.voiceWas) {
        this.voiceWas = said
        mesh.announce()
      }
      this.emit('voice')
      callNews({ kind: 'changed', space: this })
    }
    this.voice = voice
    bus.start()
    mesh.start()
    document.addEventListener('visibilitychange', this.onVisible)

    await Promise.race([channel.loaded, new Promise((r) => window.setTimeout(r, HISTORY_WAIT_MS))])
    if (this.stopped) return
    void chat.readDirect()

    if (open.fresh && !chat.founder) {
      await chat.claimFounder()
      await this.remember({ founder: chat.me })
      if (open.name) await chat.setSpaceName(open.name)
    }
    // Announcing no picture before the record arrives would erase the known one.
    await chat.announceName(chat.displayName, this.pictureToAnnounce())
    window.addEventListener(PREFS_CHANGED, this.onPrefs)
    this.emit('changed')
  }

  private readonly onPrefs = (ev: Event): void => {
    const which = (ev as CustomEvent<string[]>).detail ?? []
    if (!which.includes('nook.avatar.v1') && !which.includes('nook.name.v1')) return
    const name = loadIdentity().name
    this.mesh?.setName(name)
    void this.chat.announceName(name, this.pictureToAnnounce())
    this.emit('changed')
  }

  private pictureToAnnounce(): string | undefined {
    if (!avatarKnown()) return undefined
    const saidAt = this.chat.log.lastProfileAt(this.chat.me)
    if (saidAt <= avatarSavedAt()) return loadAvatar()
    adoptAvatar(this.chat.avatarOf(this.chat.me), saidAt)
    return undefined
  }

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
        console.error('[nook]', err)
      }
    }
  }

  on<K extends keyof SpaceRuntime['listeners']>(
    what: K,
    fn: SpaceRuntime['listeners'][K] extends Set<infer F> ? F : never,
  ): () => void {
    const set = this.listeners[what] as Set<typeof fn>
    set.add(fn)
    return () => set.delete(fn)
  }

  announce(): void {
    this.mesh?.announce()
  }

  unread(): { count: number; mentions: number; direct: number } {
    if (!this.chat) return { count: 0, mentions: 0, direct: 0 }
    let count = 0
    let mentions = 0
    for (const u of this.chat.unread(this.note?.read ?? {}).values()) {
      count += u.count
      mentions += u.mentions
    }
    const direct = this.chat.directs().reduce((sum, d) => sum + d.unread, 0)
    return { count, mentions, direct }
  }

  remember(patch: NotePatch): Promise<void> {
    const own: NotePatch = {
      ...patch,
      read: patch.read ? { ...patch.read } : undefined,
      readDm: patch.readDm ? { ...patch.readDm } : undefined,
    }
    this.rememberQueue = this.rememberQueue.then(() => this.rememberNow(own)).catch(() => undefined)
    return this.rememberQueue
  }

  private async rememberNow(patch: NotePatch): Promise<void> {
    if (!this.room || this.stopped) return
    const existing = this.note
    const next: RoomNote = {
      room: this.room.id,
      secret: this.secret,
      server: this.server,
      lastSeen: Date.now(),
      // An empty name means not heard yet, and must not overwrite a known one.
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
    if (existing && Date.now() - existing.lastSeen < LAST_SEEN_REFRESH_MS && plain(existing) === plain(next)) return
    await this.book.put(next)
  }

  // Call from a click: it opens the microphone.
  async joinVoice(channel: string): Promise<void> {
    if (this.voice.state.channel === channel) return
    for (const other of runningSpaces) if (other !== this && other.voice?.state.channel) other.leaveVoice()
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

  // Call from a click: it opens the microphone.
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
    }, RING_TIMEOUT_MS)
    callNews({ kind: 'changed', space: this })
  }

  // Call from a click: it opens the microphone.
  async answer(): Promise<void> {
    const ring = this.ringing
    if (!ring) return
    this.clearRinging()
    this.call = {
      id: ring.id,
      channel: `call-${ring.id}`,
      with: ring.from,
      outgoing: false,
      live: false,
      since: Date.now(),
    }
    try {
      await this.joinVoice(this.call.channel)
    } catch (err) {
      this.call = null
      void this.bus.send({ type: 'ring-no', to: ring.session, data: { call: ring.id } })
      throw err
    }
    if (this.otherIsIn(this.call)) {
      this.call.live = true
      this.call.since = Date.now()
    }
    callNews({ kind: 'changed', space: this })
  }

  private otherIsIn(call: CallState): boolean {
    return this.voice.membersOf(call.channel).some((id) => id !== this.selfId && this.keyOf(id) === call.with)
  }

  decline(): void {
    const ring = this.ringing
    if (!ring) return
    this.clearRinging()
    void this.bus.send({ type: 'ring-no', to: ring.session, data: { call: ring.id } })
  }

  endCall(reason = ''): void {
    const call = this.call
    if (!call) return
    this.call = null
    window.clearTimeout(this.ringTimer)
    if (call.outgoing && !call.live) {
      for (const session of this.sessionsOf(call.with)) {
        void this.bus?.send({ type: 'ring-stop', to: session, data: { call: call.id } })
      }
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
        // Trust a ring only when its claimed key is the sender's own presence key.
        const by = typeof data.by === 'string' ? data.by : ''
        if (!by || this.keyOf(env.from) !== by) return
        if (this.call || this.ringing || this.voice.state.channel) {
          void this.bus.send({ type: 'ring-busy', to: env.from, data: { call: id } })
          return
        }
        this.ringing = { id, from: by, session: env.from }
        this.ringTimer = window.setTimeout(() => {
          if (this.ringing?.id === id) this.clearRinging()
        }, RING_TIMEOUT_MS)
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
    runningSpaces.delete(this)
    window.removeEventListener(PREFS_CHANGED, this.onPrefs)
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

export function filesFor(space: SpaceRuntime): SpaceFiles {
  let held = fileStores.get(space)
  if (!held) {
    held = new SpaceFiles(space.server, space.room.id, space.room.write, () => space.channel?.serving ?? space.server)
    fileStores.set(space, held)
  }
  return held
}
