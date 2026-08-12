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
import { deleteEvents, getRoom, loadRoom, noteRoom, putEvents } from './db'
import { compact, limitsForNow } from './compact'
import {
  cleanChannel,
  DEFAULT_CHANNEL,
  makeEvent,
  openEvent,
  packEvent,
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
    this.log.me = id.pubkey
    this.name = id.name
  }

  get displayName(): string {
    return this.name
  }

  /**
   * Read this device's copy before talking to anybody, and tidy it on the way in.
   *
   * Loaded first, tidied second, and in that order for a reason: tidying needs
   * the log's own answer about which events counted, and the log has no answer
   * until it holds them. Tidying a bare pile of events falls back to guessing,
   * and the guess is what used to throw away real edits.
   */
  async load(): Promise<void> {
    const note = await getRoom(this.log.room)
    if (note?.floor) this.log.floor = note.floor
    const stored = await loadRoom(this.log.room)
    for (const event of stored) this.log.add(event)
    this.pinFounder()

    const { keep, drop } = compact(stored, await limitsForNow(), this.log.effective())
    if (drop.length) {
      this.raiseFloor(keep)
      void deleteEvents(drop)
      this.log.replace(keep)
      this.pinFounder()
    }
    void noteRoom({
      ...(note ?? { room: this.log.room, secret: this.secret, title: '' }),
      room: this.log.room,
      secret: this.secret,
      lastSeen: Date.now(),
      floor: this.log.floor || undefined,
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

  lastSeen(): Map<string, number> {
    return this.log.lastSeen()
  }

  roleOf(pubkey: string): string {
    return this.log.roleOf(pubkey)
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
    kind:
      | 'said'
      | 'edit'
      | 'react'
      | 'retract'
      | 'profile'
      | 'channel'
      | 'role'
      | 'space'
      | 'pin'
      | 'poll'
      | 'vote'
      | 'reset',
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

  /** Ask a question with a fixed set of answers. */
  askPoll(question: string, options: string[], channel: string): Promise<LogEvent> {
    return this.write('poll', {
      question: question.slice(0, 200),
      options: options.slice(0, 6),
      channel: cleanChannel(channel) || DEFAULT_CHANNEL,
    })
  }

  /** Pick one. Voting again moves your vote rather than adding another. */
  vote(target: string, choice: number): Promise<LogEvent> {
    return this.write('vote', { target, choice })
  }

  /**
   * Draw a line under everything said so far.
   *
   * The line is a lamport value, and the clock is derived from the wall clock,
   * so "now" is where it goes. Everything below it stops being shown on every
   * device that reads the log, and is thrown away the next time each of them
   * compacts.
   */
  reset(): Promise<LogEvent> {
    return this.write('reset', { before: this.log.nextLamport() })
  }

  /** Hold a message up at the top of its channel, or stop holding it. */
  pin(target: string, on: boolean): Promise<LogEvent> {
    return this.write('pin', { target, on })
  }

  announceName(name: string): Promise<LogEvent> {
    this.name = name
    return this.write('profile', { name })
  }

  /**
   * Remember how far back this device is willing to go.
   *
   * Set to the oldest message that survived trimming, so the peer that still
   * has the older ones does not hand them straight back to be trimmed again.
   * Only moves forward, and only on the device that trimmed.
   */
  private raiseFloor(keep: LogEvent[]): void {
    let oldest = Infinity
    for (const e of keep) {
      if (e.kind !== 'said' && e.kind !== 'poll') continue
      if (e.lamport < oldest) oldest = e.lamport
    }
    if (!Number.isFinite(oldest) || oldest <= this.log.floor) return
    this.log.floor = oldest
    void this.rememberFloor()
  }

  /** Keep the floor across a reload, or the next peer undoes the trimming. */
  private async rememberFloor(): Promise<void> {
    const note = await getRoom(this.log.room)
    if (!note) return
    await noteRoom({ ...note, floor: this.log.floor })
  }

  /** Throw away what the log no longer needs, in memory and on disk. */
  async tidy(): Promise<void> {
    this.sinceCompaction = 0
    const { keep, drop } = compact(this.log.all(), await limitsForNow(), this.log.effective())
    if (drop.length === 0) return
    this.raiseFloor(keep)
    this.log.replace(keep)
    await deleteEvents(drop)
    this.onChange?.()
  }

  // ---- the wire ----

  encode(events: LogEvent[]): string[] {
    const out: string[] = []
    for (let i = 0; i < events.length; i += BATCH) {
      const wire: Wire = { t: 'ev', e: events.slice(i, i + BATCH).map(packEvent) }
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
    return this.absorb(wire.e)
  }

  /**
   * Take a pile of events from anywhere and keep the ones that hold up.
   *
   * A peer, an archive, an imported file: all the same, and all checked the
   * same way. The check is the whole point, and it is why an archive can be
   * somebody else's machine without that mattering.
   */
  async absorb(candidates: unknown[]): Promise<LogEvent[]> {
    const fresh: LogEvent[] = []
    for (const candidate of candidates) {
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
