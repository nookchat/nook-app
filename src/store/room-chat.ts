/**
 * One room's chat: the log, the store, and the wire between peers.
 *
 * Everything a person does becomes an event, which is signed, written to this
 * device, and handed to whoever is connected. Everything that arrives is
 * verified, merged, and written down. Both directions go through here, so the
 * host and a viewer run identical code and differ only in who they are connected
 * to.
 */

import { loadIdentity } from './identity'
import { deleteEvents, loadRoom, noteRoom, putEvents } from './db'
import { compact, limitsForNow } from './compact'
import {
  cleanChannel,
  DEFAULT_CHANNEL,
  makeEvent,
  openEvent,
  RoomLog,
  type LogEvent,
  type Message,
} from './log'

/** How much history to hand a peer that has just connected. */
const BACKFILL = 250
/** Data channels choke on very large messages, so batches stay modest. */
const BATCH = 40

interface Wire {
  t: 'ev'
  e: unknown[]
}

export class RoomChat {
  readonly log: RoomLog
  readonly me: string
  onChange: (() => void) | null = null
  /**
   * Everything written here, on its way out to everybody else.
   *
   * This used to be the caller's job, and the caller forgot. Saying something
   * went through a publish helper that broadcast it; claiming the space, naming
   * it and announcing your own name called write directly and went no further
   * than this device. The symptom was that everybody else saw a key where your
   * name should be, because the profile event proving the name was yours never
   * left the room it was written in.
   *
   * So the send lives with the write. There is now one way out and no way to
   * write an event that nobody hears about.
   */
  onLocal: ((event: LogEvent) => void) | null = null

  private readonly secret: string
  private name: string
  private sinceCompaction = 0

  constructor(roomId: string, secret: string, founder = '') {
    this.log = new RoomLog(roomId)
    this.log.founder = founder
    this.secret = secret
    const id = loadIdentity()
    this.me = id.pubkey
    this.name = id.name
  }

  get displayName(): string {
    return this.name
  }

  /** Read this device's copy before talking to anybody, and tidy it on the way in. */
  async load(): Promise<void> {
    const stored = await loadRoom(this.log.room)
    const { keep, drop } = compact(stored, await limitsForNow())
    if (drop.length) void deleteEvents(drop)
    for (const event of keep) this.log.add(event)
    this.pinFounder()
    void noteRoom({
      room: this.log.room,
      secret: this.secret,
      lastSeen: Date.now(),
      title: '',
    })
    this.onChange?.()
  }

  channels(voice = false): string[] {
    return this.log.channels(voice)
  }

  messages(channel?: string): Message[] {
    const messages = this.log.messages(channel)
    const names = this.log.names()
    for (const m of messages) m.name = names.get(m.author) ?? m.name ?? ''
    return messages
  }

  nameOf(author: string): string {
    return this.log.names().get(author) ?? ''
  }

  /**
   * Take the earliest claim to the space as the founder, once, and keep it.
   *
   * Only used when this device has no founder yet. Whoever made the space sets
   * it directly; whoever joins learns it from the first claim they sync.
   */
  private pinFounder(): void {
    if (this.log.founder) return
    const claim = this.log
      .all()
      .find((e) => e.kind === 'role' && e.body.subject === e.author && e.body.role === 'admin')
    if (claim) {
      this.log.founder = claim.author
      this.onFounder?.(claim.author)
    }
  }

  onFounder: ((pubkey: string) => void) | null = null

  get founder(): string {
    return this.log.founder
  }

  get myRole(): string {
    return this.log.roleOf(this.me)
  }

  get isAdmin(): boolean {
    return this.myRole === 'admin'
  }

  roles(): Map<string, string> {
    return this.log.roles()
  }

  spaceName(): string {
    return this.log.spaceName()
  }

  /** Claim the space. Only ever called by whoever made it. */
  async claimFounder(): Promise<LogEvent> {
    this.log.founder = this.me
    return this.write('role', { subject: this.me, role: 'admin' })
  }

  setSpaceName(name: string): Promise<LogEvent> {
    return this.write('space', { name: name.slice(0, 32).trim() })
  }

  setRole(subject: string, role: 'admin' | 'member' | 'kicked'): Promise<LogEvent> {
    return this.write('role', { subject, role })
  }

  // ---- writing ----

  private async write(
    kind: 'said' | 'edit' | 'react' | 'retract' | 'profile' | 'channel' | 'role' | 'space',
    body: Record<string, unknown>,
  ): Promise<LogEvent> {
    const event = await makeEvent(this.log.room, this.me, this.log.nextLamport(), kind, body)
    this.log.add(event)
    void putEvents([event])
    this.onLocal?.(event)
    this.onChange?.()
    return event
  }

  say(text: string, channel: string, replyTo?: string | null): Promise<LogEvent> {
    const body: Record<string, unknown> = { text, channel: cleanChannel(channel) || DEFAULT_CHANNEL }
    if (replyTo) body.replyTo = replyTo
    return this.write('said', body)
  }

  makeChannel(name: string, voice = false): Promise<LogEvent> {
    return this.write('channel', voice ? { name: cleanChannel(name), voice: true } : { name: cleanChannel(name) })
  }

  edit(target: string, text: string): Promise<LogEvent> {
    return this.write('edit', { target, text })
  }

  react(target: string, emoji: string, on: boolean): Promise<LogEvent> {
    return this.write('react', { target, emoji, on })
  }

  retract(target: string): Promise<LogEvent> {
    return this.write('retract', { target })
  }

  announceName(name: string): Promise<LogEvent> {
    this.name = name
    return this.write('profile', { name })
  }

  /** Throw away what the log no longer needs, in memory and on disk. */
  async tidy(): Promise<void> {
    this.sinceCompaction = 0
    const { keep, drop } = compact(this.log.all(), await limitsForNow())
    if (drop.length === 0) return
    this.log.replace(keep)
    await deleteEvents(drop)
    this.onChange?.()
  }

  // ---- the wire ----

  encode(events: LogEvent[]): string[] {
    const out: string[] = []
    for (let i = 0; i < events.length; i += BATCH) {
      const wire: Wire = { t: 'ev', e: events.slice(i, i + BATCH) }
      out.push(JSON.stringify(wire))
    }
    return out
  }

  /** What a peer gets the moment the channel opens. */
  backfill(): string[] {
    return this.encode(this.log.recent(BACKFILL))
  }

  /**
   * Take what arrived and return only what was new, so the caller knows what to
   * pass on and whether anything changed. Everything is verified first: an event
   * that fails its hash or its signature never reaches the log.
   */
  async ingest(raw: string): Promise<LogEvent[]> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    const wire = parsed as Partial<Wire>
    if (!wire || wire.t !== 'ev' || !Array.isArray(wire.e)) return []
    if (wire.e.length > BATCH * 4) return []

    const fresh: LogEvent[] = []
    for (const candidate of wire.e) {
      const event = await openEvent(candidate, this.log.room)
      if (!event) continue
      if (this.log.add(event)) fresh.push(event)
    }
    if (fresh.length) {
      this.pinFounder()
      void putEvents(fresh)
      this.sinceCompaction += fresh.length
      if (this.sinceCompaction > 200) void this.tidy()
      this.onChange?.()
    }
    return fresh
  }
}
