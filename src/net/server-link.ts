/**
 * A space on a server, over one WebSocket.
 *
 * The server is where the space lives. Its history is kept there and only
 * there: this device holds it in memory while the space is open and writes
 * none of it down. Everything goes over this one socket, both ways:
 *
 *   history   read page by page from wherever this device last got to
 *   writes    every event said here, sealed, kept, and acknowledged
 *   live      every event said anywhere else, the moment it is kept
 *   signals   handshakes, presence, typing, and the rest of what is not kept
 *
 * So it is also the signal bus's one transport: SignalBus hands it sealed
 * envelopes and it hands them back, exactly as a public relay would.
 *
 * Every line is sealed with the key made from the space code before it leaves,
 * and every event inside is checked on the way back in, so the server keeps
 * and passes on what it cannot read and cannot forge.
 *
 * The space is on every server of its cluster, so when the one this is
 * talking to goes quiet, the next is tried, and then the next. Each numbers
 * lines its own way, so where this device has read to is kept per server,
 * and a server it has not read from yet is read from the start: what is
 * already here costs a check that finds it is not new.
 */

import type { Room } from '../room'
import { answered, discover, endpoints } from './cluster'
import { openLine, sealEvent } from '../store/archive'
import type { LogEvent } from '../store/log'
import { backoffDelay, type Transport, type TransportEvents, type TransportStatus } from '../signal/transport'

/** Signals held while the socket is down, and for how long. */
const SIGNAL_LIMIT = 120
const SIGNAL_TTL_MS = 20_000
/** A write batch stays well under the frame the server accepts. */
const PUT_BYTES = 600_000

type Incoming =
  | { t: 'page' | 'ev'; at: number; lines: unknown[] }
  | { t: 'live'; at: number }
  | { t: 'ack'; id: string; at: number }
  | { t: 'nack'; id: string; code?: string; message?: string }
  | { t: 'sig'; d: string }
  | { t: 'left'; id: string }

export class ServerLink implements Transport {
  readonly name: string
  status: TransportStatus = 'idle'
  ready = false

  /** Events that arrived, opened but not yet checked. The space checks them. */
  onEvents: ((events: unknown[]) => void) | null = null
  /** A session the server says has gone: its socket closed, or stopped answering. */
  onLeft: ((session: string) => void) | null = null
  /** A write the server refused, with its reason. It will not heal by retrying. */
  onRefused: ((why: string) => void) | null = null
  /** The first time the history has been read to the end. */
  readonly loaded: Promise<void>

  /** How far this device has read on each server, by its own numbers. Memory only. */
  readonly read: Map<string, number>

  /** The space's own server, which names it. */
  private readonly base: string
  /** The server this is talking to now. */
  private current = ''
  /** Failures in a row, to know when to move on to the next server. */
  private failures = 0
  private readonly room: Room
  private ws: WebSocket | null = null
  private events: TransportEvents | null = null
  private retryTimer: number | null = null
  private attempt = 0
  private closed = false
  private signals: { wire: string; expires: number }[] = []
  private state: { d: string; id: string } | null = null
  /** Writes not yet acknowledged, by request id, kept sealed so a resend is byte for byte. */
  private readonly unacked = new Map<string, string[]>()
  private nextId = 0
  private markLoaded: () => void = () => undefined
  /** Opening happens in order, so pages land in the order they were sent. */
  private opening: Promise<void> = Promise.resolve()

  constructor(base: string, room: Room, name: string, read: Map<string, number> = new Map()) {
    this.base = base
    this.room = room
    this.name = name
    this.read = new Map(read)
    this.loaded = new Promise((done) => (this.markLoaded = done))
    // Learn the rest of the cluster now, while the first one answers.
    void discover(base)
  }

  /** Where this device has read to on the server it is talking to. */
  private get at(): number {
    return this.read.get(this.current) ?? 0
  }

  private set at(value: number) {
    this.read.set(this.current, value)
  }

  /** Which server this is talking to, for the status line. */
  get serving(): string {
    return this.current || this.base
  }

  // ---- the transport the signal bus sees ----

  connect(_topic: string, events: TransportEvents): void {
    this.events = events
    this.closed = false
    this.dial()
  }

  publish(wire: string): void {
    if (!this.send({ t: 'sig', d: wire })) {
      const now = Date.now()
      this.signals = this.signals.filter((m) => m.expires > now)
      if (this.signals.length >= SIGNAL_LIMIT) this.signals.shift()
      this.signals.push({ wire, expires: now + SIGNAL_TTL_MS })
    }
  }

