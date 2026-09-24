/**
 * One WebSocket per server, carrying every space this device is in on it.
 *
 * A space lives on its server, and everything a space does goes over this
 * connection, both ways:
 *
 *   history   read page by page from wherever this device last got to
 *   writes    every event said here, sealed, kept, and acknowledged
 *   live      every event said anywhere else, the moment it is kept
 *   signals   handshakes, typing, and the rest of what is not kept
 *   presence  who is here, held by the server and said when it changes
 *
 * One connection for all of them, because a device wants to hear about every
 * space it is in at once: a direct message in one, a mention in another. Each
 * space rides it as a Channel, which is also that space's one transport for
 * the signal bus.
 *
 * Every line is sealed with the space's key before it leaves and every event
 * is checked on the way back in, so the server keeps and passes on what it
 * cannot read and cannot forge.
 *
 * The space is on every server of its cluster, so when the one this is
 * talking to goes quiet, the next is tried. Each numbers lines its own way,
 * so where a space has read to is kept per server, and a server not read from
 * yet is read from the start: what is already here costs a check.
 */

import { serverUrl } from '../backend'
import type { Room } from '../room'
import { openLine, sealEvent } from './server-api'
import type { LogEvent } from '../store/log'
import { backoffDelay, type Transport, type TransportEvents, type TransportStatus } from '../signal/transport'
import { answered, discover, endpoints } from './cluster'

/** Signals held while the connection is down, and for how long. */
const SIGNAL_LIMIT = 120
const SIGNAL_TTL_MS = 20_000
/** A write batch stays well under the frame the server accepts. */
const PUT_BYTES = 600_000

type Incoming =
  | { t: 'page' | 'ev'; room: string; at: number; lines: unknown[] }
  | { t: 'live'; room: string; at: number }
  | { t: 'ack'; room: string; id: string; at: number }
  | { t: 'nack'; room: string; id?: string; code?: string; message?: string }
  | { t: 'sig'; room: string; d: string }
  | { t: 'left'; room: string; id: string }

type Outgoing = Record<string, unknown> & { t: string }

export class Connection {
  /** The server that names the spaces on this connection. */
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
    // Learn the rest of the cluster now, while the first one answers.
    void discover(this.base)
  }

  get open(): boolean {
    return this.status === 'open'
  }

  /** The server this is talking to now. */
  get serving(): string {
    return this.current || this.base
  }

  /** Carry a space on this connection. Dials if it is the first. */
  add(channel: Channel): void {
    this.channels.set(channel.room.id, channel)
    if (this.open) channel.opened()
    else if (!this.ws && this.retryTimer === null) this.dial()
  }

  /**
   * Stop carrying a space, if this is still the channel carrying it. A space
   * left and opened again at once has a new channel by the time the old one
   * finishes closing, and the old one must not take the new one with it.
   */
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

  /** The next server: the same one until it has failed twice, then the next in the cluster. */
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
    ws.onerror = () => {
      // The close handler runs next and owns the retry.
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
      ws.onerror = null
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

/** The one connection to a server, made the first time it is wanted. */
export function connectionTo(server: string): Connection {
  const base = serverUrl(server)
  let held = connections.get(base)
  if (!held) {
    held = new Connection(base)
    connections.set(base, held)
  }
  return held
}

/**
 * One space on a connection: its history, its writes, its signals and its
 * presence. The signal bus's one transport for the space.
 */
export class Channel implements Transport {
  readonly name: string
  readonly room: Room
  status: TransportStatus = 'idle'
  ready = false

  /** Events that arrived, opened but not yet checked. The space checks them. */
  onEvents: ((events: unknown[]) => void) | null = null
  /** A session the server says has gone. */
  onLeft: ((session: string) => void) | null = null
  /** A write the server refused, with its reason. It will not heal by retrying. */
  onRefused: ((why: string) => void) | null = null
  /** The first time the history has been read to the end. */
  readonly loaded: Promise<void>

  /** How far this space has read on each server, by that server's own numbers. Memory only. */
  readonly read = new Map<string, number>()

  private readonly connection: Connection
  private events: TransportEvents | null = null
  private signals: { wire: string; expires: number }[] = []
  private state: { d: string; id: string } | null = null
  /** Writes not yet acknowledged, by request id, kept sealed so a resend is byte for byte. */
  private readonly unacked = new Map<string, string[]>()
  private nextId = 0
  private markLoaded: () => void = () => undefined
  /** Opening happens in order, so pages land in the order they were sent. */
  private opening: Promise<void> = Promise.resolve()

  constructor(connection: Connection, room: Room, name: string) {
    this.connection = connection
    this.room = room
    this.name = name
    this.loaded = new Promise((done) => (this.markLoaded = done))
  }

  /** Which server the space is on right now, for the status line. */
  get serving(): string {
    return this.connection.serving
  }

  private get at(): number {
    return this.read.get(this.connection.serving) ?? 0
  }

  private set at(value: number) {
    this.read.set(this.connection.serving, value)
  }

  private send(message: Outgoing): boolean {
    return this.connection.send({ ...message, room: this.room.id })
  }

  // ---- the transport the signal bus sees ----

  connect(_topic: string, events: TransportEvents): void {
    this.events = events
    this.connection.add(this)
  }

  publish(wire: string): void {
    if (this.send({ t: 'sig', d: wire })) return
    const now = Date.now()
    this.signals = this.signals.filter((m) => m.expires > now)
    if (this.signals.length >= SIGNAL_LIMIT) this.signals.shift()
    this.signals.push({ wire, expires: now + SIGNAL_TTL_MS })
  }

  /**
   * Who this is, kept by the server. Sent when it changes and never on a
   * timer: the server hands the latest to whoever arrives, and tells the
   * space when this session goes. Kept here to say again on reconnecting.
   */
  publishState(wire: string, session: string): void {
    this.state = { d: wire, id: session }
    this.send({ t: 'state', ...this.state })
  }

  close(): void {
    this.signals = []
    this.connection.remove(this.room.id, this)
    this.statusChanged('idle')
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

  // ---- what the connection tells it ----

  statusChanged(status: TransportStatus, detail?: string): void {
    this.status = status
    this.ready = status === 'open'
    this.events?.onStatus(this, status, detail)
  }

  /** The connection is up: say who this is, ask for what was missed, resend what was not kept. */
  opened(): void {
    this.statusChanged('open')
    if (this.state) this.send({ t: 'state', ...this.state })
    this.send({ t: 'hello', from: this.at })
    // The server keeps one copy of a line it already has.
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
        // A space's lines come in order, so the highest number seen means
        // everything below it has been seen too.
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
        if (message.id) this.unacked.delete(message.id)
        this.onRefused?.(message.message ?? 'The server refused a write.')
        return
      default:
        return
    }
  }
}
