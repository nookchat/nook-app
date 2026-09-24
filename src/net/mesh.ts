/**
 * The chat mesh.
 *
 * Until now one person was the hub: viewers connected to whoever was sharing,
 * and when they stopped, the room stopped existing. A place people come back to
 * cannot work that way, so there is no hub any more. Everybody in a space
 * connects to everybody else, and chat gossips across those links.
 *
 * Two rules keep it simple:
 *
 *   Who offers   The peer with the smaller id offers, always. That is a total
 *                order both sides can compute, so there is never a moment where
 *                both offer at once and neither call survives.
 *   No changes   The data channel is created before the first offer and never
 *                touched again, so a mesh link negotiates exactly once. Video
 *                gets its own connections rather than renegotiating these.
 *
 * Chat is kilobytes. A mesh that would collapse under video is free for text.
 *
 * A space on a server keeps the same shape and swaps what a link is made of.
 * Every link is a relay link: a line for one peer, or for everybody, goes to
 * the server's WebSocket inside the same sealed envelope the handshakes use,
 * and the server hands it to whoever is in the room. There is no data channel
 * to negotiate, so a link is up the moment the peer is heard from, and a
 * network that blocks peer to peer blocks nothing here.
 */

import { rtcConfig } from '../rtc/config'
import type { SignalBus } from '../signal/bus'
import type { Envelope } from '../signal/envelope'

/** How often to say we are here. */
const ANNOUNCE_MS = 4000
/** Silence for this long and a peer is treated as gone. */
const PRESENCE_TTL_MS = 16_000
/** How long to wait before trying a link that never came up again. */
const REDIAL_MS = 12_000

export interface MeshPeer {
  /** This session's id. Random, and gone the moment the tab closes. */
  id: string
  /**
   * Who this actually is: the public key that signs their messages.
   *
   * The session id is not a person. Leave and come back and you are a new one,
   * which is why the same person used to appear twice in the list, and why the
   * copy that had not said anything yet had nothing to show but a key.
   */
  key: string
  name: string
  /** True once the data channel is open and can carry a line. */
  ready: boolean
  lastSeen: number
}

export class Mesh {
  /** Called with a raw payload and who sent it. */
  onData: ((from: string, raw: string) => void) | null = null
  /** Called whenever the roster changes. */
  onPeers: (() => void) | null = null
  /**
   * Called the moment a link can carry something, with who is on the far end.
   *
   * This is when history is exchanged. Without it a space only ever carries
   * what is said while everybody is already looking at it: your name, the name
   * of the space, who runs it and every message written before the channel
   * opened all stayed on the device that wrote them.
   */
  onReady: ((peerId: string) => void) | null = null
  /**
   * Anything else to say in every announcement, such as what this person is
   * sharing and which voice channel they are standing in.
   *
   * It has to ride the same message. When these were sent separately, the
   * periodic announcement carried only the name and quietly overwrote the
   * presence the other one had just set.
   */
  extra: (() => Record<string, unknown>) | null = null

  private readonly bus: SignalBus
  private readonly selfId: string
  private myName: string
  /** True for a space on a server: every link goes through its relay. */
  private readonly relayed: boolean

  private readonly links = new Map<string, Link | RelayLink>()
  private readonly seen = new Map<
    string,
    { name: string; key: string; at: number; relay: boolean }
  >()
  private timers: number[] = []
  private stopped = false

  constructor(bus: SignalBus, selfId: string, name: string, relayed = false) {
    this.bus = bus
    this.selfId = selfId
    this.myName = name
    this.relayed = relayed
  }

  start(): void {
    this.announce()
    /*
     * On a server, nothing on a timer. The server holds what each session
     * last said about itself, hands it to whoever arrives, and says when a
     * session goes, so presence is sent when it changes and at no other time.
     * Peer to peer there is nobody to hold it, and it has to be repeated.
     */
    if (this.relayed) return
    this.timers.push(window.setInterval(() => this.announce(), ANNOUNCE_MS))
    this.timers.push(window.setInterval(() => this.sweep(), 4000))
  }

  setName(name: string): void {
    this.myName = name
  }

