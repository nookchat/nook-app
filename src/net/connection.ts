import { serverUrl } from '../backend'
import { dropRoom, readMine, readRoom, writeMine, writeRoom } from '../store/cache'
import type { Room } from '../room'
import { tagged, untag, type SpaceKeys } from '../space/keys'
import type { LogEvent } from '../store/log'
import { backoffDelay, type Transport, type TransportEvents, type TransportStatus } from '../signal/transport'
import { answered, discover, endpoints } from './cluster'
import { openLine, sealEvent } from './server-api'

const HELD_SIGNAL_LIMIT = 120
const HELD_SIGNAL_TTL_MS = 20_000
/** Well under the largest frame the server accepts. */
const PUT_BATCH_BYTES = 600_000
const FAILURES_BEFORE_NEXT_SERVER = 2
/** Lines sealed with a key this device does not hold yet, kept to open once it does. */
const HELD_LINES_LIMIT = 20_000
/** How many lines of a kept copy go into the log at a time. */
const RESTORE_PIECE = 400
/** A room with more lines than this is not kept on this device: it loads from the server. */
const KEEP_LIMIT_BYTES = 60_000_000
const KEEP_EVERY_MS = 800
/** How many of this device's own lines are kept for a start, until the server's copy has them. */
const KEEP_MINE = 300
/**
 * A socket can look open and carry nothing: after the computer slept, or moved to another
 * network, a browser may take many minutes to see it has gone. When the server has said nothing
 * for this long, the page asks it who is here, and a server that does not answer in time counts
 * as gone, so the page dials again and nothing it shows goes stale.
 */
const QUIET_MS = 30_000
const ANSWER_MS = 10_000
const LOOK_EVERY_MS = 10_000

