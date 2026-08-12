/**
 * The room log.
 *
 * Chat is not a stream of messages passing through a host. It is an append only
 * set of signed, immutable events that every member holds a copy of. Nothing is
 * ever changed in place: an edit is an event pointing at another event, and so
 * is a reaction, a reply, or a retraction.
 *
 * That is what makes it survive. Two people who have been apart can merge their
 * logs by unioning them, because a set of immutable events converges by
 * construction and needs no conflict resolution and no CRDT.
 *
 * Order is (lamport, author, id), never wall clock. Two machines rarely agree on
 * the time, and a chat log that jumps backwards because somebody's laptop is
 * fast is a poor way to find that out.
 */

import { sign, verify } from './identity'

export type EventKind =
  | 'said'
  | 'edit'
  | 'react'
  | 'retract'
  | 'profile'
  | 'channel'
  | 'pin'
  | 'poll'
  | 'vote'
  | 'reset'
  | 'role'
  | 'space'
  | 'close'
  | 'dm'

export type Role = 'admin' | 'member' | 'kicked'

/** Every space has these, and they cannot be removed. */
export const DEFAULT_CHANNEL = 'general'
export const DEFAULT_VOICE = 'lounge'

export interface LogEvent {
  /** SHA-256 of the canonical form. The identity of the event. */
  id: string
  /** Which room this belongs to. */
  room: string
  /** Author's public key, hex. */
  author: string
  /** Logical clock. Higher means later, ties broken by author then id. */
  lamport: number
  kind: EventKind
  /** Author's wall clock. Shown, never trusted for ordering. */
  at: number
  body: Record<string, unknown>
  sig: string
}

/**
 * The most one event's body may be, as JSON, counted the same way at both ends.
 *
 * It was four thousand, which is a paragraph, and a pasted stack trace or a
 * long answer hit it. Sixteen thousand is about two and a half thousand words.
 *
 * The ceiling above it is the wire. One event is one message on a data
 * channel, sent whole and never cut into pieces, and a browser refuses a
 * message past the size it agreed with the far side. Sixty four kilobytes is
 * the figure every browser is safe at, so the body has to stay well under it
 * even in the worst case, where JSON escaping doubles what is counted here.
 *
 * A body over this is refused on arrival rather than trimmed, so the sender
 * has to check the same number before it goes. MAX_TEXT is that check with
 * room left for the fields around the words.
 */
export const MAX_BODY = 16_000

/** The most text one message may carry, leaving room for escaping and fields. */
export const MAX_TEXT = 12_000

/**
 * And the most a private message may, measured in bytes rather than letters.
 *
 * A private message is sealed before it is written down, and sealing turns
 * bytes into about a third more base64 again. One emoji is four bytes and one
 * letter is one, so a limit counted in letters would be right for English and
 * wrong by four times for anything else. This is the ciphertext budget.
 */
export const MAX_DM_BYTES = 11_000

/** Cut a string to fit a byte budget, without splitting a character in half. */
export function trimToBytes(text: string, max: number): string {
  const enc = new TextEncoder()
  if (enc.encode(text).length <= max) return text
  let out = text
  while (out.length > 0 && enc.encode(out).length > max) {
    // Overshoot by the ratio, then walk the last few off one at a time. A
    // character can be four bytes, so stepping by one byte would be wrong.
    const over = enc.encode(out).length - max
    out = out.slice(0, Math.max(0, out.length - Math.max(1, Math.ceil(over / 4))))
  }
  return out
}

/** The exact bytes that get hashed. Field order is part of the format. */
function canonical(e: Omit<LogEvent, 'id' | 'sig'>): string {
  return JSON.stringify([e.room, e.author, e.lamport, e.kind, e.at, e.body])
}

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function makeEvent(
  room: string,
  author: string,
  lamport: number,
  kind: EventKind,
  body: Record<string, unknown>,
): Promise<LogEvent> {
  const base = { room, author, lamport, kind, at: Date.now(), body }
  const id = await hash(canonical(base))
  return { ...base, id, sig: sign(id) }
}

/**
 * Read an event off the wire without trusting a byte of it.
 *
 * Shape, types, sizes, then the hash, then the signature. An event whose id does
 * not match its contents is a forgery attempt, not a mistake, and it is dropped
 * exactly as quietly as one with a bad signature.
 */
