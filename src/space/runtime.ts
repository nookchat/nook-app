import { fetchIce, serverTag } from '../backend'
import { Channel, connectionTo } from '../net/connection'
import { SpaceFiles } from '../net/files'
import { Mesh } from '../net/mesh'
import { LISTENING_CHANGED, listeningNow, listeningWire } from '../net/listening'
import { PLAYING_CHANGED, playingNow } from '../net/playing'
import { loadStatus, STATUS_CHANGED } from '../store/status'
import { pushAbout } from '../net/push'
import { Voice } from '../net/voice'
import { heardAt } from '../net/volume'
import { deriveRoom, newPeerId, takePass, type Room } from '../room'
import { rtcConfig } from '../rtc/config'
import { KeyKeeper, SpaceKeys } from './keys'
import { channelMuted } from '../store/mute'
import { SignalBus } from '../signal/bus'
import type { Envelope } from '../signal/envelope'
import { loadIdentity } from '../store/identity'
import { cleanChannel, passProof, type LogEvent } from '../store/log'
import type { RoomNote } from '../store/notes'
import { PREFS_CHANGED } from '../store/prefs'
import { RoomChat } from '../store/room-chat'
import { bookFor, stable } from '../store/server-spaces'
import { adoptAvatar, avatarKnown, avatarSavedAt, loadAvatar } from '../ui/avatar'
import { chirpDeafen, chirpHangup, chirpJoin, chirpLeave, chirpMute } from '../ui/sounds'

const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000
const HISTORY_WAIT_MS = 6000
/** How long a join waits for the server's relays. Past this it joins without them. */
const ICE_WAIT_MS = 5000
const RING_TIMEOUT_MS = 30_000
/** After a reconnect, how long the others get to say hello before the silent ones count as gone. */
const EVERYONE_WAIT_MS = 25_000
const STILL_HERE_MS = 60_000
/**
 * Everybody says they are here each minute. Somebody not heard for three has gone, even if the
 * server never said so, as an old one may not: its list of who is here is the better answer.
 */
const SILENT_GONE_MS = 3 * STILL_HERE_MS

