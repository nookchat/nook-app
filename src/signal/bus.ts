/**
 * The signal bus: everything said in a space that is not kept.
 *
 * It seals each message with the space's key, sends it down the space's
 * channel on the server connection, opens what comes back, and drops what
 * it has already seen. Presence, typing, and the handshakes that start calls
 * and screen shares all go this way.
 */

import type { Room } from '../room'
import {
  buildEnvelope,
  open,
  ReplayGuard,
  seal,
  type Envelope,
  type OutgoingEnvelope,
} from './envelope'
import type { Transport, TransportStatus } from './transport'

export interface RelayHealth {
  name: string
  status: TransportStatus
  detail?: string
}

export class SignalBus {
  readonly transports: Transport[]
  onMessage: ((env: Envelope) => void) | null = null
  onHealth: ((health: RelayHealth[]) => void) | null = null

  private readonly room: Room
  private readonly selfId: string
  private readonly guard = new ReplayGuard()
  private started = false
  private health = new Map<Transport, RelayHealth>()

  /**
   * Traffic counters, for the diagnostics on a stuck screen.
   *
   * `unreadable` above zero with `opened` at zero means somebody is talking on
   * this room but our key does not fit. A link cut short by a chat app looks
   * exactly like that.
   */
  opened = 0
  unreadable = 0

  constructor(room: Room, selfId: string, transports: Transport[]) {
    this.room = room
    this.selfId = selfId
    this.transports = [...transports]
    for (const t of this.transports) this.health.set(t, { name: t.name, status: 'idle' })
  }

  /** True when at least one relay can carry a message right now. */
  get connected(): boolean {
    return this.transports.some((t) => t.ready)
  }

  /** A message made here rather than received, such as a server saying somebody left. */
  deliver(env: Envelope): void {
    if (env.from === this.selfId) return
    this.onMessage?.(env)
  }

  get healthList(): RelayHealth[] {
    return this.transports.map((t) => this.health.get(t)!)
  }

  start(): void {
    if (this.started) return
    this.started = true
    for (const t of this.transports) this.open(t)
  }

  private open(t: Transport): void {
    t.connect(this.room.id, {
      onWire: (wire) => void this.receive(wire),
      onStatus: (transport, status, detail) => {
        this.health.set(transport, { name: transport.name, status, detail })
        this.onHealth?.(this.healthList)
      },
    })
  }

  async send(msg: OutgoingEnvelope): Promise<void> {
    const env = buildEnvelope(this.selfId, msg)
    const wire = await seal(this.room.key, env)
    const state = msg.type === 'announce' && !msg.to
    for (const t of this.transports) {
      if (state && t.publishState) t.publishState(wire, this.selfId)
      else t.publish(wire)
    }
  }

  stop(): void {
    this.started = false
    for (const t of this.transports) t.close()
  }

  private async receive(wire: string): Promise<void> {
    const env = await open(this.room.key, wire)
    if (!env) {
      this.unreadable += 1
      return // The key does not fit, or the bytes are damaged.
    }
    this.opened += 1
    if (env.from === this.selfId) return // Our own message, echoed by the relay.
    if (env.to && env.to !== this.selfId) return // Addressed to a different peer.
    if (!this.guard.accept(env.id)) return // The other relay already delivered it.
    this.onMessage?.(env)
  }
}
