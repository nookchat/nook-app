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
  | 'level'
  | 'space'
  | 'close'
  | 'dm'

/** A level's id, or 'kicked' for somebody removed from the space. */
export type Role = string

/**
 * What a level lets somebody do. Each is checked by every device when it
 * reads the log, so a button that shows is a convenience and never the rule.
 */
export type Permission = 'channels' | 'pin' | 'delete' | 'remove' | 'move' | 'levels' | 'space'

export const PERMISSIONS: { id: Permission; label: string; about: string }[] = [
  { id: 'channels', label: 'Channels', about: 'Make, rename and delete channels' },
  { id: 'pin', label: 'Pin messages', about: 'Hold a message up at the top of a channel' },
  { id: 'delete', label: 'Delete messages', about: 'Take down what anybody wrote' },
  { id: 'remove', label: 'Remove people', about: 'Remove somebody, or let them back in' },
  { id: 'move', label: 'Move people', about: 'Move somebody into your voice channel' },
  { id: 'levels', label: 'Levels', about: 'Change levels below theirs, and put people on them' },
  { id: 'space', label: 'The space', about: 'Rename it, clear its history, or delete it' },
]

const ALL: Permission[] = PERMISSIONS.map((p) => p.id)

/**
 * A step on the ladder of who runs a space.
 *
 * A higher rank is above a lower one. The owner is the person who made the
 * space, alone at the top; a member is everybody nobody has put anywhere.
 * Both always exist. Every other level is stated in the log by somebody
 * allowed to, and can be changed or taken away the same way.
 */
export interface Level {
  id: string
  name: string
  /** `#rrggbb`, or empty for the ordinary colour of text. */
  colour: string
  rank: number
  can: Permission[]
}

export const OWNER = 'owner'
export const MEMBER = 'member'
const TOP = 1000

/** What a space starts with, before anybody changes a thing. */
const STARTING: Level[] = [
  { id: OWNER, name: 'Owner', colour: '#f0b232', rank: TOP, can: ALL },
  { id: 'admin', name: 'Admin', colour: '#f25f5c', rank: 100, can: ALL },
  { id: 'mod', name: 'Moderator', colour: '#3ddc84', rank: 50, can: ['pin', 'delete', 'remove', 'move'] },
  { id: MEMBER, name: 'Member', colour: '', rank: 0, can: [] },
]

/**
 * Who is where, worked out by walking the log in order.
 *
 * Each change counts only if whoever signed it was allowed to at that point:
 * a person changes levels below their own, gives nobody a power they lack,
 * and places people at their own level or lower. So the answer is the same
 * on every device and nobody can climb past the person above them.
 */
export class Authority {
  constructor(
    readonly founder: string,
    private readonly levels: Map<string, Level>,
    private readonly placed: Map<string, string>,
    /** When somebody was removed, in log order. */
    readonly kickedAt: Map<string, number>,
  ) {}

  /** Every level, highest first. */
  list(): Level[] {
    return [...this.levels.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))
  }

  level(id: string): Level | undefined {
    return this.levels.get(id)
  }

  levelOf(key: string): Level {
    if (key && key === this.founder) return this.levels.get(OWNER) as Level
    return this.levels.get(this.placed.get(key) ?? MEMBER) ?? (this.levels.get(MEMBER) as Level)
  }

  /** A level's id, or 'kicked'. */
  roleOf(key: string): Role {
    return this.kickedAt.has(key) ? 'kicked' : this.levelOf(key).id
  }

  isKicked(key: string): boolean {
    return this.kickedAt.has(key)
  }

  can(key: string, what: Permission): boolean {
    return !this.kickedAt.has(key) && this.levelOf(key).can.includes(what)
  }

  /** Whether `who` may change the level of `subject`: somebody at their own level or lower, never the owner. */
  mayPlace(who: string, subject: string): boolean {
    return (
      subject !== this.founder && this.can(who, 'levels') && this.levelOf(subject).rank <= this.levelOf(who).rank
    )
  }

  /** Whether `who` may remove `subject`, or let them back in. */
  mayRemove(who: string, subject: string): boolean {
    return (
      subject !== this.founder && who !== subject && this.can(who, 'remove') && this.levelOf(subject).rank <= this.levelOf(who).rank
    )
  }

  /** Whether `who` may change or take away a level: only one below their own. */
  mayEdit(who: string, level: Level): boolean {
    return level.id !== OWNER && this.can(who, 'levels') && level.rank < this.levelOf(who).rank
  }
}

