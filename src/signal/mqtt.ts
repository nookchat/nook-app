/**
 * A very small MQTT 3.1.1 client over WebSocket.
 *
 * Beam needs publish and subscribe on one topic, at quality of service 0, with
 * no retained messages and no authentication. That is about 150 lines of packet
 * work, so we write it here instead of pulling in a library that needs Node
 * polyfills in the browser.
 *
 * Public test brokers accept anonymous clients. We use two of them on two
 * different ports.
 */

import { backoffDelay, type Transport, type TransportEvents, type TransportStatus } from './transport'

const enc = new TextEncoder()
const dec = new TextDecoder()

const CONNECT = 1
const CONNACK = 2
const PUBLISH = 3
const SUBSCRIBE = 8
const SUBACK = 9
const PINGREQ = 12
const PINGRESP = 13
const DISCONNECT = 14

/**
 * A hidden tab has its timers throttled to about once a minute, so a short
 * keepalive would let the broker drop a host that is simply in the background.
 * Four minutes of tolerance with a ping every fifty seconds survives that.
 */
const KEEPALIVE_SEC = 240
const PING_EVERY_MS = 50_000
const QUEUE_LIMIT = 60
const QUEUE_TTL_MS = 20_000

class Writer {
  private bytes: number[] = []

  u8(n: number): void {
    this.bytes.push(n & 0xff)
  }

  u16(n: number): void {
    this.bytes.push((n >> 8) & 0xff, n & 0xff)
  }

  str(s: string): void {
    const b = enc.encode(s)
    this.u16(b.length)
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i])
  }

  raw(b: Uint8Array): void {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i])
  }

  done(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

function frame(type: number, flags: number, payload: Uint8Array): Uint8Array {
  const head: number[] = [((type << 4) | flags) & 0xff]
  let n = payload.length
  do {
    let b = n % 128
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    head.push(b)
  } while (n > 0)
  const out = new Uint8Array(head.length + payload.length)
  out.set(head, 0)
  out.set(payload, head.length)
  return out
}

type RemainingLength = { value: number; size: number } | 'need-more' | 'bad'

function readRemainingLength(buf: Uint8Array, start: number): RemainingLength {
  let multiplier = 1
  let value = 0
  for (let n = 0; n < 4; n++) {
    const i = start + n
    if (i >= buf.length) return 'need-more'
    const b = buf[i]
    value += (b & 127) * multiplier
    multiplier *= 128
    if ((b & 128) === 0) return { value, size: n + 1 }
  }
  return 'bad'
}

export class MqttTransport implements Transport {
  readonly name: string
  status: TransportStatus = 'idle'
  ready = false

  private readonly url: string
  private ws: WebSocket | null = null
  private topic = ''
  private events: TransportEvents | null = null
  private buffer = new Uint8Array(0)
  private pingTimer: number | null = null
  private retryTimer: number | null = null
  private attempt = 0
  private closedByUser = false
  private outbox: { wire: string; expires: number }[] = []
  private packetId = 1

  constructor(url: string, name: string) {
    this.url = url
    this.name = name
  }

  connect(topic: string, events: TransportEvents): void {
    this.topic = `beam/v1/${topic}`
    this.events = events
    this.closedByUser = false
    this.dial()
  }

  publish(wire: string): void {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue(wire)
      return
    }
    this.sendPublish(wire)
  }

  close(): void {
    this.closedByUser = true
    this.clearTimers()
    this.outbox = []
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(frame(DISCONNECT, 0, new Uint8Array(0)))
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
    for (const m of pending) this.sendPublish(m.wire)
  }

  private dial(): void {
    if (this.closedByUser) return
    this.teardown()
    this.setStatus(this.attempt === 0 ? 'connecting' : 'retrying')

    let ws: WebSocket
    try {
      ws = new WebSocket(this.url, 'mqtt')
    } catch (err) {
      this.retry(String(err))
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.buffer = new Uint8Array(0)
      const w = new Writer()
      w.str('MQTT')
      w.u8(4) // protocol level 3.1.1
      w.u8(0x02) // clean session, no will, no auth
      w.u16(KEEPALIVE_SEC)
      w.str('beam-' + Math.random().toString(36).slice(2, 12)) // stay under 23 characters
      ws.send(frame(CONNECT, 0, w.done()))
    }

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return
      this.feed(new Uint8Array(ev.data))
    }

    ws.onerror = () => {
      // The close handler runs next and owns the retry.
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.retry('The broker closed the connection.')
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
    this.clearTimers()
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

  private clearTimers(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer)
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    this.pingTimer = null
    this.retryTimer = null
  }

  private feed(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer, 0)
    merged.set(chunk, this.buffer.length)
    this.buffer = merged

    for (;;) {
      if (this.buffer.length < 2) return
      const len = readRemainingLength(this.buffer, 1)
      if (len === 'need-more') return
      if (len === 'bad') {
        this.retry('The broker sent a malformed packet.')
        return
      }
      const total = 1 + len.size + len.value
      if (this.buffer.length < total) return
      const packet = this.buffer.subarray(0, total)
      this.buffer = this.buffer.slice(total)
      this.handle(packet[0] >> 4, packet.subarray(1 + len.size))
    }
  }

  private handle(type: number, body: Uint8Array): void {
    switch (type) {
      case CONNACK: {
        if (body.length < 2 || body[1] !== 0) {
          this.retry(`The broker refused the connection (code ${body[1] ?? '?'}).`)
          return
        }
        this.attempt = 0
        this.sendSubscribe()
        return
      }
      case SUBACK: {
        const granted = body[body.length - 1]
        if (granted === 0x80) {
          this.retry('The broker refused the topic.')
          return
        }
        this.setStatus('open')
        this.pingTimer = window.setInterval(() => this.sendPing(), PING_EVERY_MS)
        this.flush()
        return
      }
      case PUBLISH: {
        if (body.length < 2) return
        const topicLen = (body[0] << 8) | body[1]
        const payload = body.subarray(2 + topicLen)
        if (payload.length === 0) return
        this.events?.onWire(dec.decode(payload))
        return
      }
      case PINGRESP:
      default:
        return
    }
  }

  private sendSubscribe(): void {
    const w = new Writer()
    w.u16(this.nextPacketId())
    w.str(this.topic)
    w.u8(0) // quality of service 0
    this.ws?.send(frame(SUBSCRIBE, 0x02, w.done()))
  }

  private sendPublish(wire: string): void {
    const w = new Writer()
    w.str(this.topic)
    w.raw(enc.encode(wire))
    try {
      this.ws?.send(frame(PUBLISH, 0, w.done()))
    } catch {
      this.queue(wire)
    }
  }

  private sendPing(): void {
    try {
      this.ws?.send(frame(PINGREQ, 0, new Uint8Array(0)))
    } catch {
      /* the close handler owns the retry */
    }
  }

  private nextPacketId(): number {
    this.packetId = (this.packetId % 65535) + 1
    return this.packetId
  }
}

/** Public anonymous brokers, on two different ports. */
export const MQTT_BROKERS: { url: string; name: string }[] = [
  { url: 'wss://broker.emqx.io:8084/mqtt', name: 'EMQX' },
  { url: 'wss://broker.hivemq.com:8884/mqtt', name: 'HiveMQ' },
]
