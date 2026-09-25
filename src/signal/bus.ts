import type { Room } from '../room'
import { buildEnvelope, open, ReplayGuard, seal, type Envelope, type OutgoingEnvelope } from './envelope'
import type { Transport, TransportStatus } from './transport'

export interface RelayHealth {
  name: string
  status: TransportStatus
  detail?: string
}

export class SignalBus {
  onMessage: ((env: Envelope) => void) | null = null
  onHealth: ((health: RelayHealth[]) => void) | null = null

  private readonly transports: Transport[]
  private readonly room: Room
  private readonly selfId: string
  private readonly guard = new ReplayGuard()
  private started = false
  private readonly health = new Map<Transport, RelayHealth>()

  constructor(room: Room, selfId: string, transports: Transport[]) {
    this.room = room
    this.selfId = selfId
    this.transports = [...transports]
    for (const t of this.transports) this.health.set(t, { name: t.name, status: 'idle' })
  }

  /** For a message made here rather than received, such as a server saying somebody left. */
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
    t.connect({
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
    if (!env) return
    if (env.from === this.selfId) return
    if (env.to && env.to !== this.selfId) return
    if (!this.guard.accept(env.id)) return
    this.onMessage?.(env)
  }
}