/** A colour as a level states it, or empty when it is not one. */
export function cleanColour(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return /^#[0-9a-f]{6}$/.test(text) ? text : ''
}

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
 * The ceiling is the tightest pipe an event has to fit through, and there are
 * two. The wire: one event is one message on a data channel, sent whole, and
 * sixty four kilobytes is the figure every browser is safe at. The archive:
 * one event is one stored line of b64url(iv + ciphertext), which is four
 * thirds of the event and change, against the 64 KiB line cap every archive
 * already deployed enforces. The archive is the tighter pipe, and the one
 * that matters most, because the message only the archive can deliver is
 * exactly the one written while everybody else was offline.
 *
 * So the body stays under three quarters of the archive line, with room for
 * the seal and the fields. It was sixteen thousand letters counted with a
 * margin for escaping; counting the bytes of the escaped form directly buys
 * enough back that a written-out svg the size of a real logo fits.
 *
 * A body over this is refused on arrival rather than trimmed, so the sender
 * has to check the same number before it goes. A tab still running the old
 * code refuses anything over its own smaller figure, and a reload is what
 * fixes it.
 */
export const MAX_BODY = 48_000

/** The most one message's text may weigh in its JSON form, in bytes, leaving
    room inside MAX_BODY for the fields that ride beside it. */
export const MAX_TEXT = 46_000

/**
 * And the most a private message may, measured in bytes rather than letters.
 *
 * A private message is sealed before it is written down, and sealing turns
 * bytes into about a third more base64 again. One emoji is four bytes and one
 * letter is one, so a limit counted in letters would be right for English and
 * wrong by four times for anything else. This is the plaintext budget, and it
 * follows MAX_BODY: a third more than this plus the seal stays inside it.
 */
export const MAX_DM_BYTES = 34_000

/**
 * Cut a string until its JSON form fits a byte budget.
 *
 * The escaped form is what travels, so it is the thing measured: a quote or a
 * newline costs two bytes on the wire however it looks in the box. This is
 * the backstop behind the composer's own count, for text that arrives from
 * anywhere else.
 */
