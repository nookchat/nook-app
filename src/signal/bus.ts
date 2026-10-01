import { tagged, untag, type SpaceKeys } from '../space/keys'
import { loadIdentity, sign, verify } from '../store/identity'
import { buildEnvelope, open, ReplayGuard, seal, signedDigest, type Envelope, type OutgoingEnvelope } from './envelope'
import type { Transport, TransportStatus } from './transport'

export interface RelayHealth {
  name: string
  status: TransportStatus
  detail?: string
}

/** Sessions whose key is remembered: far more than ever share a space at once. */
const MAX_SESSIONS = 5000

export class SignalBus {
  onMessage: ((env: Envelope) => void) | null = null
  onHealth: ((health: RelayHealth[]) => void) | null = null

  private readonly transports: Transport[]
  private readonly keys: SpaceKeys
  private readonly selfId: string
  private readonly guard = new ReplayGuard()
  /**
   * The key each session signed with. A session that signed once always signs, with that key: a
   * message in its name signed by anybody else, or unsigned, is somebody pretending to be it.
   */
  private readonly signers = new Map<string, string>()
  private readonly room: string
  private started = false
  private readonly health = new Map<Transport, RelayHealth>()
  /**
   * Messages are opened at once but handled in the order they came. A "left" that overtook
   * the last announce of the same session would have it back, standing where it was, for good.
   */
  private inOrder: Promise<void> = Promise.resolve()

  constructor(keys: SpaceKeys, selfId: string, transports: Transport[], room = '') {
    this.keys = keys
    this.selfId = selfId
    this.room = room
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
        // A signal under a key this device does not hold is not for it. After a ban, one under
        // a key from before it came from somebody with only the old code.
        const { tag, wire: sealed } = untag(wire)
        const key = this.keys.signalKey(tag)
        if (!key || !this.keys.hears(tag)) return
        const opened = open(key, sealed)
        this.after(async () => this.receive(await this.checked(await opened)))
      },
      onStatus: (transport, status, detail) => {
        this.health.set(transport, { name: transport.name, status, detail })
        this.onHealth?.(this.healthList)
      },
    })
  }

  async send(msg: OutgoingEnvelope): Promise<void> {
    const env = buildEnvelope(this.selfId, msg)
    env.k = loadIdentity().pubkey
    env.s = sign(await signedDigest(this.room, env))
    const { tag, key } = this.keys.writing
    const wire = tagged(tag, await seal(key, env))
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

  /**
   * Who signed it, checked. A bad signature is dropped. So is one in the name of a session that
   * signed with another key, or that signed before and now sends nothing. Unsigned, from a page
   * from before signatures, it still counts, but names no key: it is nobody in particular.
   */
  private async checked(env: Envelope | null): Promise<Envelope | null> {
    if (!env) return null
    let signer = ''
    if (env.s !== undefined || env.k !== undefined) {
      if (typeof env.k !== 'string' || typeof env.s !== 'string') return null
      if (!verify(await signedDigest(this.room, env), env.s, env.k)) return null
      signer = env.k
    }
    const bound = this.signers.get(env.from)
    if (bound !== undefined && bound !== signer) return null
    if (signer && bound === undefined) {
      if (this.signers.size >= MAX_SESSIONS) this.signers.delete(this.signers.keys().next().value as string)
      this.signers.set(env.from, signer)
    }
    env.signer = signer
    // The key an announce names is the one that signed it, or none.
    if (env.type === 'announce' && env.data && typeof env.data === 'object') {
      const data = { ...(env.data as Record<string, unknown>) }
      if (signer) data.key = signer
      else delete data.key
      env.data = data
    }
    return env
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