  /** Everyone currently believed present, whether or not the link is up. */
  peers(): MeshPeer[] {
    const now = Date.now()
    return [...this.seen.entries()]
      // On a server a session is here until the server says it has gone.
      .filter(([, v]) => this.relayed || now - v.at < PRESENCE_TTL_MS)
      .map(([id, v]) => ({
        id,
        key: v.key,
        name: v.name,
        ready: this.links.get(id)?.ready === true,
        lastSeen: v.at,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  /** How many people can actually receive a line right now, including us. */
  get reach(): number {
    return 1 + [...this.links.values()].filter((l) => l.ready).length
  }

  /**
   * One line to everybody. A relay link does not send its own copy: one
   * envelope with no address reaches every socket in the room at once.
   */
  broadcast(raw: string): void {
    let relay = false
    for (const link of this.links.values()) {
      if (link instanceof RelayLink) relay = true
      else link.send(raw)
    }
    // On a server it goes out even to nobody yet: somebody who is still on
    // the way in, and has not been heard from, is on the relay already.
    if (relay || this.relayed) this.relayAll(raw)
  }

  /**
   * Pass on a line that came from somebody else, so it reaches people they
   * are not linked to.
   *
   * A line that came over the relay has already reached everybody else on
   * it, so it goes on only down the data channels. Sending it round the relay
   * again would cost every one of N people another N copies of every line.
   */
  forward(from: string, raw: string): void {
    // On a server everything comes by relay, linked yet or not.
    const cameByRelay = this.relayed || this.links.get(from) instanceof RelayLink
    let relay = false
    for (const [id, link] of this.links) {
      if (id === from) continue
      if (link instanceof RelayLink) relay = true
      else link.send(raw)
    }
    if ((relay || this.relayed) && !cameByRelay) this.relayAll(raw)
  }

  sendTo(peerId: string, raw: string): void {
    this.links.get(peerId)?.send(raw)
  }

  private relayAll(raw: string): void {
    void this.bus.send({ type: 'mdata', data: raw }).catch(() => undefined)
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) window.clearInterval(t)
    this.timers = []
    void this.bus.send({ type: 'bye' }).catch(() => undefined)
    for (const link of this.links.values()) link.close()
    this.links.clear()
    this.seen.clear()
  }

  // ---- internals ----

  /** Say we are here, now. */
  announce(): void {
    const data: Record<string, unknown> = { name: this.myName, ...(this.extra?.() ?? {}) }
    // Said so a peer that is not on a server links to us the same way.
    if (this.relayed) data.relay = true
    void this.bus.send({ type: 'announce', data })
  }

  /** The space owns the bus and hands us what is ours. */
  async handle(env: Envelope): Promise<void> {
    if (this.stopped) return
    const data = (env.data ?? {}) as Record<string, unknown>

    switch (env.type) {
      case 'announce': {
        const name = typeof data.name === 'string' ? data.name.slice(0, 24) : ''
        const key = typeof data.key === 'string' && /^[0-9a-f]{64}$/.test(data.key) ? data.key : ''
        /*
         * A session carrying our own key is another tab of ours, or the one we
         * just reloaded out of. It is still linked and still synced with, since
         * two tabs hold two copies of the log in memory and only one of them
         * has what was just typed. It is not another person, and the roster
         * folds it into one row: see SpaceView.roster.
         */
        const known = this.seen.get(env.from)
        const relay = this.relayed || data.relay === true
        this.seen.set(env.from, {
          name: name || known?.name || '',
          key: key || known?.key || '',
          at: Date.now(),
          relay,
        })
        /*
         * Somebody who has just come back has a new session id and the same
         * key. Drop the session they left behind rather than waiting for it to
         * time out, or they stand in the list twice for a quarter of a minute.
         */
        if (key) {
          for (const [id, entry] of this.seen) {
            if (id !== env.from && entry.key === key) {
              this.seen.delete(id)
              this.links.get(id)?.close()
              this.links.delete(id)
            }
          }
        }
        if (!known) this.onPeers?.()
        else if (known.name !== name && name) this.onPeers?.()
        if (relay) this.relayTo(env.from)
        else this.considerDial(env.from)
        return
      }
      case 'mdata': {
        /*
         * A line over the relay. Taken only from a peer we link to that way:
         * a peer on a data channel whose relay copy also reaches us would
         * otherwise be heard twice, and a sound played twice is not the same
         * sound.
         */
        if (typeof env.data !== 'string') return
        if (env.from === this.selfId) return
        if (!(this.links.get(env.from) instanceof RelayLink)) {
          /*
           * On a server, from anybody. What they send first is their history,
           * and it can easily beat their announcement here: dropping it until
           * they had been heard from lost whatever it carried for good.
           */
          if (this.relayed) {
            this.onData?.(env.from, env.data)
            return
          }
          if (!this.seen.get(env.from)?.relay) return
          this.relayTo(env.from)
        }
        this.onData?.(env.from, env.data)
        return
      }
      case 'bye': {
        if (this.seen.delete(env.from)) this.onPeers?.()
        this.links.get(env.from)?.close()
        this.links.delete(env.from)
        return
      }
      case 'moffer': {
        /*
         * They offered, so we answer. This only happens when their id is
         * smaller, because the smaller id is the one that calls.
         *
         * A fresh offer replaces whatever we were holding. Only the calling
         * side gives up on a link that will not come up and tries again, so
         * this side used to sit on the dead one for ever, and every retry they
         * made was handed to a connection that could no longer answer: their
         * side kept dialling, our side kept dropping it on the floor, and the
         * two of them never spoke again. An offer is the caller starting over,
         * so we start over with them.
         */
        const held = this.links.get(env.from)
        // A peer on the relay is never called. See relayTo.
        if (held instanceof RelayLink) return
        if (held && !held.canAnswer()) {
          held.close()
          this.links.delete(env.from)
        }
        const link = this.link(env.from, false)
        await link.onOffer(data as unknown as RTCSessionDescriptionInit)
        return
      }
      case 'manswer': {
        const link = this.links.get(env.from)
        if (link instanceof Link) await link.onAnswer(data as unknown as RTCSessionDescriptionInit)
        return
      }
      case 'mice': {
        const link = this.links.get(env.from)
        if (link instanceof Link) await link.onIce(data as unknown as RTCIceCandidateInit)
        return
      }
      default:
        return
    }
  }

  /**
   * Link to a peer through the relay, which both sides do on hearing from the
   * other. There is nothing to negotiate, so there is nobody who has to call
   * first, and the link is ready as soon as it exists.
   */
  private relayTo(peerId: string): void {
    if (peerId === this.selfId) return
    const existing = this.links.get(peerId)
    if (existing instanceof RelayLink) return
    existing?.close()
    const link = new RelayLink((raw) =>
      void this.bus.send({ type: 'mdata', to: peerId, data: raw }).catch(() => undefined),
    )
    this.links.set(peerId, link)
    this.onPeers?.()
    this.onReady?.(peerId)
  }

  /** Offer only to peers whose id sorts after ours, so exactly one side calls. */
  private considerDial(peerId: string): void {
    if (peerId === this.selfId) return
    if (this.selfId >= peerId) return
    const existing = this.links.get(peerId)
    if (existing && !existing.stale()) return
    /*
     * Take the dead one out of the map, not just out of service.
     *
     * Closing it was not enough: link() below returns whatever is already
     * filed under this peer, so a closed link was handed straight back and
     * dial() returned at once because it knew it was closed. One failed
     * attempt therefore ended the relationship permanently. Every announce
     * after it looked like a retry and was a no-op, which is why two people
     * who missed each other the first time never connected again however long
     * they waited.
     */
    if (existing) {
      existing.close()
      this.links.delete(peerId)
    }
    const link = this.link(peerId, true)
    void link.dial()
  }

  private link(peerId: string, weOffer: boolean): Link {
    const existing = this.links.get(peerId)
    if (existing instanceof Link) return existing
    existing?.close()
    const link = new Link(peerId, weOffer, {
      send: (type, data) => void this.bus.send({ type, to: peerId, data }),
      onData: (raw) => this.onData?.(peerId, raw),
      onChange: () => this.onPeers?.(),
      onReady: () => this.onReady?.(peerId),
    })
    this.links.set(peerId, link)
    return link
  }

  private sweep(): void {
    const now = Date.now()
    let changed = false
    for (const [id, entry] of this.seen) {
      if (now - entry.at > PRESENCE_TTL_MS) {
        this.seen.delete(id)
        this.links.get(id)?.close()
        this.links.delete(id)
        changed = true
      }
    }
    /*
     * A link that never came up gets another go, in case an offer went missing.
     * Both sides drop it now. The caller redials, and the answering side simply
     * stops holding a corpse that would swallow the next offer.
     */
    for (const [id, link] of this.links) {
      if (link.stale()) {
        link.close()
        this.links.delete(id)
        changed = true
      }
    }
    if (changed) this.onPeers?.()
  }
}

interface LinkHooks {
  send: (type: 'moffer' | 'manswer' | 'mice', data: unknown) => void
  onData: (raw: string) => void
  onChange: () => void
  /** Fired once, when this link first becomes able to carry something. */
  onReady: () => void
}

/**
 * A link that is only a way to address one peer on the relay.
 *
 * Ready from the start and never stale: whether the peer is still there is
 * the presence sweep's question, answered by their announcements, exactly as
 * it is for a data channel.
 */
class RelayLink {
  ready = true
  private closed = false
  private readonly deliver: (raw: string) => void

  constructor(deliver: (raw: string) => void) {
    this.deliver = deliver
  }

  stale(): boolean {
    return false
  }

  send(raw: string): void {
    if (!this.closed) this.deliver(raw)
  }

  close(): void {
    this.closed = true
    this.ready = false
  }
}

/** One connection to one peer, carrying chat and nothing else. */
class Link {
  ready = false

  private readonly pc: RTCPeerConnection
  private readonly hooks: LinkHooks
  private channel: RTCDataChannel | null = null
  private pending: RTCIceCandidateInit[] = []
  private hasRemote = false
  private closed = false
  private readonly startedAt = Date.now()

  constructor(_peerId: string, weOffer: boolean, hooks: LinkHooks) {
    this.hooks = hooks
    this.pc = new RTCPeerConnection(rtcConfig())

    if (weOffer) {
      this.attach(this.pc.createDataChannel('chat', { ordered: true }))
    } else {
      this.pc.ondatachannel = (ev) => {
        if (ev.channel.label === 'chat') this.attach(ev.channel)
      }
    }

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) hooks.send('mice', ev.candidate.toJSON())
    }
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this.close()
      hooks.onChange()
    }
  }

