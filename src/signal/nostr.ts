/**
 * A Nostr relay as a signal transport.
 *
 * Why Nostr as well as MQTT: relays run on port 443 with plain WSS, which
 * almost no network blocks. The MQTT test brokers use port 8084 and 8884, and a
 * strict office firewall drops those.
 *
 * We publish ephemeral events (kind 20000 to 29999). A relay passes those to
 * live subscribers and stores nothing, which is exactly what a handshake needs.
 * Each page session makes a throwaway key pair, so nothing links two sessions.
 */

import { schnorr } from '@noble/curves/secp256k1'
import { backoffDelay, type Transport, type TransportEvents, type TransportStatus } from './transport'

const EVENT_KIND = 20666
const QUEUE_LIMIT = 60
const QUEUE_TTL_MS = 20_000

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16)
  return out
}

interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

/** One throwaway identity for the whole page session. */
class SessionKey {
  readonly priv: Uint8Array
  readonly pub: string

  constructor() {
    this.priv = schnorr.utils.randomSecretKey()
    this.pub = toHex(schnorr.getPublicKey(this.priv))
  }
}

let sessionKey: SessionKey | null = null

function keys(): SessionKey {
  if (!sessionKey) sessionKey = new SessionKey()
  return sessionKey
}

async function signEvent(topic: string, content: string): Promise<NostrEvent> {
  const k = keys()
  const created_at = Math.floor(Date.now() / 1000)
  const tags = [['t', topic]]
  const serialized = JSON.stringify([0, k.pub, created_at, EVENT_KIND, tags, content])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
  const id = toHex(new Uint8Array(digest))
  const sig = toHex(schnorr.sign(fromHex(id), k.priv))
  return { id, pubkey: k.pub, created_at, kind: EVENT_KIND, tags, content, sig }
}

export class NostrTransport implements Transport {
  readonly name: string
  status: TransportStatus = 'idle'
  ready = false

  private readonly url: string
  private ws: WebSocket | null = null
  private topic = ''
  private subId = ''
  private events: TransportEvents | null = null
  private retryTimer: number | null = null
  private attempt = 0
  private rejects = 0
  private closedByUser = false
  private outbox: { wire: string; expires: number }[] = []

  constructor(url: string, name: string) {
    this.url = url
    this.name = name
  }

  connect(topic: string, events: TransportEvents): void {
    this.topic = `beam-${topic}`
    this.subId = 'b' + Math.random().toString(36).slice(2, 10)
    this.events = events
    this.closedByUser = false
    this.dial()
  }

  publish(wire: string): void {
    if (!this.ready) {
      this.queue(wire)
      return
    }
    void this.sendEvent(wire)
  }

  close(): void {
    this.closedByUser = true
    this.outbox = []
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(['CLOSE', this.subId]))
      } catch {
        /* the socket is going away anyway */
      }
    }
    this.teardown()
    this.setStatus('idle')
  }

  // ---- internals ----

  private setStatus(status: TransportStatus, detail?: string): void {
    this.status = status
    this.ready = status === 'open'
    this.events?.onStatus(this, status, detail)
  }

  private queue(wire: string): void {
    const now = Date.now()
    this.outbox = this.outbox.filter((m) => m.expires > now)
    if (this.outbox.length >= QUEUE_LIMIT) this.outbox.shift()
    this.outbox.push({ wire, expires: now + QUEUE_TTL_MS })
  }

  private flush(): void {
    const now = Date.now()
    const pending = this.outbox.filter((m) => m.expires > now)
    this.outbox = []
    for (const m of pending) void this.sendEvent(m.wire)
  }

  private dial(): void {
    if (this.closedByUser) return
    this.teardown()
    this.setStatus(this.attempt === 0 ? 'connecting' : 'retrying')

    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (err) {
      this.retry(String(err))
      return
    }
    this.ws = ws

    ws.onopen = () => {
      const since = Math.floor(Date.now() / 1000) - 30
      ws.send(
        JSON.stringify([
          'REQ',
          this.subId,
          { kinds: [EVENT_KIND], '#t': [this.topic], since },
        ]),
      )
      this.attempt = 0
      this.rejects = 0
      this.setStatus('open')
      this.flush()
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      this.handle(ev.data)
    }

    ws.onerror = () => {
      // The close handler runs next and owns the retry.
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.retry('The relay closed the connection.')
    }
  }

  private handle(raw: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') return

    switch (msg[0]) {
      case 'EVENT': {
        const ev = msg[2] as NostrEvent | undefined
        if (!ev || ev.kind !== EVENT_KIND || typeof ev.content !== 'string') return
        // The relay already checked the signature. The envelope layer does the
        // real trust work, because only the room key can open the content.
        this.events?.onWire(ev.content)
        return
      }
      case 'CLOSED': {
        // The relay refused our filter. Another relay can still carry the room.
        this.setStatus('failed', String(msg[2] ?? 'The relay refused the subscription.'))
        return
      }
      case 'OK': {
        if (msg[2] === false) {
          this.rejects += 1
          if (this.rejects >= 3) {
            this.setStatus('failed', String(msg[3] ?? 'The relay refused our events.'))
          }
        }
        return
      }
      default:
        return
    }
  }

  private async sendEvent(wire: string): Promise<void> {
    try {
      const ev = await signEvent(this.topic, wire)
      if (this.ws?.readyState !== WebSocket.OPEN) {
        this.queue(wire)
        return
      }
      this.ws.send(JSON.stringify(['EVENT', ev]))
    } catch {
      this.queue(wire)
    }
  }

  private retry(detail: string): void {
    this.teardown()
    if (this.closedByUser) return
    this.attempt += 1
    this.setStatus(this.attempt > 6 ? 'failed' : 'retrying', detail)
    this.retryTimer = window.setTimeout(() => this.dial(), backoffDelay(this.attempt))
  }

  private teardown(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    this.retryTimer = null
    const ws = this.ws
    this.ws = null
    this.ready = false
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close()
      } catch {
        /* already gone */
      }
    }
  }
}

/** Open relays that accept anonymous ephemeral events. */
export const NOSTR_RELAYS: { url: string; name: string }[] = [
  { url: 'wss://relay.damus.io', name: 'damus' },
  { url: 'wss://nos.lol', name: 'nos.lol' },
  { url: 'wss://relay.nostr.band', name: 'nostr.band' },
]
