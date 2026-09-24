/**
 * Who is in a space, and the small things said to them that are not kept.
 *
 * Presence is held by the server: each session says who it is and what it is
 * doing when that changes (see Channel.publishState), the server hands the
 * latest of everybody's to whoever arrives, and says when a session goes.
 * Nothing is on a timer. This keeps the roster those messages add up to.
 *
 * Beside it, lines to one person or to everybody that are true for a moment
 * and then not: somebody typing, a sound from the soundboard, a line read
 * aloud. They go over the same connection, sealed like everything else, and
 * are never kept. What is kept (every message, edit and reaction) goes to the
 * server as an event instead; see RoomChat.
 */

import type { SignalBus } from '../signal/bus'
import type { Envelope } from '../signal/envelope'

export interface MeshPeer {
  /** This session's id. Random, and gone the moment the tab closes. */
  id: string
  /**
   * Who this actually is: the public key that signs their messages. The
   * session id is not a person: leave and come back and you are a new one.
   */
  key: string
  name: string
  /** Always true: a session the server says is here can be reached. */
  ready: boolean
  lastSeen: number
}

export class Mesh {
  /** Called with a raw payload and who sent it. */
  onData: ((from: string, raw: string) => void) | null = null
  /** Called whenever the roster changes. */
  onPeers: (() => void) | null = null
  /**
   * Anything else to say about this session: what it is sharing, which voice
   * channel it is in, whether its tab is on screen. Said with the name, in
   * one message, whenever any of it changes.
   */
  extra: (() => Record<string, unknown>) | null = null

  private readonly bus: SignalBus
  private readonly selfId: string
  private myName: string
  private readonly seen = new Map<string, { name: string; key: string; at: number }>()
  private stopped = false

  constructor(bus: SignalBus, selfId: string, name: string) {
    this.bus = bus
    this.selfId = selfId
    this.myName = name
  }

  start(): void {
    this.announce()
  }

  setName(name: string): void {
    this.myName = name
    this.announce()
  }

  /** Everyone the server says is here. */
  peers(): MeshPeer[] {
    return [...this.seen.entries()]
      .map(([id, v]) => ({ id, key: v.key, name: v.name, ready: true, lastSeen: v.at }))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  /** How many people can receive a line right now, including us. */
  get reach(): number {
    return 1 + this.seen.size
  }

  broadcast(raw: string): void {
    void this.bus.send({ type: 'mdata', data: raw }).catch(() => undefined)
  }

  sendTo(peerId: string, raw: string): void {
    void this.bus.send({ type: 'mdata', to: peerId, data: raw }).catch(() => undefined)
  }

  stop(): void {
    this.stopped = true
    void this.bus.send({ type: 'bye' }).catch(() => undefined)
    this.seen.clear()
  }

  /** Say who this is, now. The server keeps it and hands it on. */
  announce(): void {
    if (this.stopped) return
    void this.bus.send({ type: 'announce', data: { name: this.myName, ...(this.extra?.() ?? {}) } })
  }

  /** The space owns the bus and hands us what is ours. */
  handle(env: Envelope): void {
    if (this.stopped) return
    const data = (env.data ?? {}) as Record<string, unknown>
    switch (env.type) {
      case 'announce': {
        const name = typeof data.name === 'string' ? data.name.slice(0, 24) : ''
        const key = typeof data.key === 'string' && /^[0-9a-f]{64}$/.test(data.key) ? data.key : ''
        const known = this.seen.get(env.from)
        this.seen.set(env.from, { name: name || known?.name || '', key: key || known?.key || '', at: Date.now() })
        // A session that reloaded is gone on the server's word (left), so a
        // key standing twice here is two tabs, and the roster folds them.
        if (!known || known.name !== name) this.onPeers?.()
        return
      }
      case 'bye': {
        if (this.seen.delete(env.from)) this.onPeers?.()
        return
      }
      case 'mdata': {
        if (typeof env.data !== 'string' || env.from === this.selfId) return
        this.onData?.(env.from, env.data)
        return
      }
      default:
        return
    }
  }
}