type NotePatch = Partial<{
  founder: string
  name: string
  read: Record<string, number>
  readDm: Record<string, number>
  closed: boolean
  pass: string
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
  keys!: SpaceKeys
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
  /** The server's relays have arrived, or never will. */
  private iceReady: Promise<void> = Promise.resolve()
  private ringTimer = 0
  private voiceWas: string | null = null
  private stillHere = 0
  /** When the minute's check last ran. A page that slept has heard nobody, and drops nobody for it. */
  private lastLook = 0
  private stopped = false
  private keeper: KeyKeeper | null = null
  private keyQueue: Promise<void> = Promise.resolve()
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
    this.keys = new SpaceKeys(this.room.key)
    this.note = await this.book.get(this.room.id)
    // First, so the space is on your list even if the tab closes at once.
    await this.remember({})

    const identity = loadIdentity()
    const chat = new RoomChat(this.room.id, this.note?.founder ?? '')
    chat.onChange = () => {
      this.emit('changed')
      this.keysChanged()
    }
    chat.onDirect = () => this.emit('changed')
    chat.onFounder = (pubkey) => void this.remember({ founder: pubkey })
    chat.setDirectRead({ ...(this.note?.readDm ?? {}) })
    this.chat = chat

    const channel = new Channel(connectionTo(this.server), this.room, serverTag(this.server), this.keys)
    channel.onEvents = (events) => void this.take(events)
    channel.onLeft = (session) => this.drop(session, 'left')
    channel.onHere = (ids, up) => void this.checkHere(ids, up, Date.now())
    // The others reconnect too after a server restart, some later than us, so they get a while to say hello.
    channel.onEveryone = (since) => window.setTimeout(() => void this.dropSilent(since), EVERYONE_WAIT_MS)
    channel.onRefused = (why) => console.warn(`[nook] the server would not keep a write: ${why}`)
    this.channel = channel

    const bus = new SignalBus(this.keys, this.selfId, [channel])
    const mesh = new Mesh(bus, this.selfId, identity.name)
    mesh.extra = () => ({
      key: identity.pubkey,
      away: document.hidden ? true : undefined,
      status: loadStatus().mode === 'online' ? undefined : loadStatus().mode,
      statusText: loadStatus().text || undefined,
      voice: this.voice?.state.channel ?? undefined,
      muted: this.voice?.state.channel && this.voice.state.muted ? true : undefined,
      deafened: this.voice?.state.channel && this.voice.state.deafened ? true : undefined,
      camera: this.voice?.state.channel && this.voice.cameraOn ? true : undefined,
      // How long, not since when: the clocks of two devices differ.
      voiceFor: this.voice?.state.channel ? Math.max(0, Date.now() - this.voice.state.since) : undefined,
      playing: playingNow()?.name,
      steam: playingNow()?.steam,
      playingFor: playingNow() ? Math.max(0, Date.now() - playingNow()!.since) : undefined,
      listening: listeningNow() ? listeningWire(listeningNow()!) : undefined,
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
    chat.onLocal = (event) => {
      void channel.put([event])
      pushAbout(this, event)
    }
    this.bus = bus
    this.mesh = mesh
    // What we say about ourselves is sealed with the key in use, so a new one says it again.
    this.keys.changed.add(this.announceAgain)

    this.iceReady = fetchIce(this.server).then((ice) => {
      this.ice = ice
    })
    const voice = new Voice(bus, this.selfId, () => rtcConfig(this.ice.iceServers, this.ice.relayOnly))
    voice.admit = (peer, channel) =>
      isCallChannel(channel) ? !!this.call && this.keyOf(peer) === this.call.with : this.chat.mayEnter(this.keyOf(peer), channel, true)
    voice.onArrival = (arrived, peer) => {
      if (arrived) chirpJoin()
      else chirpLeave()
      this.callArrival(arrived, peer)
    }
    voice.onFailed = (peer) => callNews({ kind: 'failed', space: this, peer })
    voice.volumeOf = (peer) => heardAt(this.keyOf(peer))
    voice.onChange = () => {
      const { channel: now, muted, deafened } = voice.state
      const said = `${now}:${muted}:${deafened}:${voice.cameraOn}`
      // Your own mute and deafen, in the same channel: each has its sound, as Discord's do.
      const was = this.voiceWas?.split(':')
      if (was && now && was[0] === now) {
        if (String(deafened) !== was[2]) chirpDeafen(deafened)
        else if (String(muted) !== was[1]) chirpMute(muted)
      }
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
    document.addEventListener('visibilitychange', this.announceAgain)
    window.addEventListener(PLAYING_CHANGED, this.announceAgain)
    window.addEventListener(LISTENING_CHANGED, this.announceAgain)
    window.addEventListener(STATUS_CHANGED, this.announceAgain)
    // Now and then, so anybody who counted us gone by mistake after a reconnect has us back.
    this.lastLook = Date.now()
    this.stillHere = window.setInterval(this.lookAround, STILL_HERE_MS)

    await Promise.race([channel.loaded, new Promise((r) => window.setTimeout(r, HISTORY_WAIT_MS))])
    if (this.stopped) return
    // Only once the history is in: a device part way through it could think a key is missing.
    void channel.loaded.then(() => {
      if (this.stopped) return
      this.keeper = new KeyKeeper(this.keys, chat.log, chat.me, (body) => chat.passKey(body))
      this.keysChanged()
    })
    void chat.readDirect()
    void this.showPass()

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

  /** Sessions not heard from since a hello went out left while we could not hear it. */
  private async dropSilent(since: number): Promise<void> {
    await this.bus?.settled()
    if (this.stopped) return
    for (const peer of this.mesh?.peers() ?? []) {
      // A call with sound going both ways is proof enough that they are there.
      if (peer.lastSeen >= since || this.voice?.inCallWith(peer.id)) continue
      this.drop(peer.id, 'gone')
    }
  }

  /**
   * The server's list of who is here is the truth: a session it does not hold has gone, even if
   * its "left" never came. Just after the server starts, the others are still on their way back.
   */
  private async checkHere(ids: Set<string>, up: number, at: number): Promise<void> {
    await this.bus?.settled()
    if (this.stopped || up < EVERYONE_WAIT_MS) return
    for (const peer of this.mesh?.peers() ?? []) {
      // Heard after the list was made, or in a call with sound going both ways: here.
      if (ids.has(peer.id) || peer.lastSeen > at || this.voice?.inCallWith(peer.id)) continue
      this.drop(peer.id, 'not-here')
    }
  }

  /**
   * Each minute: say we are here, ask the server who else is, and let go of the long silent.
   * Everybody here says so each minute, so three silent minutes is gone even when the server
   * still lists them: an old server can keep a session that left. A mistake comes back with
   * their next announce.
   */
  private readonly lookAround = (): void => {
    this.mesh.announce()
    this.channel.askWho()
    const now = Date.now()
    const slept = now - this.lastLook > 2 * STILL_HERE_MS
    this.lastLook = now
    if (slept) return
    for (const peer of this.mesh.peers()) {
      if (now - peer.lastSeen < SILENT_GONE_MS || this.voice?.inCallWith(peer.id)) continue
      this.drop(peer.id, 'silent')
    }
  }

  /** As if the session had said goodbye: off the list of people, out of voice, its calls closed. */
  private drop(session: string, why: string): void {
    this.bus?.deliver({ v: 1, id: `${why}:${session}:${Date.now()}`, from: session, t: Date.now(), type: 'bye' })
  }

  private readonly announceAgain = (): void => {
    this.mesh.announce()
  }

  /** Opens any new copy of a space key, then sees whether one needs making or passing on. */
  private keysChanged(): void {
    this.keyQueue = this.keyQueue
      .then(() => this.keys.learn(this.chat.log, this.chat.me))
      .then(() => this.keys.learnHooks(this.chat.log.hooks().map((hook) => hook.key)))
      .then(() => this.keys.hearOnly(this.chat.log.keysSinceBan()))
      .then(() => this.keeper?.consider())
      .catch((err) => console.warn('[nook] a space key did not open', err))
  }

  /** The space has a newer key than this device holds, and nobody has given it a copy. */
  waitingForKey(): boolean {
    const newest = this.chat?.log.keyEpochs().at(-1)
    return !!newest && !this.keys.has(newest.id) && !this.chat.log.authority().isKicked(this.chat.me)
  }

  /**
   * Came in with an invite made after a ban: show its pass, bound to our own key, so somebody
   * in the space gives us the key. Once is enough.
   */
  private async showPass(): Promise<void> {
    const pass = takePass(this.secret) || this.note?.pass || ''
    if (!pass) return
    if (pass !== this.note?.pass) await this.remember({ pass })
    await this.channel.loaded
    if (this.stopped) return
    const proof = await passProof(pass, this.chat.me)
    if (this.chat.log.joins().get(this.chat.me)?.includes(proof)) return
    await this.chat.showPass(proof)
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

  /** What waits in this space. A channel or space you muted adds nothing; direct messages always count. */
  unread(): { count: number; mentions: number; direct: number } {
    if (!this.chat) return { count: 0, mentions: 0, direct: 0 }
    let count = 0
    let mentions = 0
    for (const [channel, u] of this.chat.unread(this.note?.read ?? {})) {
      if (this.room && channelMuted(this.room.id, channel)) continue
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
      // Until the log has the space's name it has not been heard, so the last known picture stays.
      picture: (this.chat?.spaceName() ? this.chat.spacePicture() : existing?.picture) || undefined,
      locked: this.locked,
      password: this.password || existing?.password || undefined,
      closed: patch.closed || existing?.closed || undefined,
      pass: patch.pass || existing?.pass || undefined,
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
    await this.relays()
    await this.voice.join(channel)
    chirpJoin()
  }

  /**
   * Waits for the server's relays, which the calls need to get through most home
   * routers, and which a relay-only server needs so no call goes round them. A
   * click comes long after they arrive; a join right after the page loads does not.
   */
  private relays(): Promise<void> {
    return Promise.race([this.iceReady, new Promise<void>((done) => window.setTimeout(done, ICE_WAIT_MS))])
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
      if (call.live) chirpHangup()
      else chirpLeave()
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
    this.keeper?.stop()
    this.keys?.changed.delete(this.announceAgain)
    this.endCall()
    this.voice?.dispose()
    document.removeEventListener('visibilitychange', this.announceAgain)
    window.removeEventListener(PLAYING_CHANGED, this.announceAgain)
    window.removeEventListener(LISTENING_CHANGED, this.announceAgain)
    window.removeEventListener(STATUS_CHANGED, this.announceAgain)
    window.clearInterval(this.stillHere)
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
