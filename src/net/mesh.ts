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

  private readonly links = new Map<string, Link>()
  private readonly seen = new Map<string, { name: string; key: string; at: number }>()
  private timers: number[] = []
  private stopped = false

  constructor(bus: SignalBus, selfId: string, name: string) {
    this.bus = bus
    this.selfId = selfId
    this.myName = name
  }

  start(): void {
    this.announce()
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
      .filter(([, v]) => now - v.at < PRESENCE_TTL_MS)
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

  broadcast(raw: string): void {
    for (const link of this.links.values()) link.send(raw)
  }

  sendTo(peerId: string, raw: string): void {
    this.links.get(peerId)?.send(raw)
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
    void this.bus.send({ type: 'announce', data: { name: this.myName, ...(this.extra?.() ?? {}) } })
  }

  /** The space owns the bus and hands us what is ours. */
  async handle(env: Envelope): Promise<void> {
    if (this.stopped) return
    const data = (env.data ?? {}) as Record<string, unknown>

    switch (env.type) {
      case 'announce': {
        const name = typeof data.name === 'string' ? data.name.slice(0, 24) : ''
        const key = typeof data.key === 'string' && /^[0-9a-f]{64}$/.test(data.key) ? data.key : ''
        const known = this.seen.get(env.from)
        this.seen.set(env.from, {
          name: name || known?.name || '',
          key: key || known?.key || '',
          at: Date.now(),
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
        this.considerDial(env.from)
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
        if (held && !held.canAnswer()) {
          held.close()
          this.links.delete(env.from)
        }
        const link = this.link(env.from, false)
        await link.onOffer(data as unknown as RTCSessionDescriptionInit)
        return
      }
      case 'manswer': {
        await this.links.get(env.from)?.onAnswer(data as unknown as RTCSessionDescriptionInit)
        return
      }
      case 'mice': {
        await this.links.get(env.from)?.onIce(data as unknown as RTCIceCandidateInit)
        return
      }
      default:
        return
    }
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
    if (existing) return existing
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
