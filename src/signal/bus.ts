/**
 * The signal bus fans one message out over every transport and de-duplicates
 * what comes back. One relay is enough to run the room. The rest are spare.
 *
 * After two peers connect, WebRTC carries the media directly and the bus goes
 * quiet. The host keeps it open only so that new viewers can arrive.
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
import { MQTT_BROKERS, MqttTransport } from './mqtt'
import { NOSTR_RELAYS, NostrTransport } from './nostr'
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

  constructor(room: Room, selfId: string) {
    this.room = room
    this.selfId = selfId
    this.transports = [
      ...MQTT_BROKERS.map((b) => new MqttTransport(b.url, b.name)),
      ...NOSTR_RELAYS.map((r) => new NostrTransport(r.url, r.name)),
    ]
    for (const t of this.transports) this.health.set(t, { name: t.name, status: 'idle' })
  }

  /** True when at least one relay can carry a message right now. */
  get connected(): boolean {
    return this.transports.some((t) => t.ready)
  }

  get healthList(): RelayHealth[] {
    return this.transports.map((t) => this.health.get(t)!)
  }

  start(): void {
    if (this.started) return
    this.started = true
    for (const t of this.transports) {
      t.connect(this.room.id, {
        onWire: (wire) => void this.receive(wire),
        onStatus: (transport, status, detail) => {
          this.health.set(transport, { name: transport.name, status, detail })
          this.onHealth?.(this.healthList)
        },
      })
    }
  }

  async send(msg: OutgoingEnvelope): Promise<void> {
    const env = buildEnvelope(this.selfId, msg)
    const wire = await seal(this.room.key, env)
    for (const t of this.transports) t.publish(wire)
  }

  stop(): void {
    this.started = false
    for (const t of this.transports) t.close()
  }

  private async receive(wire: string): Promise<void> {
    const env = await open(this.room.key, wire)
    if (!env) return // Not ours, or replayed, or corrupted. Drop it quietly.
    if (env.from === this.selfId) return // Our own message, echoed by the relay.
    if (env.to && env.to !== this.selfId) return // Addressed to a different peer.
    if (!this.guard.accept(env.id)) return // The other relay already delivered it.
    this.onMessage?.(env)
  }
}
