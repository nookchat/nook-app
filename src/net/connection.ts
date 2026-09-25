import { serverUrl } from '../backend'
import type { Room } from '../room'
import type { LogEvent } from '../store/log'
import { backoffDelay, type Transport, type TransportEvents, type TransportStatus } from '../signal/transport'
import { answered, discover, endpoints } from './cluster'
import { openLine, sealEvent } from './server-api'

const HELD_SIGNAL_LIMIT = 120
const HELD_SIGNAL_TTL_MS = 20_000
/** Well under the largest frame the server accepts. */
const PUT_BATCH_BYTES = 600_000
const FAILURES_BEFORE_NEXT_SERVER = 2

type Incoming =
  | { t: 'page' | 'ev'; room: string; at: number; lines: unknown[] }
  | { t: 'live'; room: string; at: number }
  | { t: 'ack'; room: string; id: string; at: number }
  | { t: 'nack'; room: string; id?: string; code?: string; message?: string }
  | { t: 'sig'; room: string; d: string }
  | { t: 'left'; room: string; id: string }

type Outgoing = Record<string, unknown> & { t: string }

export class Connection {
  readonly base: string
  status: TransportStatus = 'idle'
  private ws: WebSocket | null = null
  private current = ''
  private failures = 0
  private attempt = 0
  private retryTimer: number | null = null
  private readonly channels = new Map<string, Channel>()

  constructor(base: string) {
    this.base = serverUrl(base)
    void discover(this.base)
  }

  get open(): boolean {
    return this.status === 'open'
  }

  get serving(): string {
    return this.current || this.base
  }

  add(channel: Channel): void {
    this.channels.set(channel.room.id, channel)
    if (this.open) channel.opened()
    else if (!this.ws && this.retryTimer === null) this.dial()
  }

  /** A space closed and opened again at once already has a new channel, which must stay. */
  remove(room: string, channel: Channel): void {
    if (this.channels.get(room) !== channel) return
    this.channels.delete(room)
    this.send({ t: 'leave', room })
  }

  send(message: Outgoing): boolean {
    if (!this.open || !this.ws) return false
    try {
      this.ws.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private pick(): string {
    const all = endpoints(this.base)
    if (!this.current || !all.includes(this.current)) return all[0]
    if (this.failures < FAILURES_BEFORE_NEXT_SERVER) return this.current
    this.failures = 0
    return all[(all.indexOf(this.current) + 1) % all.length]
  }

  private address(base: string): string {
    const url = new URL(base)
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/v1/socket`
    url.search = ''
    return url.toString()
  }

  private setStatus(status: TransportStatus, detail?: string): void {
    this.status = status
    for (const channel of this.channels.values()) channel.statusChanged(status, detail)
  }

  private dial(): void {
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
      for (const channel of this.channels.values()) channel.opened()
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let message: Incoming
      try {
        message = JSON.parse(ev.data) as Incoming
      } catch {
        return
      }
      this.channels.get(message.room)?.take(message)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.failures += 1
      this.retry('The server closed the connection.')
    }
  }

  private retry(detail: string): void {
    this.teardown()
    this.setStatus('retrying', detail)
    if (this.channels.size === 0) return
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      this.dial()
    }, backoffDelay(this.attempt++))
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
      ws.onclose = null
      try {
        ws.close()
      } catch {
        /* it was already gone */
      }
    }
  }
}

const connections = new Map<string, Connection>()

export function connectionTo(server: string): Connection {
  const base = serverUrl(server)
  let held = connections.get(base)
  if (!held) {
    held = new Connection(base)
    connections.set(base, held)
  }
  return held
}

export class Channel implements Transport {
  readonly name: string
  readonly room: Room

  onEvents: ((events: unknown[]) => void) | null = null
  onLeft: ((session: string) => void) | null = null
  onRefused: ((why: string) => void) | null = null
  readonly loaded: Promise<void>

  /** Each server numbers lines its own way, so the read position is kept per server. */
  private readonly readTo = new Map<string, number>()

  private readonly connection: Connection
  private events: TransportEvents | null = null
  private signals: { wire: string; expires: number }[] = []
  private state: { d: string; id: string } | null = null
  /** Kept sealed so a resend is byte for byte: the server keeps one copy of a line it already has. */
  private readonly unacked = new Map<string, string[]>()
  private nextId = 0
  private markLoaded: () => void = () => undefined
  private openInOrder: Promise<void> = Promise.resolve()

  constructor(connection: Connection, room: Room, name: string) {
    this.connection = connection
    this.room = room
    this.name = name
    this.loaded = new Promise((done) => (this.markLoaded = done))
  }

  get serving(): string {
    return this.connection.serving
  }

  private get at(): number {
    return this.readTo.get(this.connection.serving) ?? 0
  }

  private set at(value: number) {
    this.readTo.set(this.connection.serving, value)
  }

  private send(message: Outgoing): boolean {
    return this.connection.send({ ...message, room: this.room.id })
  }

  connect(events: TransportEvents): void {
    this.events = events
    this.connection.add(this)
  }

  publish(wire: string): void {
    if (this.send({ t: 'sig', d: wire })) return
    const now = Date.now()
    this.signals = this.signals.filter((m) => m.expires > now)
    if (this.signals.length >= HELD_SIGNAL_LIMIT) this.signals.shift()
    this.signals.push({ wire, expires: now + HELD_SIGNAL_TTL_MS })
  }

  publishState(wire: string, session: string): void {
    this.state = { d: wire, id: session }
    this.send({ t: 'state', ...this.state })
  }

  close(): void {
    this.signals = []
    this.connection.remove(this.room.id, this)
    this.statusChanged('idle')
  }

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
      if (batch.length > 0 && size + line.length > PUT_BATCH_BYTES) flush()
      batch.push(line)
      size += line.length
    }
    flush()
  }

  statusChanged(status: TransportStatus, detail?: string): void {
    this.events?.onStatus(this, status, detail)
  }

  opened(): void {
    this.statusChanged('open')
    if (this.state) this.send({ t: 'state', ...this.state })
    this.send({ t: 'hello', from: this.at })
    for (const [id, lines] of this.unacked) this.send({ t: 'put', id, lines, w: this.room.write })
    const now = Date.now()
    const held = this.signals.filter((m) => m.expires > now)
    this.signals = []
    for (const m of held) this.publish(m.wire)
  }

  take(message: Incoming): void {
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
        // Lines arrive in order, so the highest number seen covers everything below it.
        if (at > this.at) this.at = at
        this.openInOrder = this.openInOrder.then(async () => {
          const opened = await Promise.all(lines.map((line) => openLine(this.room.key, line)))
          const events = opened.filter((e) => e !== null)
          if (events.length) this.onEvents?.(events)
        })
        return
      }
      case 'live':
        if (message.at > this.at) this.at = message.at
        void this.openInOrder.then(() => this.markLoaded())
        return
      case 'ack':
        // `at` stays: lines before this one may still be on their way down.
        this.unacked.delete(message.id)
        return
      case 'nack':
        if (message.id) this.unacked.delete(message.id)
        this.onRefused?.(message.message ?? 'The server refused a write.')
        return
      default:
        return
    }
  }
}