type Incoming =
  | { t: 'page' | 'ev'; room: string; at: number; lines: unknown[] }
  | { t: 'live'; room: string; at: number; top?: number }
  | { t: 'ack'; room: string; id: string; at: number }
  | { t: 'nack'; room: string; id?: string; code?: string; message?: string }
  | { t: 'sig'; room: string; d: string }
  | { t: 'left'; room: string; id: string }
  | { t: 'here'; room: string; ids: unknown; up: number }

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
  /** When the server last said anything on this socket. */
  private heardAt = 0
  /** This server answers "who", so its silence after one means the socket is gone. An old one never does. */
  private answersWho = false
  private askedAt = 0
  private answerTimer: number | null = null
  private lookedAt = Date.now()

  constructor(base: string) {
    this.base = serverUrl(base)
    void discover(this.base)
    // Back on the network, or back at the screen: try now, not at the end of the wait.
    window.addEventListener('online', this.now)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.now()
    })
    window.setInterval(this.look, LOOK_EVERY_MS)
  }

  /** Dials now if it is waiting to, and asks an open socket whether it still carries anything. */
  private readonly now = (): void => {
    if (this.channels.size === 0) return
    if (this.retryTimer !== null) this.dial()
    else if (this.open) this.check()
  }

  private readonly look = (): void => {
    const now = Date.now()
    // A timer this late means the computer slept: the socket may not have come through it.
    const slept = now - this.lookedAt > 3 * LOOK_EVERY_MS
    this.lookedAt = now
    if (this.open && (slept || now - this.heardAt > QUIET_MS)) this.check()
  }

  /** Asks the server who is here, in any space: an answer, or anything else, says the socket works. */
  private check(): void {
    const room = this.channels.keys().next().value
    if (!this.answersWho || this.answerTimer !== null || !room) return
    const ws = this.ws
    this.askedAt = Date.now()
    if (!this.send({ t: 'who', room })) return
    this.answerTimer = window.setTimeout(() => {
      this.answerTimer = null
      if (this.ws !== ws || this.heardAt >= this.askedAt) return
      this.failures += 1
      this.retry('The server stopped answering.')
    }, ANSWER_MS)
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

  /** The page is going: says so for each space, and closes the socket, with no try again. */
  close(): void {
    for (const room of this.channels.keys()) this.send({ t: 'leave', room })
    this.channels.clear()
    this.teardown()
    this.setStatus('idle')
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
    // Each server of a cluster may be older or newer: this one says so with its first list.
    this.answersWho = false
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
      this.heardAt = Date.now()
      answered(this.base, this.current)
      this.setStatus('open')
      for (const channel of this.channels.values()) channel.opened()
    }
    ws.onmessage = (ev) => {
      this.heardAt = Date.now()
      if (typeof ev.data !== 'string') return
      let message: Incoming
      try {
        message = JSON.parse(ev.data) as Incoming
      } catch {
        return
      }
      if (message.t === 'here') this.answersWho = true
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
    if (this.answerTimer !== null) {
      window.clearTimeout(this.answerTimer)
      this.answerTimer = null
    }
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

/** Every socket, closed now: the page is going, and the servers tell the others at once. */
export function closeConnections(): void {
  for (const held of connections.values()) held.close()
  connections.clear()
}

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
  readonly keys: SpaceKeys

  /** Events opened, each with its place in the order the server sent the lines: see RoomLog.add. */
  onEvents: ((events: unknown[], places: number[]) => void) | null = null
  onLeft: ((session: string) => void) | null = null
  /**
   * The server has sent everybody here now, after a hello sent at `since`. Somebody who
   * left while the socket was down never gets a "left", so whoever it did not send is gone.
   */
  onEveryone: ((since: number) => void) | null = null
  /**
   * The server's list of every live session in the space, and how long the server has been up.
   * It comes with each hello, and after askWho. An old server never sends it.
   */
  onHere: ((ids: Set<string>, up: number) => void) | null = null
  onRefused: ((why: string) => void) | null = null
  readonly loaded: Promise<void>
  /**
   * The copy this device kept is in the log, when there was one. Without one, the same as
   * `loaded`. `loaded` itself waits for the server: only it says the history is whole.
   */
  shown: Promise<void>
  /** The server has sent all it had. Until then, what shows may be only what this device kept. */
  synced = false

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
  private helloAt = 0
  private openInOrder: Promise<void> = Promise.resolve()
  /** Lines under a key this device does not hold yet, each with its place among the lines sent. */
  private waiting: { line: string; place: number }[] = []
  /** How many lines the server has sent: a line's place. One under a key that comes later keeps it. */
  private sent = 0
  /** Closed: it has said it left, and a last announce on its way must not have it back. */
  private closed = false
  /** The copy of the lines kept on this device. Null once it stopped being a true one. */
  private kept: {
    server: string
    bytes: number
    written: number
    waiting: string[]
    at: number
    timer: number
    /** This device's own lines the server has not sent back, and how many of them came from an earlier start. */
    mine: string[]
    older: number
  } | null = { server: '', bytes: 0, written: 0, waiting: [], at: 0, timer: 0, mine: [], older: 0 }

  constructor(connection: Connection, room: Room, name: string, keys: SpaceKeys) {
    this.connection = connection
    this.room = room
    this.name = name
    this.keys = keys
    this.loaded = new Promise((done) => (this.markLoaded = done))
    this.shown = this.loaded
    keys.changed.add(this.openWaiting)
  }

  /** A key event goes out under the code's own key, so somebody who has only the code can find their copy. */
  private sealLine(event: LogEvent): Promise<string> {
    const { tag, key } = event.kind === 'key' ? { tag: '', key: this.keys.base } : this.keys.writing
    return sealEvent(key, event).then((wire) => tagged(tag, wire))
  }

  private async openOne(line: unknown, place: number): Promise<unknown> {
    if (typeof line !== 'string') return null
    const { tag, wire } = untag(line)
    const key = this.keys.key(tag)
    if (key) {
      const event = await openLine(key, wire)
      return this.keys.mayStand(tag, event) ? event : null
    }
    if (this.waiting.length >= HELD_LINES_LIMIT) this.waiting.shift()
    this.waiting.push({ line, place })
    return null
  }

  /** A key has come: the lines kept for it open now, each still at the place it came in. */
  private readonly openWaiting = (): void => {
    const ready = this.waiting.filter((held) => this.keys.key(untag(held.line).tag))
    if (ready.length === 0) return
    this.waiting = this.waiting.filter((held) => !this.keys.key(untag(held.line).tag))
    this.openInOrder = this.openInOrder.then(() =>
      this.deliverLines(
        ready.map((held) => held.line),
        ready.map((held) => held.place),
      ),
    )
  }

  /**
   * Puts the copy this device kept into the log, and has the next hello ask only for what came
   * after it. Call before the connection starts. Returns whether there was a copy.
   */
  async restore(): Promise<boolean> {
    const copy = await readRoom(this.room.id)
    const mine = copy ? await readMine(this.room.id) : []
    const kept = this.kept
    if (!copy || !kept || this.sent > 0 || copy.lines.length + mine.length === 0) return false
    kept.server = copy.server
    kept.written = copy.lines.length
    kept.at = copy.at
    kept.bytes = copy.lines.reduce((sum, line) => sum + line.length, 0)
    this.readTo.set(copy.server, copy.at)
    this.sent = copy.lines.length
    // A piece at a time, so the page stays alive while a long history opens.
    for (let from = 0; from < copy.lines.length; from += RESTORE_PIECE) {
      const piece = copy.lines.slice(from, from + RESTORE_PIECE)
      const places = piece.map((_, i) => from + i)
      this.openInOrder = this.openInOrder.then(() => this.deliverLines(piece, places))
    }
    // Between the last kept line and the first the server sends next.
    kept.mine = mine
    kept.older = mine.length
    if (mine.length) {
      const places = mine.map((_, i) => copy.lines.length - 1 + (i + 1) / (mine.length + 1))
      this.openInOrder = this.openInOrder.then(() => this.deliverLines(mine, places))
    }
    this.shown = this.openInOrder.then(() => undefined)
    return true
  }

  /** Lines just sent by the server, numbered in the order they came. */
  private deliverSent(lines: unknown[]): void {
    const first = this.sent
    this.sent += lines.length
    const places = lines.map((_, i) => first + i)
    this.keep(lines, first)
    this.openInOrder = this.openInOrder.then(() => this.deliverLines(lines, places))
  }

  /** Remembers lines to keep on this device, soon. A copy with a hole in it is worse than none. */
  private keep(lines: unknown[], first: number): void {
    const kept = this.kept
    if (!kept) return
    const server = this.connection.serving
    if (!kept.server) kept.server = server
    const whole = first === kept.written + kept.waiting.length && server === kept.server
    const text = lines.filter((line): line is string => typeof line === 'string')
    kept.bytes += text.reduce((sum, line) => sum + line.length, 0)
    // Another server numbers lines its own way, and one too big to keep is not kept at all.
    if (!whole || text.length !== lines.length || kept.bytes > KEEP_LIMIT_BYTES) return this.stopKeeping()
    kept.waiting.push(...text)
    kept.at = Math.max(kept.at, this.at)
    this.keepSoon()
  }

  /** Lines this device wrote, to show at the next start before the server has sent them back. */
  private keepMine(lines: string[]): void {
    const kept = this.kept
    if (!kept) return
    kept.mine = [...kept.mine, ...lines].slice(-KEEP_MINE)
    kept.older = Math.min(kept.older, kept.mine.length)
    void writeMine(this.room.id, kept.mine)
  }

  /** The server has sent everything: lines of this device's from an earlier start are in the copy now. */
  private mineArrived(): void {
    const kept = this.kept
    if (!kept || kept.older === 0) return
    this.writeKept()
    kept.mine = kept.mine.slice(kept.older)
    kept.older = 0
    void writeMine(this.room.id, kept.mine)
  }

  private keepSoon(): void {
    const kept = this.kept
    if (!kept || kept.timer) return
    kept.timer = window.setTimeout(() => this.writeKept(), KEEP_EVERY_MS)
  }

  private writeKept(): void {
    const kept = this.kept
    if (!kept) return
    window.clearTimeout(kept.timer)
    kept.timer = 0
    const lines = kept.waiting
    kept.waiting = []
    const from = kept.written
    kept.written += lines.length
    void writeRoom(this.room.id, kept.server, from, lines, kept.at)
  }

  private stopKeeping(): void {
    const kept = this.kept
    if (!kept) return
    window.clearTimeout(kept.timer)
    this.kept = null
    void dropRoom(this.room.id)
  }

  /** Never fails: the lines go in a chain, and one batch that threw would stop every batch after it. */
  private async deliverLines(lines: unknown[], places: number[]): Promise<void> {
    try {
      const opened = await Promise.all(lines.map((line, i) => this.openOne(line, places[i]).catch(() => null)))
      const events: unknown[] = []
      const at: number[] = []
      opened.forEach((e, i) => {
        if (e === null) return
        events.push(e)
        at.push(places[i])
      })
      if (events.length) this.onEvents?.(events, at)
    } catch (err) {
      console.warn('[nook] some lines did not open', err)
    }
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
    if (this.closed) return false
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

  /** Asks the server who is here. The answer comes as onHere. */
  askWho(): void {
    this.send({ t: 'who' })
  }

  close(): void {
    this.closed = true
    if (this.kept?.waiting.length) this.writeKept()
    this.signals = []
    this.waiting = []
    this.keys.changed.delete(this.openWaiting)
    this.connection.remove(this.room.id, this)
    this.statusChanged('idle')
  }

  async put(events: LogEvent[]): Promise<void> {
    if (events.length === 0) return
    const lines = await Promise.all(events.map((e) => this.sealLine(e)))
    this.keepMine(lines)
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
    this.helloAt = Date.now()
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
      case 'here':
        if (!Array.isArray(message.ids)) return
        this.onHere?.(new Set(message.ids.filter((id): id is string => typeof id === 'string')), Number(message.up) || 0)
        return
      case 'page':
      case 'ev': {
        const { at, lines } = message
        if (!Array.isArray(lines)) return
        // Lines arrive in order, so the highest number seen covers everything below it.
        if (at > this.at) this.at = at
        this.deliverSent(lines)
        return
      }
      case 'live': {
        // A server with less than this device kept has been started over: the copy is no true one.
        if (typeof message.top === 'number' && message.top < this.at) this.stopKeeping()
        if (message.at > this.at) this.at = message.at
        void this.openInOrder.then(() => {
          this.mineArrived()
          this.synced = true
          this.markLoaded()
        })
        const since = this.helloAt
        this.helloAt = 0
        if (since) this.onEveryone?.(since)
        return
      }
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
