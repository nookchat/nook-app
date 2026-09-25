import type { SignalBus } from '../signal/bus'
import type { Envelope } from '../signal/envelope'

export interface MeshPeer {
  id: string
  /** The public key that signs their messages: the person, across sessions. */
  key: string
  name: string
  lastSeen: number
}

export class Mesh {
  onData: ((from: string, raw: string) => void) | null = null
  onPeers: (() => void) | null = null
  extra: (() => Record<string, unknown>) | null = null

  private readonly bus: SignalBus
  private readonly selfId: string
  private myName: string
  private readonly seen = new Map<string, { name: string; key: string; at: number }>()
  private roster: readonly MeshPeer[] | null = null
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

  peers(): readonly MeshPeer[] {
    this.roster ??= [...this.seen.entries()]
      .map(([id, v]) => ({ id, key: v.key, name: v.name, lastSeen: v.at }))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    return this.roster
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
    this.roster = null
  }

  announce(): void {
    if (this.stopped) return
    void this.bus.send({ type: 'announce', data: { name: this.myName, ...(this.extra?.() ?? {}) } })
  }

  handle(env: Envelope): void {
    if (this.stopped) return
    const data = (env.data ?? {}) as Record<string, unknown>
    switch (env.type) {
      case 'announce': {
        const name = typeof data.name === 'string' ? data.name.slice(0, 24) : ''
        const key = typeof data.key === 'string' && /^[0-9a-f]{64}$/.test(data.key) ? data.key : ''
        const known = this.seen.get(env.from)
        this.seen.set(env.from, { name: name || known?.name || '', key: key || known?.key || '', at: Date.now() })
        this.roster = null
        if (!known || known.name !== name) this.onPeers?.()
        return
      }
      case 'bye': {
        if (!this.seen.delete(env.from)) return
        this.roster = null
        this.onPeers?.()
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