export async function openEvent(raw: unknown, room: string): Promise<LogEvent | null> {
  if (!raw || typeof raw !== 'object') return null
  const e = { ...(raw as Partial<LogEvent>) }
  /*
   * The room is not carried, it is supplied. Both sides already know which
   * room they are talking about, and it stays in what gets hashed, so an event
   * still cannot be lifted out of one space and replayed into another: do that
   * and the hash no longer matches and the signature no longer checks.
   */
  e.room = room
  // The id is not carried either. It is the hash of everything else, so it is
  // worked out below and compared, which is what used to happen to the copy
  // that arrived anyway. Sending it only ever gave a forger something to lie
  // about.
  if (typeof e.sig !== 'string' || !/^[0-9a-f]{128}$/.test(e.sig)) return null
  if (typeof e.author !== 'string' || !/^[0-9a-f]{64}$/.test(e.author)) return null
  if (typeof e.lamport !== 'number' || !Number.isInteger(e.lamport) || e.lamport < 0) return null
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return null
  if (
    ![
      'said',
      'edit',
      'react',
      'retract',
      'profile',
      'channel',
      'role',
      'space',
      'pin',
      'poll',
      'vote',
      'reset',
      'close',
      'dm',
    ].includes(
      String(e.kind),
    )
  )
    return null
  if (!e.body || typeof e.body !== 'object' || Array.isArray(e.body)) return null

  const body = e.body as Record<string, unknown>
  if (JSON.stringify(body).length > MAX_BODY) return null

  const base = {
    room: e.room,
    author: e.author,
    lamport: e.lamport,
    kind: e.kind as EventKind,
    at: e.at,
    body,
  }
  const id = await hash(canonical(base))
  if (!verify(id, e.sig, e.author)) return null
  return { ...base, id, sig: e.sig }
}

/**
 * An event, ready to be sent.
 *
 * Two of the eight fields never needed to travel. The id is the hash of the
 * other six, so the far side works it out rather than being told it, and the
 * room is the thing both sides are already talking about. Between them they
 * were a quarter of every message.
 *
 * What is left cannot be trimmed. The signature is sixty four bytes because
 * that is what a signature is, and it is what stops anybody writing under your
 * name; the author key is thirty two because that is what the signature is
 * checked against. They are the price of the whole idea, not padding.
 */
export type WireEvent = Omit<LogEvent, 'id' | 'room'>

export function packEvent(e: LogEvent): WireEvent {
  const { id: _id, room: _room, ...rest } = e
  return rest
}

/**
 * The kinds a reset sweeps away.
 *
 * Conversation, and the things that hang off it. Not names, roles, channels or
 * the name of the space: those describe the room rather than what was said in
 * it, and clearing them would take the room apart rather than empty it.
 */
const CLEARABLE = new Set<EventKind>(['said', 'edit', 'react', 'retract', 'pin', 'poll', 'vote'])

/**
 * The largest an avatar may be, in characters of data URI.
 *
 * A profile event has to fit inside MAX_BODY like everything else, so a picture
 * is downscaled to a thumbnail before it is ever written. See squarePng in the
 * settings view: 48 pixels of WebP lands around fifteen hundred characters.
 */
export const MAX_AVATAR = 2600

/** Only a picture, and only one this device can draw without running anything. */
export function cleanAvatar(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  if (!text || text.length > MAX_AVATAR) return ''
  // No SVG: it is a document that can carry script, and this ends up in a src.
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(text) ? text : ''
}

/**
 * How far ahead of our own clock another device may push ours.
 *
 * Five minutes, which is more than two honest machines ever disagree by and
 * far less than a wrong one claims. Beyond it the other device is either
 * broken or lying, and either way its idea of the time is not worth adopting.
 */
const SKEW_MS = 5 * 60 * 1000

/** Deterministic on every device, with no clock involved. */
export function compare(a: LogEvent, b: LogEvent): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  if (a.author !== b.author) return a.author < b.author ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The log of one room, in memory.
 *
 * Holds every event, and a view of what they add up to: which messages exist,
 * what they now say, what they were replied to with, and who reacted.
 */
export class RoomLog {
  readonly room: string
  /** Whose device this is, so "did I vote" can be answered without asking. */
  me = ''

  /**
   * The oldest history this device is still willing to hold.
   *
   * Only ever set by trimming, and only on the device that trimmed. Without
   * it, a device short of storage throws away old messages, is handed them
   * straight back by the first peer that still has them, throws them away
   * again, and so on for as long as both are open. Nothing breaks and nothing
   * settles either, and the device that was short of room spends the evening
   * writing and deleting the same events.
   *
   * It is a local decision and travels nowhere. Somebody else's copy is not
   * affected and their history is not shortened by ours being short.
   */
  floor = 0
  private readonly byId = new Map<string, LogEvent>()
  private clock = 0

  constructor(room: string) {
    this.room = room
  }

