/**
 * Your own archive as a signal relay.
 *
 * The public brokers and Nostr relays are other people's machines: free,
 * plentiful, and occasionally all having a bad night at once. A space that
 * already trusts one machine with its sealed history can lean on the same
 * machine to carry its sealed handshakes, and then the public relays are the
 * spares rather than the whole roster.
 *
 * The far end is forty lines in server.mjs: every text frame is handed,
 * unread, to every other socket standing in the same room. What travels is
 * the same sealed envelope every transport carries, and the room id in the
 * path is the same topic the public relays already see, so the archive
 * learns nothing they do not.
 */

import { backoffDelay, type Transport, type TransportEvents, type TransportStatus } from './transport'

/** Held for a relay that is between dials, then let go. */
const QUEUE_LIMIT = 60
const QUEUE_TTL_MS = 20_000

export class WsRelayTransport implements Transport {
  readonly name: string
  status: TransportStatus = 'idle'
  ready = false

  /** The archive's http(s) address, as the settings hold it. */
  private readonly base: string
  private ws: WebSocket | null = null
  private topic = ''
  private events: TransportEvents | null = null
  private retryTimer: number | null = null
  private attempt = 0
  private closedByUser = false
  private outbox: { wire: string; expires: number }[] = []

  constructor(base: string, name = 'your archive') {
    this.base = base
    this.name = name
  }

  connect(topic: string, events: TransportEvents): void {
    this.topic = topic
    this.events = events
    this.closedByUser = false
    this.dial()
  }

  publish(wire: string): void {
    if (!this.ready || !this.ws) {
      this.queue(wire)
      return
    }
    try {
      this.ws.send(wire)
    } catch {
      this.queue(wire)
    }
  }

  close(): void {
    this.closedByUser = true
    this.outbox = []
    this.teardown()
    this.setStatus('idle')
  }

  // ---- internals ----

  /** The ws address, worked out from the http one the settings hold. */
  private address(): string {
    const url = new URL(this.base)
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/relay/${this.topic}`
    url.search = ''
    return url.toString()
  }

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
    for (const m of pending) this.publish(m.wire)
  }

  private dial(): void {
    if (this.closedByUser) return
    this.teardown()
    this.setStatus(this.attempt === 0 ? 'connecting' : 'retrying')

    let ws: WebSocket
    try {
      ws = new WebSocket(this.address())
    } catch (err) {
      this.retry(String(err))
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      this.setStatus('open')
      this.flush()
    }
    ws.onmessage = (ev) => {
      // Nothing to parse: a frame is a sealed envelope, whole.
      if (typeof ev.data === 'string') this.events?.onWire(ev.data)
    }
    ws.onerror = () => {
      // The close handler runs next and owns the retry.
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.retry('The archive closed the connection.')
    }
  }

  private retry(detail: string): void {
    if (this.closedByUser) return
    this.teardown()
    this.setStatus('retrying', detail)
    this.retryTimer = window.setTimeout(() => this.dial(), backoffDelay(this.attempt++))
  }

  private teardown(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        /* it was already gone */
      }
    }
    this.ready = false
  }
}
