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
  id: string
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

  private readonly bus: SignalBus
  private readonly selfId: string
  private myName: string

  private readonly links = new Map<string, Link>()
  private readonly seen = new Map<string, { name: string; at: number }>()
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

  private announce(): void {
    void this.bus.send({ type: 'announce', data: { name: this.myName } })
  }

  /** The space owns the bus and hands us what is ours. */
  async handle(env: Envelope): Promise<void> {
    if (this.stopped) return
    const data = (env.data ?? {}) as Record<string, unknown>

    switch (env.type) {
      case 'announce': {
        const name = typeof data.name === 'string' ? data.name.slice(0, 24) : ''
        const known = this.seen.get(env.from)
        this.seen.set(env.from, { name: name || known?.name || '', at: Date.now() })
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
        // They offered, so we answer. This only happens when their id is smaller.
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
    existing?.close()
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
    // A link that never came up gets another go, in case an offer went missing.
    for (const [id, link] of this.links) {
      if (link.stale() && this.selfId < id) {
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
    channel.onopen = () => {
      this.ready = true
      this.hooks.onChange()
    }
    channel.onclose = () => {
      this.ready = false
      this.hooks.onChange()
    }
    if (channel.readyState === 'open') {
      this.ready = true
      this.hooks.onChange()
    }
  }

  private async drain(): Promise<void> {
    for (const candidate of this.pending.splice(0)) {
      await this.pc.addIceCandidate(candidate).catch(() => undefined)
    }
  }
}