  /**
   * Who this is, kept by the server. Sent when it changes and never on a
   * timer: the server hands the latest to whoever arrives, and tells the room
   * the moment this socket goes. Kept here too, to say again on reconnecting.
   */
  publishState(wire: string, session: string): void {
    this.state = { d: wire, id: session }
    this.send({ t: 'state', ...this.state })
  }

  close(): void {
    this.closed = true
    this.signals = []
    this.teardown()
    this.setStatus('idle')
  }

  // ---- the store ----

  /** Keep these events on the server. Queued until it says it has them. */
  async put(events: LogEvent[]): Promise<void> {
    if (events.length === 0) return
    const lines = await Promise.all(events.map((e) => sealEvent(this.room.key, e)))
    let batch: string[] = []
    let size = 0
    const flush = (): void => {
      if (batch.length === 0) return
      const id = `${Date.now().toString(36)}-${++this.nextId}`
      this.unacked.set(id, batch)
      this.send({ t: 'put', id, lines: batch, w: this.room.write })
      batch = []
      size = 0
    }
    for (const line of lines) {
      if (batch.length > 0 && size + line.length > PUT_BYTES) flush()
      batch.push(line)
      size += line.length
    }
    flush()
  }

  /** How many writes are still waiting for the server. Zero is the healthy answer. */
  get pending(): number {
    return this.unacked.size
  }

  // ---- internals ----

  /** The next server to try: the same one until it has failed twice, then the next. */
  private pick(): string {
    const all = endpoints(this.base)
    if (!this.current || !all.includes(this.current)) return all[0]
    if (this.failures < 2) return this.current
    this.failures = 0
    return all[(all.indexOf(this.current) + 1) % all.length]
  }

  private address(base: string): string {
    const url = new URL(base)
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/v1/spaces/${this.room.id}/socket`
    url.search = ''
    return url.toString()
  }

  private send(message: unknown): boolean {
    if (!this.ready || !this.ws) return false
    try {
      this.ws.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private setStatus(status: TransportStatus, detail?: string): void {
    this.status = status
    this.ready = status === 'open'
    this.events?.onStatus(this, status, detail)
  }

  private dial(): void {
    if (this.closed) return
    this.teardown()
    this.setStatus(this.attempt === 0 ? 'connecting' : 'retrying')
    this.current = this.pick()
    let ws: WebSocket
    try {
      ws = new WebSocket(this.address(this.current))
    } catch (err) {
      this.retry(String(err))
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.failures = 0
      answered(this.base, this.current)
      this.setStatus('open')
      // Who this is, then everything since this device last looked, then live.
      if (this.state) this.send({ t: 'state', ...this.state })
      this.send({ t: 'hello', from: this.at })
      // Whatever was written while the socket was down, again, byte for byte.
      // The server keeps one copy of a line it already has.
      for (const [id, lines] of this.unacked) this.send({ t: 'put', id, lines, w: this.room.write })
      const now = Date.now()
      const held = this.signals.filter((m) => m.expires > now)
      this.signals = []
      for (const m of held) this.publish(m.wire)
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let message: Incoming
      try {
        message = JSON.parse(ev.data) as Incoming
      } catch {
        return
      }
      this.take(message)
    }
    ws.onerror = () => {
      // The close handler runs next and owns the retry.
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.failures += 1
      this.retry('The server closed the connection.')
    }
  }

  private take(message: Incoming): void {
    switch (message.t) {
      case 'sig':
        if (typeof message.d === 'string') this.events?.onWire(message.d)
        return
      case 'left':
        if (typeof message.id === 'string') this.onLeft?.(message.id)
        return
      case 'page':
      case 'ev': {
        const { at, lines } = message
        if (!Array.isArray(lines)) return
        // The server sends a space's lines in order, so the highest number
        // seen means everything below it has been seen too.
        if (at > this.at) this.at = at
        this.opening = this.opening.then(async () => {
          const opened = await Promise.all(lines.map((line) => openLine(this.room.key, line)))
          const events = opened.filter((e) => e !== null)
          if (events.length) this.onEvents?.(events)
        })
        return
      }
      case 'live':
        if (message.at > this.at) this.at = message.at
        void this.opening.then(() => this.markLoaded())
        return
      case 'ack':
        // Not moved: lines before this one may still be on their way down.
        this.unacked.delete(message.id)
        return
      case 'nack':
        this.unacked.delete(message.id)
        this.onRefused?.(message.message ?? 'The server refused a write.')
        return
      default:
        return
    }
  }

  private retry(detail: string): void {
    if (this.closed) return
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