  get size(): number {
    return this.byId.size
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /**
   * The next clock value to stamp on something written here.
   *
   * A plain counter is enough to keep cause before effect and is a poor way to
   * sort a conversation. Two people who have not synced both start at one, so
   * whoever joins later writes low numbers, and their first message sorts above
   * an hour of somebody else's history. The times printed next to the messages
   * then disagree with the order they are printed in, which is what "the
   * ordering is terrible" looks like from the outside.
   *
   * So the counter starts from the wall clock instead of from zero. It still
   * only ever goes up, and still jumps past anything it receives, so causality
   * holds exactly as before. But two people who have never met now produce
   * numbers a few milliseconds apart rather than a few hundred, and the order
   * matches the clock without trusting it. A device with a wrong clock skews
   * its own messages and nobody else's, and cannot drag the room backwards,
   * because the value only ever climbs.
   */
  nextLamport(): number {
    return Math.max(this.clock + 1, Date.now())
  }

  /** Returns true when the event was new, so callers know whether to redraw. */
  add(event: LogEvent): boolean {
    if (this.byId.has(event.id)) return false
    // Older than this device is willing to keep, and only conversation is ever
    // refused: who runs the place is not history to be trimmed.
    if (event.lamport < this.floor && CLEARABLE.has(event.kind)) return false
    this.byId.set(event.id, event)
    this.advance(event.lamport)
    return true
  }

  /**
   * Take account of a clock we have heard, without letting it run away.
   *
   * The clock starts from the wall clock so a conversation reads in the order
   * it happened, which means a device whose own clock is wrong writes numbers
   * from its idea of now, and everybody who hears it takes the higher number.
   * One machine set to 2099 would otherwise drag the whole room's ordering
   * there permanently, and every message written afterwards, by anybody, would
   * sort above everything that ever really happened.
   *
   * So a heard value moves our clock forward by at most a day past our own.
   * The mad event still sorts where it says it does, because every device
   * sorts by what the event carries and they all agree on that. What it cannot
   * do is follow us home.
   */
  private advance(lamport: number): void {
    const ceiling = Date.now() + SKEW_MS
    const capped = Math.min(lamport, ceiling)
    if (capped > this.clock) this.clock = capped
  }

  /**
   * Who the space belongs to.
   *
   * There is no server to ask, so the founder is pinned the first time this
   * device sees the space and never moves after that. Whoever made it knows
   * from the start; whoever joins takes the earliest claim they sync and keeps
   * it. That is trust on first use, and its limit is worth stating: somebody
   * who syncs a brand new device from nobody but an impostor would pin the
   * impostor. Comparing the founder ID in settings out of band settles it.
   */
  founder = ''

  /**
   * What everybody is allowed to do, worked out from the log rather than
   * granted by anyone.
   *
   * Every peer runs this over the same events and reaches the same answer, so
   * there is no authority to disagree with. A change of role only counts if the
   * person who signed it was an admin at that point, which is why this walks
   * the log in order rather than reading the last word on each person.
   */
  roles(): Map<string, Role> {
    const roles = new Map<string, Role>()
    if (this.founder) roles.set(this.founder, 'admin')

    for (const e of this.all()) {
      if (e.kind !== 'role') continue
      if (roles.get(e.author) !== 'admin') continue // only an admin may change roles
      const subject = String(e.body.subject ?? '')
      const role = String(e.body.role ?? '')
      if (!/^[0-9a-f]{64}$/.test(subject)) continue
      if (subject === this.founder) continue // the founder cannot be demoted
      if (role !== 'admin' && role !== 'member' && role !== 'kicked') continue
      roles.set(subject, role)
    }
    return roles
  }

  /**
   * The line an admin drew under the conversation.
   *
   * Nothing is deleted from anybody else's device, because nothing can be:
   * every copy of this log belongs to whoever holds it and there is no server
   * to tell them otherwise. What a reset does is put a line in the log saying
   * everything before this point is finished with, and every device that reads
   * the log honours it, stops showing what is above the line, and throws it
   * away the next time it compacts.
   *
   * That is the honest limit and it is worth stating plainly: somebody who
   * kept a copy still has a copy. A reset is for starting a room again, not
   * for unsaying something. Retracting a message is the tool for that, and it
   * has the same limit.
   *
   * Names, roles, channels and the name of the space live above the line, or a
   * reset would take the room apart rather than empty it.
   */
  resetAt(): number {
    const roles = this.roles()
    let mark = 0
    for (const e of this.all()) {
      if (e.kind !== 'reset') continue
      if (roles.get(e.author) !== 'admin') continue
      const before = Number(e.body.before ?? 0)
      if (Number.isFinite(before) && before > mark) mark = before
    }
    return mark
  }

  /**
   * Whether an admin has shut the space down.
   *
   * The same shape as a reset and with the same honest limit. There is no
   * server holding the room, so closing it cannot reach out and wipe anybody's
   * disk. What it does is put a signed line in the log saying this space is
   * finished, which every device honours by forgetting the space: it leaves the
   * list, its history goes, and a device that syncs the line a week later does
   * the same on the way in. Whoever exported a copy first still has that copy.
   *
   * Only an admin counts, for the reason a reset does: otherwise anybody who
   * walked in could take the room away from everybody else.
   */
  closed(): boolean {
    const roles = this.roles()
    for (const e of this.all()) {
      if (e.kind !== 'close') continue
      if (roles.get(e.author) === 'admin') return true
    }
    return false
  }

  /**
   * The messages held up in each channel.
   *
   * Stated rather than toggled, the same way reactions are: a pin says on or
   * off rather than "the other thing", so the newest one wins and the rest can
   * be thrown away. Only an admin may pin, for the same reason only an admin
   * may make a channel: otherwise anybody can put anything at the top of a
   * room for everybody else.
   */
  pinned(): Set<string> {
    return this.pinnedIds().on
  }

  /**
   * What is pinned, and the event that said so.
   *
   * The id is needed as well as the answer, because compaction keeps whatever
   * had an effect and has no business working out for itself which pin that
   * was. Only a pin from somebody who was an admin at the time counts, so
   * "the newest pin" and "the pin that counts" are different events whenever
   * anybody who is not an admin has pressed the button.
   */
  private pinnedIds(): { on: Set<string>; by: Map<string, string> } {
    const roles = this.roles()
    const on = new Set<string>()
    const by = new Map<string, string>()
    for (const e of this.all()) {
      if (e.kind !== 'pin') continue
      if (roles.get(e.author) !== 'admin') continue
      const target = String(e.body.target ?? '')
      if (!/^[0-9a-f]{64}$/.test(target)) continue
      if (e.body.on === false) on.delete(target)
      else on.add(target)
      by.set(target, e.id)
    }
    return { on, by }
  }

  roleOf(pubkey: string): Role {
    return this.roles().get(pubkey) ?? 'member'
  }

  /** The name the space goes by, set by an admin. */
  spaceName(): string {
    let name = ''
    const roles = this.roles()
    for (const e of this.all()) {
      if (e.kind !== 'space') continue
      if (roles.get(e.author) !== 'admin') continue
      const claimed = String(e.body.name ?? '').slice(0, 32).trim()
      if (claimed) name = claimed
    }
    return name
  }

  /**
   * When somebody was removed, in log order. Anything they wrote after that
   * point is ignored by everybody, because everybody computes the same instant.
   */
  private kickedAt(): Map<string, number> {
    const out = new Map<string, number>()
    const roles = new Map<string, Role>()
    if (this.founder) roles.set(this.founder, 'admin')
    for (const e of this.all()) {
      if (e.kind !== 'role') continue
      if (roles.get(e.author) !== 'admin') continue
      const subject = String(e.body.subject ?? '')
      const role = String(e.body.role ?? '')
      if (subject === this.founder) continue
      if (role === 'kicked') out.set(subject, e.lamport)
      else if (role === 'admin' || role === 'member') {
        out.delete(subject)
        roles.set(subject, role)
      }
    }
    return out
  }

  /** Swap the contents for a compacted set, keeping the clock where it is. */
  replace(events: LogEvent[]): void {
    this.byId.clear()
    for (const e of events) this.byId.set(e.id, e)
  }

  all(): LogEvent[] {
    return [...this.byId.values()].sort(compare)
  }

  /** The most recent events, oldest first, for backfilling a peer. */
  recent(limit: number): LogEvent[] {
    const sorted = this.all()
    return sorted.slice(Math.max(0, sorted.length - limit))
  }

  /**
   * Fold the events into what the panel draws.
   *
   * Only the author of a message may edit or retract it, which is checked here
   * rather than trusted: the signature proves who wrote the edit, so an edit
   * from anybody else is simply ignored.
   */
  /**
   * Every channel an admin has made here, text and voice kept apart. Both are
   * events on this log, so a channel an admin made turns up the same way a
   * message does.
   */
  channels(voice = false): string[] {
    return this.channelList(voice).map((c) => c.name)
  }

  /**
   * The channels, with whatever an admin has said about them.
   *
   * A channel is its name for ever, because every message written in it carries
   * that name and nothing rewrites history here. What an admin can change is
   * what it is called on screen and what it is for, which is what somebody
   * fixing a typo actually wants, and it costs no rewriting of anything.
   *
   * Deleting one hides it and everything said in it. The events stay signed and
   * unaltered until the next tidy sweeps them, because that is the only kind of
   * deletion this design can honestly offer.
   */
  channelList(voice = false): ChannelInfo[] {
    const names = new Set<string>(voice ? [DEFAULT_VOICE] : [DEFAULT_CHANNEL])
    const label = new Map<string, string>()
    const topic = new Map<string, string>()
    const gone = new Set<string>()
    const roles = this.roles()

    for (const e of this.all()) {
      if (e.kind === 'channel') {
        // Only an admin makes or changes channels, so nobody can fill the rail
        // from afar, and nobody but the people who run the place can empty it.
        if (roles.get(e.author) !== 'admin') continue
        const isVoice = e.body.voice === true
        if (isVoice !== voice) continue
        const name = cleanChannel(String(e.body.name ?? ''))
        if (!name) continue
        names.add(name)
        if (typeof e.body.label === 'string') {
          const shown = e.body.label.slice(0, 32).trim()
          if (shown) label.set(name, shown)
        }
        if (typeof e.body.topic === 'string') topic.set(name, e.body.topic.slice(0, 140).trim())
        if (e.body.gone === true) gone.add(name)
        else gone.delete(name)
      } else if (!voice && e.kind === 'said' && roles.get(e.author) === 'admin') {
        // An admin writing in a channel is as good as making it, which is what
        // keeps a channel alive after its channel event is tidied away. Only an
        // admin, though: anybody's message used to count, and that let any
        // member conjure a channel by writing into it, straight past the
        // admin-only rule above.
        names.add(channelOf(e))
      }
    }

    // The one every space starts with cannot be taken away, or somebody has a
    // space with nowhere to talk and no way to make one if they are not an admin.
    gone.delete(voice ? DEFAULT_VOICE : DEFAULT_CHANNEL)

    return [...names]
      .filter((name) => !gone.has(name))
      .sort()
      .map((name) => ({ name, label: label.get(name) || name, topic: topic.get(name) ?? '' }))
  }

  /** Channels an admin has taken away, so what was said in them can go too. */
  private deletedChannels(voice = false): Set<string> {
    const live = new Set(this.channelList(voice).map((c) => c.name))
    const gone = new Set<string>()
    const roles = this.roles()
    for (const e of this.all()) {
      if (e.kind !== 'channel' || roles.get(e.author) !== 'admin') continue
      if ((e.body.voice === true) !== voice) continue
      const name = cleanChannel(String(e.body.name ?? ''))
      if (name && !live.has(name)) gone.add(name)
    }
    return gone
  }

  /** Pass a channel to see only that one, or nothing to see them all. */
  /**
   * Which events actually did something.
   *
   * Compaction needs this and used to guess at it, by keeping the newest edit
   * of a message, the newest pin, and so on. The guess was wrong in the way
   * that matters: an edit from somebody who did not write the message is
   * ignored when the room is drawn and was newest as far as compaction was
   * concerned, so compaction threw away the real edit and kept the one nobody
   * honours. The same for a pin. Anybody could quietly delete anybody's edit
   * by typing over it, and it only took effect once the log was tidied, which
   * is long after they had gone.
   *
   * So there is one walk and one answer. Whatever drew the room is what is
   * kept, and nothing else can be, because there is no second opinion to have.
   */
  effective(): Set<string> {
    const live = new Set<string>()
    this.messages(undefined, live)
    for (const e of this.all()) {
      // The room itself, as opposed to what was said in it. Every one of these
      // is kept: who runs the place is worked out by walking them in order, so
      // dropping any of them changes the answer.
      if (e.kind === 'role' || e.kind === 'space' || e.kind === 'reset') live.add(e.id)
      // And the line that closes the space, which has to outlive everything it
      // closes: a peer that never heard it would hand the room straight back.
      if (e.kind === 'close') live.add(e.id)
      // And every retraction, which is a tombstone rather than an event: a
      // peer offers the original again on the next sync and this refuses it.
      if (e.kind === 'retract') live.add(e.id)
    }
    for (const id of this.latestProfiles().values()) live.add(id)
    for (const id of this.latestChannels().values()) live.add(id)
    return live
  }

  /** The newest name each key gave itself, by event id. */
  private latestProfiles(): Map<string, string> {
    const out = new Map<string, string>()
    for (const e of this.all()) if (e.kind === 'profile') out.set(e.author, e.id)
    return out
  }

  /** The newest word on each channel, by event id. Admins only, as ever. */
  private latestChannels(): Map<string, string> {
    const roles = this.roles()
    const out = new Map<string, string>()
    for (const e of this.all()) {
      if (e.kind !== 'channel') continue
      if (roles.get(e.author) !== 'admin') continue
      out.set(`${e.body.voice === true ? 'v' : 't'}:${String(e.body.name ?? '')}`, e.id)
    }
    return out
  }

  messages(channel?: string, effective?: Set<string>): Message[] {
    const out: Message[] = []
    const index = new Map<string, Message>()
    const names = new Map<string, string>()
    const kicked = this.kickedAt()
    const cleared = this.resetAt()
    const roles = this.roles()
    // What was said in a channel that has been taken away goes with it.
    const removed = this.deletedChannels()
    // The newest word from each person on each thing, so the ones it replaced
    // can be dropped rather than kept for ever.
    const edited = new Map<string, string>()
    const reacted = new Map<string, string>()
    const voted = new Map<string, string>()

    for (const e of this.all()) {
      // Everything above the line an admin drew is finished with.
      if (e.lamport < cleared && CLEARABLE.has(e.kind)) continue
      // Somebody removed keeps what they already said and loses what came after.
      const removedAt = kicked.get(e.author)
      if (removedAt !== undefined && e.lamport > removedAt) continue
      if (e.kind === 'role' || e.kind === 'space' || e.kind === 'close') continue
      /*
       * A private message is kept and never drawn here. Everybody holds the
       * sealed copy, because that is how it reaches the person it is for; only
       * two people in the room can open it. See RoomChat.readDirect.
       */
      if (e.kind === 'dm') {
        effective?.add(e.id)
        continue
      }
      if (e.kind === 'profile') {
        const name = String(e.body.name ?? '').slice(0, 24)
        if (name) names.set(e.author, name)
        continue
      }
      if (e.kind === 'channel') continue
      if (e.kind === 'poll') {
        if (removed.has(channelOf(e))) continue
        if (channel && channelOf(e) !== channel) continue
        const question = String(e.body.question ?? '').slice(0, 200).trim()
        const raw = Array.isArray(e.body.options) ? e.body.options : []
        const options = raw
          .map((o) => String(o).slice(0, 80).trim())
          .filter(Boolean)
          .slice(0, 6)
        // A poll with nothing to pick between is not a poll.
        if (!question || options.length < 2) continue
        const message: Message = {
          id: e.id,
          author: e.author,
          at: e.at,
          lamport: e.lamport,
          channel: channelOf(e),
          text: question,
          replyTo: null,
          edited: false,
          retracted: false,
          reactions: new Map(),
          poll: { question, options, votes: new Map(), mine: null, total: 0 },
        }
        index.set(e.id, message)
        out.push(message)
        effective?.add(e.id)
        continue
      }
      if (e.kind === 'vote') {
        const target = index.get(String(e.body.target ?? ''))
        if (!target?.poll) continue
        const choice = Number(e.body.choice)
        if (!Number.isInteger(choice) || choice < 0 || choice >= target.poll.options.length) continue
        // One vote each. Changing your mind moves it rather than adding one.
        for (const who of target.poll.votes.values()) who.delete(e.author)
        const set = target.poll.votes.get(choice) ?? new Set<string>()
        set.add(e.author)
        target.poll.votes.set(choice, set)
        // The newest vote from this person on this poll, so older ones go.
        const was = voted.get(`${e.author}|${target.id}`)
        if (was) effective?.delete(was)
        voted.set(`${e.author}|${target.id}`, e.id)
        effective?.add(e.id)
        continue
      }
      if (e.kind === 'said') {
        if (removed.has(channelOf(e))) continue
        if (channel && channelOf(e) !== channel) continue
        const message: Message = {
          id: e.id,
          author: e.author,
          at: e.at,
          lamport: e.lamport,
          channel: channelOf(e),
          text: String(e.body.text ?? ''),
          replyTo: typeof e.body.replyTo === 'string' ? e.body.replyTo : null,
          inThread: e.body.thread === true,
          emote: e.body.emote === true,
          live: e.body.live === true,
          edited: false,
          retracted: false,
          reactions: new Map(),
        }
        index.set(e.id, message)
        out.push(message)
        effective?.add(e.id)
        continue
      }
      const target = index.get(String(e.body.target ?? ''))
      if (!target) continue
      if (e.kind === 'edit') {
        if (e.author !== target.author) continue
        target.text = String(e.body.text ?? '')
        target.edited = true
        // Only the newest edit that counts is worth keeping.
        const was = edited.get(target.id)
        if (was) effective?.delete(was)
        edited.set(target.id, e.id)
        effective?.add(e.id)
      } else if (e.kind === 'retract') {
        /*
         * Your own, or anybody's if you run the place.
         *
         * Somebody has to be able to take down what was posted in a room they
         * are responsible for, and only the author could. An admin's retraction
         * counts from the moment they were an admin, which is the same rule
         * every other thing an admin may do is held to.
         */
        if (e.author !== target.author && roles.get(e.author) !== 'admin') continue
        target.retracted = true
        target.text = ''
        target.reactions.clear()
        effective?.add(e.id)
      } else if (e.kind === 'react') {
        const emoji = oneEmoji(String(e.body.emoji ?? ''))
        if (!emoji) continue
        const who = target.reactions.get(emoji) ?? new Set<string>()
        /*
         * On and off are stated rather than toggled. A toggle has to be counted
         * from the beginning of time to know where it landed, which means the
         * log can never forget any of them. Stated this way the newest one wins
         * and the rest can be compacted away.
         */
        if (e.body.on === false) who.delete(e.author)
        else who.add(e.author)
        if (who.size) target.reactions.set(emoji, who)
        else target.reactions.delete(emoji)
        const key = `${e.author}|${target.id}|${emoji}`
        const was = reacted.get(key)
        if (was) effective?.delete(was)
        reacted.set(key, e.id)
        effective?.add(e.id)
      }
    }

    /*
     * A retracted message keeps nothing but its tombstone.
     *
     * The text is the thing somebody asked to be rid of, so it has to leave
     * the disk on the next tidy rather than sit there unread. The retraction
     * itself stays, because a peer will offer the original again on the next
     * sync and the tombstone is what refuses it.
     */
    if (effective) {
      for (const m of out) {
        if (!m.retracted) continue
        effective.delete(m.id)
        const wasEdited = edited.get(m.id)
        if (wasEdited) effective.delete(wasEdited)
        for (const [key, id] of reacted) if (key.endsWith(`|${m.id}`) || key.includes(`|${m.id}|`)) effective.delete(id)
        for (const [key, id] of voted) if (key.endsWith(`|${m.id}`)) effective.delete(id)
      }
    }

    const pins = this.pinnedIds()
    for (const [target, id] of pins.by) if (index.has(target)) effective?.add(id)
    for (const m of out) {
      m.name = names.get(m.author) ?? ''
      m.pinned = pins.on.has(m.id)
      if (!m.poll) continue
      let total = 0
      for (const [choice, who] of m.poll.votes) {
        total += who.size
        if (who.has(this.me)) m.poll.mine = choice
      }
      m.poll.total = total
    }

    // How many answers each message has waiting in its thread.
    const replies = new Map<string, number>()
    for (const m of out) {
      if (!m.inThread || !m.replyTo || m.retracted) continue
      replies.set(m.replyTo, (replies.get(m.replyTo) ?? 0) + 1)
    }
    for (const m of out) {
      const count = replies.get(m.id)
      if (count) m.replies = count
    }

    const live = out.filter((m) => !m.retracted)
    /*
     * A thread reply belongs to its thread, not to the channel underneath it.
     * Asking for one channel is asking for what a reader of that channel sees;
     * asking for all of them, which is what search and compaction do, is asking
     * for everything there is.
     */
    return channel ? live.filter((m) => !m.inThread) : live
  }

  /**
   * Every thread in the space, the busiest end first.
   *
   * A thread is discoverable from the message it hangs off and nowhere else,
   * which is fine for the ten minutes after it starts and useless the next day.
   */
  threads(): ThreadInfo[] {
    const all = this.messages()
    const out: ThreadInfo[] = []
    for (const root of all) {
      if (!root.replies) continue
      let last = root.at
      let newest = root.lamport
      for (const m of all) {
        if (!m.inThread || m.replyTo !== root.id) continue
        if (m.at > last) last = m.at
        if (m.lamport > newest) newest = m.lamport
      }
      out.push({ root, replies: root.replies, last, newest })
    }
    return out.sort((a, b) => b.last - a.last)
  }

  /**
   * One thread: the message it hangs off, and every answer to it in order.
   *
   * Flat rather than nested, which is what Discord settled on and for the same
   * reason: a tree of replies to replies is a thing nobody can follow after the
   * third level, and everybody who tried it went back to a flat list.
   */
  thread(rootId: string): Message[] {
    const all = this.messages()
    const root = all.find((m) => m.id === rootId)
    if (!root) return []
    return [root, ...all.filter((m) => m.inThread && m.replyTo === rootId)]
  }

  /** The latest picture each key gave for itself, if any. */
  avatars(): Map<string, string> {
    const out = new Map<string, string>()
    for (const e of this.all()) {
      if (e.kind !== 'profile') continue
      const picture = cleanAvatar(e.body.avatar)
      if (picture) out.set(e.author, picture)
      else if (e.body.avatar === '') out.delete(e.author)
    }
    return out
  }

  /** The latest name each key gave for itself. */
  names(): Map<string, string> {
    const names = new Map<string, string>()
    for (const e of this.all()) {
      if (e.kind !== 'profile') continue
      const name = String(e.body.name ?? '').slice(0, 24)
      if (name) names.set(e.author, name)
    }
    return names
  }

  /**
   * When each key was last heard from.
   *
   * The wall clock the author wrote, which is theirs and not to be trusted for
   * ordering, but is the only thing that answers "when". It is used to decide
   * who is worth showing in a members list, and being an hour out either way
   * changes nothing about that.
   */
  lastSeen(): Map<string, number> {
    const out = new Map<string, number>()
    for (const e of this.all()) {
      const was = out.get(e.author) ?? 0
      if (e.at > was) out.set(e.author, e.at)
    }
    return out
  }
}

/**
 * One emoji, whatever it is made of.
 *
 * A reaction is a single character to a reader and rarely one to a computer:
 * a flag is two regional letters, a thumb with a skin tone is two code points,
 * and a family is four people and three joiners. This used to keep the first
 * eight UTF-16 units, which cut the longer ones in half and could leave half a
 * surrogate pair behind, so the reaction that came out was not the one that
 * went in and two devices could bucket it differently.
 *
 * Written out rather than handed to Intl.Segmenter on purpose. Every device has
 * to reach the same answer or they disagree about which reactions are the same
 * reaction, and a rule that depends on which browser is running is not a rule.
 */
export function oneEmoji(raw: string): string {
  const points = [...raw]
  if (points.length === 0) return ''

  const code = (s: string): number => s.codePointAt(0) ?? 0
  const regional = (s: string): boolean => code(s) >= 0x1f1e6 && code(s) <= 0x1f1ff
  // A flag is a pair of regional letters and nothing else.
  if (regional(points[0]) && points[1] && regional(points[1])) return points[0] + points[1]

  let out = points[0]
  for (let i = 1; i < points.length && out.length < 32; i++) {
    const cp = code(points[i])
    const skinTone = cp >= 0x1f3fb && cp <= 0x1f3ff
    const variation = cp === 0xfe0f || cp === 0xfe0e
    const keycap = cp === 0x20e3
    const tag = cp >= 0xe0020 && cp <= 0xe007f
    if (skinTone || variation || keycap || tag) {
      out += points[i]
      continue
    }
    // A zero width joiner binds whatever follows it into the same character.
    if (cp === 0x200d && points[i + 1]) {
      out += points[i] + points[i + 1]
      i += 1
      continue
    }
    break
  }
  return out
}

/** A channel name: lower case, no spaces, the way every chat app does it. */
export function cleanChannel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}