export function trimToWire(text: string, max: number): string {
  const enc = new TextEncoder()
  let out = text
  while (out.length > 0) {
    const size = enc.encode(JSON.stringify(out)).length
    if (size <= max) return out
    out = out.slice(0, Math.max(0, out.length - Math.max(1, Math.ceil((size - max) / 4))))
  }
  return out
}

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
      'level',
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
  if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_BODY) return null

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
    /*
     * Keep the ordered copy when the new event goes on the end, which is
     * nearly always: something just said is the newest thing there is.
     * Anything else, an old event from a peer catching us up, orders again
     * on the next read.
     */
    const ordered = this.ordered
    if (ordered && (ordered.length === 0 || compare(ordered[ordered.length - 1], event) < 0)) {
      // A new array, not a push: whoever is holding the last one, across an
      // await, keeps exactly what they were given.
      this.ordered = [...ordered, event]
    } else {
      this.ordered = null
    }
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
   * there is no authority to disagree with. A change only counts if the
   * person who signed it was allowed to make it at that point, which is why
   * this walks the log in order rather than reading the last word on each
   * person. It is worked out once for each state of the log.
   */
  authority(): Authority {
    const all = this.all()
    if (this.folded && this.folded.from === all && this.folded.founder === this.founder) return this.folded.auth
    const levels = new Map<string, Level>(STARTING.map((l) => [l.id, { ...l, can: [...l.can] }]))
    const placed = new Map<string, string>()
    const kickedAt = new Map<string, number>()
    const founder = this.founder
    const auth = new Authority(founder, levels, placed, kickedAt)

    for (const e of all) {
      if (e.kind === 'level') {
        const id = String(e.body.id ?? '')
        if (!/^[a-z0-9]{1,16}$/.test(id) || id === OWNER) continue
        const was = levels.get(id)
        if (was && !auth.mayEdit(e.author, was)) continue
        if (!was && !auth.can(e.author, 'levels')) continue
        const mine = auth.levelOf(e.author)
        if (e.body.gone === true) {
          // The level everybody starts on cannot go: there would be nowhere to stand.
          if (id === MEMBER || !was) continue
          levels.delete(id)
          for (const [key, at] of placed) if (at === id) placed.delete(key)
          continue
        }
        const name = String(e.body.name ?? '').slice(0, 24).trim()
        if (!name) continue
        const rank = id === MEMBER ? 0 : Number(e.body.rank)
        if (!Number.isFinite(rank) || (id !== MEMBER && (rank <= 0 || rank >= mine.rank))) continue
        // Nobody hands out a power they do not have.
        const asked = Array.isArray(e.body.can) ? e.body.can.map(String) : []
        const can = ALL.filter((p) => asked.includes(p) && mine.can.includes(p))
        levels.set(id, { id, name, colour: cleanColour(e.body.colour), rank, can })
        continue
      }
      if (e.kind !== 'role') continue
      const subject = String(e.body.subject ?? '')
      if (!/^[0-9a-f]{64}$/.test(subject) || subject === founder) continue
      const role = String(e.body.role ?? '')
      if (role === 'kicked') {
        if (auth.mayRemove(e.author, subject)) kickedAt.set(subject, e.lamport)
        continue
      }
      const level = levels.get(role)
      if (!level || level.id === OWNER) continue
      if (kickedAt.has(subject)) {
        // Letting somebody back in is the same power as removing them.
        if (!auth.mayRemove(e.author, subject) && !auth.mayPlace(e.author, subject)) continue
        kickedAt.delete(subject)
        if (level.id === MEMBER) {
          placed.delete(subject)
          continue
        }
      }
      if (!auth.mayPlace(e.author, subject) || level.rank > auth.levelOf(e.author).rank) continue
      if (level.id === MEMBER) placed.delete(subject)
      else placed.set(subject, level.id)
    }
    this.folded = { from: all, founder, auth }
    return auth
  }

  private folded: { from: LogEvent[]; founder: string; auth: Authority } | null = null

  /** Who stands where, as a map of key to level id or 'kicked'. The owner is included. */
  roles(): Map<string, Role> {
    const auth = this.authority()
    const out = new Map<string, Role>()
    if (this.founder) out.set(this.founder, OWNER)
    for (const e of this.all()) {
      if (e.kind !== 'role') continue
      const subject = String(e.body.subject ?? '')
      if (/^[0-9a-f]{64}$/.test(subject)) out.set(subject, auth.roleOf(subject))
    }
    return out
  }

  /** Whether the person behind a key may do a thing, by the level they are on now. */
  can(key: string, what: Permission): boolean {
    return this.authority().can(key, what)
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
    const auth = this.authority()
    let mark = 0
    for (const e of this.all()) {
      if (e.kind !== 'reset') continue
      if (!auth.can(e.author, 'space')) continue
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
    const auth = this.authority()
    for (const e of this.all()) {
      if (e.kind !== 'close') continue
      if (auth.can(e.author, 'space')) return true
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
    const auth = this.authority()
    const on = new Set<string>()
    const by = new Map<string, string>()
    for (const e of this.all()) {
      if (e.kind !== 'pin') continue
      if (!auth.can(e.author, 'pin')) continue
      const target = String(e.body.target ?? '')
      if (!/^[0-9a-f]{64}$/.test(target)) continue
      if (e.body.on === false) on.delete(target)
      else on.add(target)
      by.set(target, e.id)
    }
    return { on, by }
  }

  roleOf(pubkey: string): Role {
    return this.authority().roleOf(pubkey)
  }

  /** The name the space goes by, set by an admin. */
  spaceName(): string {
    let name = ''
    const auth = this.authority()
    for (const e of this.all()) {
      if (e.kind !== 'space') continue
      if (!auth.can(e.author, 'space')) continue
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
    return this.authority().kickedAt
  }

  /** Swap the contents for a compacted set, keeping the clock where it is. */
  replace(events: LogEvent[]): void {
    this.byId.clear()
    for (const e of events) this.byId.set(e.id, e)
    this.ordered = null
  }

  /** Every event, in the order every peer agrees on. */
  private ordered: LogEvent[] | null = null

  /**
   * Every event in order. Shared, not copied: read it, never change it. It
   * never changes under you either: adding an event makes a new one.
   *
   * It sorted the whole log afresh on every call, and one redraw calls this
   * a dozen times over, through names, roles, channels and messages. At a few
   * thousand events that was a third of the time it took to open a space.
   */
  all(): LogEvent[] {
    this.ordered ??= [...this.byId.values()].sort(compare)
    return this.ordered
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
    const auth = this.authority()

    for (const e of this.all()) {
      if (e.kind === 'channel') {
        // Only somebody on a level with channels makes or changes them, so
        // nobody can fill the rail from afar, and nobody but the people who
        // run the place can empty it.
        if (!auth.can(e.author, 'channels')) continue
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
      } else if (!voice && e.kind === 'said' && auth.can(e.author, 'channels')) {
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
    const auth = this.authority()
    for (const e of this.all()) {
      if (e.kind !== 'channel' || !auth.can(e.author, 'channels')) continue
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
      if (e.kind === 'role' || e.kind === 'level' || e.kind === 'space' || e.kind === 'reset') live.add(e.id)
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
    const auth = this.authority()
    const out = new Map<string, string>()
    for (const e of this.all()) {
      if (e.kind !== 'channel') continue
      if (!auth.can(e.author, 'channels')) continue
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
    const auth = this.authority()
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
      if (e.kind === 'role' || e.kind === 'level' || e.kind === 'space' || e.kind === 'close') continue
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
          files: cleanFiles(e.body.files),
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
        if (e.author !== target.author && !auth.can(e.author, 'delete')) continue
        target.retracted = true
        target.text = ''
        target.files = []
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

/**
 * A file hanging off a message.
 *
 * The bytes are on the server, sealed with `key`, which is made fresh for
 * each file and travels only here, inside the message, which is sealed with
 * the space's key in turn. The server keeps the file under `id`, the SHA-256
 * of the sealed bytes, and never sees the key. What a picture or a video
 * looks like, `w` by `h`, and a tiny blurred `thumb` ride along so it can be
 * given its space and a hint of itself before a byte of it has arrived.
 */
export interface Attachment {
  id: string
  name: string
  type: string
  /** Of the file itself, before it was sealed. */
  size: number
  /** The file's own key: 32 bytes, base64url. */
  key: string
  w?: number
  h?: number
  /** Seconds, for a video or a sound. */
  dur?: number
  /** A few hundred bytes of JPEG, as a data URL. */
  thumb?: string
  /** A video's first frame, sealed with the same key and kept as its own file. */
  poster?: string
}

/** The most files one message may carry. */
export const MAX_FILES = 10

/**
 * Attachments as a message states them, with anything that does not hold up
 * dropped. Everything here reaches the page from somebody else, so nothing is
 * taken on trust: sizes are numbers, ids are hashes, a thumb is a picture.
 */
export function cleanFiles(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return []
  const out: Attachment[] = []
  const count = (v: unknown, most: number): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= most ? v : undefined
  for (const item of raw.slice(0, MAX_FILES)) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const id = String(f.id ?? '')
    const key = String(f.key ?? '')
    const size = Number(f.size)
    if (!/^[0-9a-f]{64}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(key)) continue
    if (!Number.isFinite(size) || size < 0) continue
    const file: Attachment = {
      id,
      key,
      size: Math.floor(size),
      name: String(f.name ?? '').slice(0, 120).trim() || 'file',
      type: /^[\w.+-]+\/[\w.+-]+$/.test(String(f.type ?? '')) ? String(f.type).slice(0, 80) : 'application/octet-stream',
    }
    const w = count(f.w, 20_000)
    const h = count(f.h, 20_000)
    if (w && h) {
      file.w = Math.round(w)
      file.h = Math.round(h)
    }
    const dur = count(f.dur, 1_000_000)
    if (dur) file.dur = dur
    if (typeof f.thumb === 'string' && f.thumb.length <= 4000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(f.thumb)) {
      file.thumb = f.thumb
    }
    if (typeof f.poster === 'string' && /^[0-9a-f]{64}$/.test(f.poster)) file.poster = f.poster
    out.push(file)
  }
  return out
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
  /** Files it carries, in the order they were attached. */
  files?: Attachment[]
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
