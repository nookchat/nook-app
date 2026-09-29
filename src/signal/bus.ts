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
  /**
   * Messages are opened at once but handled in the order they came. A "left" that overtook
   * the last announce of the same session would have it back, standing where it was, for good.
   */
  private inOrder: Promise<void> = Promise.resolve()

  constructor(room: Room, selfId: string, transports: Transport[]) {
    this.room = room
    this.selfId = selfId
    this.transports = [...transports]
    for (const t of this.transports) this.health.set(t, { name: t.name, status: 'idle' })
  }

  /** For a message made here rather than received, such as a server saying somebody left. */
  deliver(env: Envelope): void {
    if (env.from === this.selfId) return
    this.after(() => this.onMessage?.(env))
  }

  private after(work: () => void | Promise<void>): void {
    this.inOrder = this.inOrder.then(work).catch((err) => console.error('[nook]', err))
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
      onWire: (wire) => {
        const opened = open(this.room.key, wire)
        this.after(async () => this.receive(await opened))
      },
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

  /** Once every message that has come in so far has been opened and handled. */
  async settled(): Promise<void> {
    await this.inOrder
  }

  stop(): void {
    this.started = false
    for (const t of this.transports) t.close()
  }

  private receive(env: Envelope | null): void {
    if (!env) return
    if (env.from === this.selfId) return
    if (env.to && env.to !== this.selfId) return
    // The server sends everybody's last announce again after a reconnect, and that
    // says they are still here. Hearing an announce twice changes nothing else.
    if (!this.guard.accept(env.id) && !(env.type === 'announce' && !env.to)) return
    this.onMessage?.(env)
  }
}