function channelOf(e: LogEvent): string {
  const raw = cleanChannel(String(e.body.channel ?? ''))
  return raw || DEFAULT_CHANNEL
}

export interface ThreadInfo {
  root: Message
  replies: number
  /** When the last answer landed, by wall clock, for ordering a list. */
  last: number
  /** And by log clock, so "new since I read" means the same everywhere. */
  newest: number
}

export interface ChannelInfo {
  /** What every message in it carries. Never changes. */
  name: string
  /** What it is called on screen, which an admin may change. */
  label: string
  /** What it is for, in a line. */
  topic: string
}

export interface Message {
  id: string
  author: string
  name?: string
  channel: string
  at: number
  /** The log's own clock, which is what "newer" means when devices disagree. */
  lamport: number
  text: string
  replyTo: string | null
  /**
   * Written in a thread rather than in the channel.
   *
   * A thread is a view over replies, not a second kind of room: the events are
   * ordinary messages carrying the id of the one they answer. What this flag
   * changes is where the message is drawn. Somebody who chose "reply in thread"
   * gets it in the thread only, which is what keeps a channel readable when
   * twenty people answer the same question.
   */
  inThread?: boolean
  /** Written with /me, so it reads as an action rather than as speech. */
  emote?: boolean
  /**
   * Said by starting a stream.
   *
   * The line is an invitation to watch, and it only works as one while the
   * screen is up: the panel asks the space whether it still is before it
   * draws the way in. An old client draws the words alone, which still say
   * what happened.
   */
  live?: boolean
  /** How many thread replies hang off this one. Only counted for roots. */
  replies?: number
  edited: boolean
  retracted: boolean
  /** Held up at the top of the channel by an admin. */
  pinned?: boolean
  /** Present when this message is a poll rather than a line of text. */
  poll?: Poll
  reactions: Map<string, Set<string>>
}

export interface Poll {
  question: string
  options: string[]
  /** Who voted for each option, by key. One vote each, the last one counts. */
  votes: Map<number, Set<string>>
  /** Which one you picked, or null. */
  mine: number | null
  total: number
}
