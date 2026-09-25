import { fromBase64Url, toBase64Url } from '../bytes'

// Wire format: base64url(12 byte IV || AES-GCM ciphertext of the JSON envelope).

const enc = new TextEncoder()
const dec = new TextDecoder()

const IV_BYTES = 12
const GCM_TAG_BYTES = 16
const MIN_SEALED_BYTES = IV_BYTES + GCM_TAG_BYTES + 1

export type MsgType =
  | 'announce' // host to everyone: the room is live
  | 'hello' // viewer to host: let me in
  | 'offer' // host to viewer
  | 'answer' // viewer to host
  | 'ice' // both ways
  | 'bye' // either side leaves
  | 'deny' // host refused the viewer, or the room is full
  | 'ping' // viewer keep alive, so the host can drop dead entries
  | 'moffer' // mesh handshake
  | 'manswer'
  | 'mice'
  | 'voffer' // voice channel handshake
  | 'vanswer'
  | 'vice'
  | 'vmove' // an admin moving somebody between voice channels
  | 'mdata' // a mesh line carried by the relay
  | 'ring' // a call between two people: ringing them
  | 'ring-no' // declined
  | 'ring-busy' // already on a call
  | 'ring-stop' // the caller gave up

export interface Envelope {
  v: 1
  id: string
  from: string
  /** Absent means broadcast to the room. */
  to?: string
  /** The sender's clock, so information only: never checked against ours. */
  t: number
  type: MsgType
  data?: unknown
}

export type OutgoingEnvelope = Pick<Envelope, 'type'> & Partial<Pick<Envelope, 'to' | 'data'>>

const GUARD_TTL_MS = 120_000

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function buildEnvelope(from: string, msg: OutgoingEnvelope): Envelope {
  const env: Envelope = { v: 1, id: randomId(), from, t: Date.now(), type: msg.type }
  if (msg.to) env.to = msg.to
  if (msg.data !== undefined) env.data = msg.data
  return env
}

export async function seal(key: CryptoKey, env: Envelope): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(env))),
  )
  const wire = new Uint8Array(iv.length + ct.length)
  wire.set(iv, 0)
  wire.set(ct, iv.length)
  return toBase64Url(wire)
}

/** Null for anything that cannot be trusted. Never throws. */
export async function open(key: CryptoKey, wire: string): Promise<Envelope | null> {
  try {
    if (wire.length < 20 || wire.length > 400_000) return null
    const bytes = fromBase64Url(wire)
    if (bytes.length < MIN_SEALED_BYTES) return null
    const iv = bytes.subarray(0, IV_BYTES)
    const ct = bytes.subarray(IV_BYTES)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    const env = JSON.parse(dec.decode(plain)) as Envelope
    if (env?.v !== 1 || typeof env.id !== 'string' || typeof env.from !== 'string') return null
    if (typeof env.type !== 'string') return null
    return env
  } catch {
    return null
  }
}

export class ReplayGuard {
  private readonly seen = new Map<string, number>()

  accept(id: string): boolean {
    const now = Date.now()
    if (this.seen.size > 500) this.prune(now)
    if (this.seen.has(id)) return false
    this.seen.set(id, now + GUARD_TTL_MS)
    return true
  }

  private prune(now: number): void {
    for (const [id, expiry] of this.seen) {
      if (expiry < now) this.seen.delete(id)
    }
  }
}