  /** True when this link has had long enough and still is not carrying anything. */
  stale(): boolean {
    return !this.ready && Date.now() - this.startedAt > REDIAL_MS
  }

  /**
   * Whether a newly arrived offer can still be applied to this connection.
   *
   * Only a connection that has not been given a remote description yet, and is
   * not already carrying anything, can take one. Anything else is a leftover
   * from an attempt that failed and has to be thrown away first.
   */
  canAnswer(): boolean {
    if (this.closed || this.ready) return false
    return this.pc.signalingState === 'stable' && !this.hasRemote
  }

  async dial(): Promise<void> {
    if (this.closed) return
    try {
      const offer = await this.pc.createOffer()
      await this.pc.setLocalDescription(offer)
      this.hooks.send('moffer', { sdp: this.pc.localDescription?.sdp, type: 'offer' })
    } catch {
      this.close()
    }
  }

  async onOffer(desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) return
    try {
      await this.pc.setRemoteDescription(desc)
      this.hasRemote = true
      await this.drain()
      const answer = await this.pc.createAnswer()
      await this.pc.setLocalDescription(answer)
      this.hooks.send('manswer', { sdp: this.pc.localDescription?.sdp, type: 'answer' })
    } catch {
      this.close()
    }
  }

  async onAnswer(desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed || this.pc.signalingState !== 'have-local-offer') return
    try {
      await this.pc.setRemoteDescription(desc)
      this.hasRemote = true
      await this.drain()
    } catch {
      this.close()
    }
  }

  async onIce(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.closed) return
    if (!this.hasRemote) {
      this.pending.push(candidate)
      return
    }
    await this.pc.addIceCandidate(candidate).catch(() => undefined)
  }

  send(raw: string): void {
    if (this.channel?.readyState !== 'open') return
    try {
      this.channel.send(raw)
    } catch {
      /* the channel went away between the check and the send */
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.ready = false
    this.pc.onicecandidate = null
    this.pc.onconnectionstatechange = null
    this.pc.ondatachannel = null
    try {
      this.pc.close()
    } catch {
      /* already closed */
    }
  }

  private attach(channel: RTCDataChannel): void {
    this.channel = channel
    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.hooks.onData(ev.data)
    }
    // Announced once, however many ways the channel reports itself open.
    const opened = (): void => {
      if (this.ready) return
      this.ready = true
      this.hooks.onChange()
      this.hooks.onReady()
    }
    channel.onopen = opened
    channel.onclose = () => {
      this.ready = false
      this.hooks.onChange()
    }
    if (channel.readyState === 'open') opened()
  }

  private async drain(): Promise<void> {
    for (const candidate of this.pending.splice(0)) {
      await this.pc.addIceCandidate(candidate).catch(() => undefined)
    }
  }
}
