/**
 * The signal envelope.
 *
 * Every message that crosses a public relay is one sealed envelope:
 *
 *   base64url( 12 byte random IV || AES-GCM ciphertext of the JSON )
 *
 * A relay operator sees a random topic and opaque bytes. A relay cannot forge a
 * message either, because it does not hold the key.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

export type MsgType =
  | 'announce' // host to everyone: the room is live
  | 'hello' // viewer to host: let me in
  | 'offer' // host to viewer
  | 'answer' // viewer to host
  | 'ice' // both ways
  | 'bye' // either side leaves
  | 'deny' // host refused the viewer, or the room is full
  | 'ping' // viewer keep alive, so the host can drop dead entries
  | 'moffer' // mesh handshake, chat links between every pair
  | 'manswer'
  | 'mice'
  | 'voffer' // voice channel handshake, audio only
  | 'vanswer'
  | 'vice'

export interface Envelope {
  v: 1
  /** Random id, used to drop duplicates that arrive over two relays. */
  id: string
  from: string
  /** Absent means broadcast to the room. */
  to?: string
  /** Milliseconds since epoch. Used for the replay window. */
  t: number
  type: MsgType
  data?: unknown
}

export type OutgoingEnvelope = Pick<Envelope, 'type'> &
  Partial<Pick<Envelope, 'to' | 'data'>>

/**
 * How long a message id stays in the replay guard. This uses the clock of the
 * machine that receives the message, never the clock of the sender.
 *
 * An earlier version also rejected an envelope whose `t` was more than two
 * minutes from the local clock. That broke every room between two machines
 * whose clocks disagreed, which is common, and the symptom was a viewer stuck
 * on "looking for the host". The id guard below already stops a replay, and the
 * room key already stops a forgery, so the sender clock is now information
 * only.
 */
const GUARD_TTL_MS = 120_000

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function buildEnvelope(from: string, msg: OutgoingEnvelope): Envelope {
  const env: Envelope = { v: 1, id: randomId(), from, t: Date.now(), type: msg.type }
  if (msg.to) env.to = msg.to
  if (msg.data !== undefined) env.data = msg.data
  return env
}

export async function seal(key: CryptoKey, env: Envelope): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(env))),
  )
  const wire = new Uint8Array(iv.length + ct.length)
  wire.set(iv, 0)
  wire.set(ct, iv.length)
  return b64urlEncode(wire)
}

/** Returns null for anything we cannot trust. A bad message is never an exception. */
export async function open(key: CryptoKey, wire: string): Promise<Envelope | null> {
  try {
    if (wire.length < 20 || wire.length > 400_000) return null
    const bytes = b64urlDecode(wire)
    if (bytes.length < 29) return null
    const iv = bytes.subarray(0, 12)
    const ct = bytes.subarray(12)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    const env = JSON.parse(dec.decode(plain)) as Envelope
    if (env?.v !== 1 || typeof env.id !== 'string' || typeof env.from !== 'string') return null
    if (typeof env.type !== 'string') return null
    // Deliberately no check against env.t. See the note on GUARD_TTL_MS.
    return env
  } catch {
    return null
  }
}

/**
 * Drops a message id we have already handled. Two relays deliver the same
 * envelope, so this runs on every inbound message.
 */
export class ReplayGuard {
  private seen = new Map<string, number>()

  /** True when the id is new. False when we have seen it inside the window. */
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
