import { toHex } from '../bytes'
import { publicKeyOf, sign, verify } from './identity'

const EVENT_KINDS = [
  'said',
  'edit',
  'react',
  'retract',
  'profile',
  'channel',
  'pin',
  'poll',
  'vote',
  'reset',
  'role',
  'level',
  'space',
  'close',
  'dm',
  'note',
  'whiteboard',
  'board',
  'key',
  'push',
  'invite',
  'join',
  'relocate',
  'hook',
] as const

export type EventKind = (typeof EVENT_KINDS)[number]

const KNOWN_KINDS = new Set<string>(EVENT_KINDS)

/** The id of a space key after the first: see src/space/keys.ts. */
export const KEY_ID = /^[0-9a-f]{32}$/
const PERSON_KEY = /^[0-9a-f]{64}$/
/** A webhook's id: digits, as Discord's are, so a tool that checks the link's shape takes it. */
export const HOOK_ID = /^[1-9][0-9]{16,19}$/
/** What a webhook writes: a post, a change to one, and its own deletion. Nothing else of its counts. */
export const HOOK_KINDS: ReadonlySet<string> = new Set<EventKind>(['said', 'edit', 'retract', 'hook'])
const KEY_COVERS_MS = 24 * 60 * 60 * 1000

/** A level's id, or 'kicked'. */
export type Role = string

export type Permission =
  | 'channels'
  | 'pin'
  | 'delete'
  | 'relocate'
  | 'remove'
  | 'move'
  | 'soundboard'
  | 'levels'
  | 'webhooks'
  | 'space'

export const PERMISSIONS: { id: Permission; label: string; about: string }[] = [
  { id: 'channels', label: 'Channels', about: 'Make, rename, order and delete channels' },
  { id: 'pin', label: 'Pin messages', about: 'Hold a message up at the top of a channel' },
  { id: 'delete', label: 'Delete messages', about: 'Take down what anybody wrote' },
  { id: 'relocate', label: 'Move messages', about: 'Put what anybody wrote in another channel' },
  { id: 'remove', label: 'Remove people', about: 'Remove somebody, or let them back in' },
  { id: 'move', label: 'Move people', about: 'Move somebody into a voice channel' },
  { id: 'soundboard', label: 'Soundboard', about: 'Play sounds in a voice channel, and add them' },
  { id: 'webhooks', label: 'Webhooks', about: 'Make and delete webhooks, and copy their links' },
  { id: 'levels', label: 'Levels', about: 'Change levels below theirs, and put people on them' },
  { id: 'space', label: 'The space', about: 'Rename it, clear its history, or delete it' },
]

const ALL: Permission[] = PERMISSIONS.map((p) => p.id)

export interface Level {
  id: string
  name: string
  /** `#rrggbb`, or empty. */
  colour: string
  rank: number
  can: Permission[]
}

export const OWNER = 'owner'
export const MEMBER = 'member'
const OWNER_RANK = 1000

const STARTING_LEVELS: Level[] = [
  { id: OWNER, name: 'Owner', colour: '#f0b232', rank: OWNER_RANK, can: ALL },
  { id: 'admin', name: 'Admin', colour: '#f25f5c', rank: 100, can: ALL },
  { id: 'mod', name: 'Moderator', colour: '#3ddc84', rank: 50, can: ['pin', 'delete', 'relocate', 'remove', 'move', 'soundboard'] },
  { id: MEMBER, name: 'Member', colour: '', rank: 0, can: [] },
]

export class Authority {
  constructor(
    readonly founder: string,
    private readonly levels: Map<string, Level>,
    private readonly placed: Map<string, string>,
    readonly kickedAt: Map<string, number>,
    /** Who is banned now: removed, and the space's old invites closed to them. */
    readonly bannedAt: Map<string, number> = new Map(),
    /** When each person removed was let back in. */
    readonly letBackAt: Map<string, number> = new Map(),
    /** Every ban there has been, in order, those since lifted too. */
    readonly bans: number[] = [],
    /** When each removal still standing came to this device: see RoomLog.arrivedAt. */
    readonly kickedArrival: Map<string, number> = new Map(),
  ) {}

  /**
   * Whether what this person wrote is left out because they were removed: written after the
   * removal by its place in the log, or come after the removal did, whatever place it claims.
   */
  removedBy(author: string, lamport: number, arrived: number): boolean {
    const at = this.kickedAt.get(author)
    if (at === undefined) return false
    return lamport > at || arrived > (this.kickedArrival.get(author) ?? Infinity)
  }

  isBanned(key: string): boolean {
    return this.bannedAt.has(key)
  }

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

  roleOf(key: string): Role {
    return this.kickedAt.has(key) ? 'kicked' : this.levelOf(key).id
  }

  isKicked(key: string): boolean {
    return this.kickedAt.has(key)
  }

  can(key: string, what: Permission): boolean {
    return !this.kickedAt.has(key) && this.levelOf(key).can.includes(what)
  }

  mayPlace(who: string, subject: string): boolean {
    return (
      subject !== this.founder && this.can(who, 'levels') && this.levelOf(subject).rank <= this.levelOf(who).rank
    )
  }

  mayRemove(who: string, subject: string): boolean {
    return (
      subject !== this.founder &&
      who !== subject &&
      this.can(who, 'remove') &&
      this.levelOf(subject).rank <= this.levelOf(who).rank
    )
  }

  /** Whether this person may put somebody on this level: none above theirs, and none that can do more than they can. */
  mayGive(who: string, level: Level): boolean {
    const mine = this.levelOf(who)
    return level.rank <= mine.rank && level.can.every((p) => mine.can.includes(p))
  }

  /** The owner's own level: only its name and colour, and only by the owner. */
  mayEdit(who: string, level: Level): boolean {
    if (level.id === OWNER) return !!who && who === this.founder
    return this.can(who, 'levels') && level.rank < this.levelOf(who).rank
  }
}

function cleanLevelIds(raw: unknown[]): string[] {
  const ids = raw.map(String).filter((id) => /^[a-z0-9]{1,16}$/.test(id) && id !== OWNER)
  return [...new Set(ids)].slice(0, 32)
}

/** The owner and whoever looks after channels see them all, so they can open one up again. */
function mayEnter(auth: Authority, key: string, channel: { levels: string[] }): boolean {
  if (channel.levels.length === 0) return true
  if (!key || auth.isKicked(key)) return false
  return key === auth.founder || auth.can(key, 'channels') || channel.levels.includes(auth.levelOf(key).id)
}

/** A note kept to some levels opens to them, to its maker, and to whoever may keep a channel. */
function mayOpenNote(auth: Authority, key: string, note: WhiteboardInfo): boolean {
  return note.levels.length === 0 || key === note.maker || mayEnter(auth, key, note)
}

function cleanColour(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return /^#[0-9a-f]{6}$/.test(text) ? text : ''
}

export const DEFAULT_CHANNEL = 'general'
export const DEFAULT_VOICE = 'lounge'

export interface LogEvent {
  /** SHA-256 of the canonical form. */
  id: string
  room: string
  author: string
  lamport: number
  kind: EventKind
  /** Author's wall clock: shown, never used for ordering. */
  at: number
  body: Record<string, unknown>
  sig: string
}

// Body as JSON bytes: sealed and base64 encoded, it must fit one 64 KiB archive line.
export const MAX_BODY = 48_000

export const MAX_TEXT = 46_000

// Plaintext budget: sealed and base64 encoded, a DM body stays inside MAX_BODY.
export const MAX_DM_BYTES = 34_000

const encoder = new TextEncoder()

function trimUntil(text: string, max: number, measure: (s: string) => number): string {
  let out = text
  while (out.length > 0) {
    const over = measure(out) - max
    if (over <= 0) return out
    out = out.slice(0, Math.max(0, out.length - Math.max(1, Math.ceil(over / 4))))
  }
  return out
}

export function trimToWire(text: string, max: number): string {
  return trimUntil(text, max, (s) => encoder.encode(JSON.stringify(s)).length)
}

export function trimToBytes(text: string, max: number): string {
  return trimUntil(text, max, (s) => encoder.encode(s).length)
}

/** The exact bytes that get hashed. Field order is part of the format. */
function canonical(e: Omit<LogEvent, 'id' | 'sig'>): string {
  return JSON.stringify([e.room, e.author, e.lamport, e.kind, e.at, e.body])
}

async function hash(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))))
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

/** Deeper than any event the app writes, and far short of what stringify or a worker can carry. */
const MAX_DEPTH = 24
const MAX_NODES = 20_000
/**
 * Keys that change how a value turns into a string or a number, or what it inherits. An object
 * that has one of its own makes String() throw, and every fold of the log reads bodies that way.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'toString', 'valueOf', 'toLocaleString', 'toJSON'])

/**
 * Whether a value from the wire is plain enough to fold: shallow, not huge, and with no key that
 * changes what it turns into. Walked without recursion, so a value nested thousands deep cannot
 * overflow the stack here. One that is not is dropped whole, as if it never came.
 */
export function plainEnough(value: unknown): boolean {
  const stack: [unknown, number][] = [[value, 0]]
  let nodes = 0
  while (stack.length) {
    const [v, depth] = stack.pop()!
    if (v === null || typeof v !== 'object') continue
    if (depth >= MAX_DEPTH || ++nodes > MAX_NODES) return false
    if (Array.isArray(v)) {
      for (const item of v) stack.push([item, depth + 1])
      continue
    }
    for (const key of Object.keys(v)) {
      if (UNSAFE_KEYS.has(key)) return false
      stack.push([(v as Record<string, unknown>)[key], depth + 1])
    }
  }
  return true
}

export async function openEvent(raw: unknown, room: string): Promise<LogEvent | null> {
  try {
    return await openChecked(raw, room)
  } catch {
    // One bad line is dropped. It must never take the rest of its page down with it.
    return null
  }
}

async function openChecked(raw: unknown, room: string): Promise<LogEvent | null> {
  if (!raw || typeof raw !== 'object' || !plainEnough(raw)) return null
  const e = { ...(raw as Partial<LogEvent>) }
  // Room and id are never read from the wire: hashing the supplied room stops replay into another space.
  e.room = room
  if (typeof e.sig !== 'string' || !/^[0-9a-f]{128}$/.test(e.sig)) return null
  if (typeof e.author !== 'string' || !/^[0-9a-f]{64}$/.test(e.author)) return null
  if (typeof e.lamport !== 'number' || !Number.isInteger(e.lamport) || e.lamport < 0) return null
  // A place far past any clock: it would stay the newest in its channel, ahead of all that comes.
  if (e.lamport > Date.now() + MAX_FUTURE_MS) return null
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return null
  if (typeof e.kind !== 'string' || !KNOWN_KINDS.has(e.kind)) return null
  if (!e.body || typeof e.body !== 'object' || Array.isArray(e.body)) return null

  const body = e.body as Record<string, unknown>
  if (encoder.encode(JSON.stringify(body)).length > MAX_BODY) return null

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

const CLEARABLE = new Set<EventKind>(['said', 'edit', 'react', 'retract', 'pin', 'poll', 'vote', 'relocate'])

// A 48 px WebP thumbnail is about 1500 characters.
export const MAX_AVATAR = 2600

// A space's picture is drawn larger than a person's, so it may be bigger: 96 px of WebP.
export const MAX_SPACE_PICTURE = 9000

export function cleanSpacePicture(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  if (!text || text.length > MAX_SPACE_PICTURE) return ''
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(text) ? text : ''
}

// A profile's cover is drawn across the top of its card: 480 x 108 px of WebP.
export const MAX_COVER = 24_000

export function cleanCover(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  if (!text || text.length > MAX_COVER) return ''
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(text) ? text : ''
}

export function cleanAvatar(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  if (!text || text.length > MAX_AVATAR) return ''
  // No SVG: it is a document that can carry script, and this ends up in a src.
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(text) ? text : ''
}

const MAX_CLOCK_LEAD_MS = 5 * 60 * 1000
/** An event placed further ahead of this device's clock than this is not taken. */
const MAX_FUTURE_MS = 30 * 24 * 60 * 60 * 1000

function compare(a: LogEvent, b: LogEvent): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  if (a.author !== b.author) return a.author < b.author ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export class RoomLog {
  readonly room: string
  me = ''
  // Trust on first use: pinned the first time this device sees the space.
  founder = ''
  private readonly byId = new Map<string, LogEvent>()
  /**
   * The order events came to this device: the order the server kept them, as a page is read from
   * the start each time. A place in the log is the writer's to pick; this order is not.
   */
  private readonly arrival = new Map<string, number>()
  /** The furthest place yet. What this device writes goes just after it. */
  private furthest = -1
  private clock = 0
  private ordered: LogEvent[] | null = null
  /** Whether `ordered` went out since the last add: then an add copies it, and does not push. */
  private orderedShared = false
  private memoFrom: LogEvent[] | null = null
  private memoFounder = ''
  private readonly memo = new Map<string, unknown>()

  constructor(room: string) {
    this.room = room
  }

  nextLamport(): number {
    return Math.max(this.clock + 1, Date.now())
  }

  /**
   * Returns true when the event was new. `place` is where it came among the lines the server
   * sent, which is the order it kept them. One with no place, as this device's own, goes after
   * everything here so far.
   */
  add(event: LogEvent, place?: number): boolean {
    if (this.byId.has(event.id)) return false
    this.byId.set(event.id, event)
    const at = place ?? this.furthest + 1e-6
    if (at > this.furthest) this.furthest = at
    this.arrival.set(event.id, at)
    this.advance(event.lamport)
    const ordered = this.ordered
    if (ordered && (ordered.length === 0 || compare(ordered[ordered.length - 1], event) < 0)) {
      // A new array once it went out: holders of the old one, and the memo, rely on it never
      // changing. Until then a push, so a page of events added in a row is not copied each time.
      if (this.orderedShared) {
        this.ordered = [...ordered, event]
        this.orderedShared = false
      } else {
        ordered.push(event)
      }
    } else {
      this.ordered = null
    }
    return true
  }

  /** Where an event came in the order this device got them. */
  arrivedAt(id: string): number {
    return this.arrival.get(id) ?? Infinity
  }

  private advance(lamport: number): void {
    const capped = Math.min(lamport, Date.now() + MAX_CLOCK_LEAD_MS)
    if (capped > this.clock) this.clock = capped
  }

  /** Computed once per state of the log. Callers must not mutate what it returns. */
  private cached<T>(key: string, make: () => T): T {
    const all = this.everything()
    if (this.memoFrom !== all || this.memoFounder !== this.founder) {
      this.memo.clear()
      this.memoFrom = all
      this.memoFounder = this.founder
    }
    if (!this.memo.has(key)) this.memo.set(key, make())
    return this.memo.get(key) as T
  }

  authority(): Authority {
    return this.cached('authority', () => this.foldAuthority())
  }

  /**
   * Who may do what. In the agreed order, each change is checked against who could make it at
   * that point. The place an event claims is its writer's to pick, so on its own a person who
   * was removed, or put on a lower level, could sign a change with a place just before that, and
   * undo it. So a change to somebody is first judged against only what had come before it; if it
   * stands then, what that person signs later with a place before it does not count.
   */
  private foldAuthority(): Authority {
    return this.foldAuthorityOf(this.authorityEvents()).auth
  }

  /** The changes to levels that count, in the agreed order. */
  private authorityEvents(): LogEvent[] {
    return this.cached('authorityEvents', () => {
      const events = this.everything().filter((e) => e.kind === 'level' || e.kind === 'role')
      const dropped = this.backdated(events)
      return dropped.size ? events.filter((e) => !dropped.has(e.id)) : events
    })
  }

  /** Who could do what just before this place in the log. */
  private authorityAt(lamport: number): Authority {
    return this.cached(`authorityAt:${lamport}`, () =>
      this.foldAuthorityOf(this.authorityEvents().filter((e) => e.lamport < lamport)).auth,
    )
  }

  /** The changes signed with a place before a change to their writer that had already come. */
  private backdated(events: LogEvent[]): Set<string> {
    const dropped = new Set<string>()
    const subjectOf = (e: LogEvent): string => (e.kind === 'role' && typeof e.body.subject === 'string' ? e.body.subject : '')
    // Changes to somebody by somebody else, and whether anything of theirs came after with an earlier place.
    const about = events.filter((d) => {
      const subject = subjectOf(d)
      if (!PERSON_KEY.test(subject) || subject === d.author) return false
      const came = this.arrivedAt(d.id)
      return events.some((e) => e.author === subject && e.lamport < d.lamport && this.arrivedAt(e.id) > came)
    })
    if (about.length === 0) return dropped
    about.sort((a, b) => this.arrivedAt(a.id) - this.arrivedAt(b.id))
    for (const d of about) {
      if (dropped.has(d.id)) continue
      const came = this.arrivedAt(d.id)
      const before = events.filter((e) => !dropped.has(e.id) && this.arrivedAt(e.id) <= came)
      if (!this.foldAuthorityOf(before).took.has(d.id)) continue
      const subject = subjectOf(d)
      for (const e of events) {
        if (e.author === subject && e.lamport < d.lamport && this.arrivedAt(e.id) > came) dropped.add(e.id)
      }
    }
    return dropped
  }

  private foldAuthorityOf(all: LogEvent[]): { auth: Authority; took: Set<string> } {
    const levels = new Map<string, Level>(STARTING_LEVELS.map((l) => [l.id, { ...l, can: [...l.can] }]))
    const placed = new Map<string, string>()
    const kickedAt = new Map<string, number>()
    const kickedArrival = new Map<string, number>()
    const founder = this.founder
    const bannedAt = new Map<string, number>()
    const letBackAt = new Map<string, number>()
    const bans: number[] = []
    const auth = new Authority(founder, levels, placed, kickedAt, bannedAt, letBackAt, bans, kickedArrival)
    const took = new Set<string>()

    const step = (e: LogEvent): boolean => {
      if (e.kind === 'level') {
        const id = String(e.body.id ?? '')
        if (!/^[a-z0-9]{1,16}$/.test(id)) return false
        const was = levels.get(id)
        if (id === OWNER) {
          // A name and a colour: what the owner may do, and where the level sits, never change.
          const name = String(e.body.name ?? '').slice(0, 24).trim()
          if (!was || !auth.mayEdit(e.author, was) || e.body.gone === true || !name) return false
          levels.set(id, { ...was, name, colour: cleanColour(e.body.colour) })
          return true
        }
        if (was && !auth.mayEdit(e.author, was)) return false
        if (!was && !auth.can(e.author, 'levels')) return false
        const mine = auth.levelOf(e.author)
        if (e.body.gone === true) {
          if (id === MEMBER || !was) return false
          levels.delete(id)
          for (const [key, at] of placed) if (at === id) placed.delete(key)
          return true
        }
        const name = String(e.body.name ?? '').slice(0, 24).trim()
        if (!name) return false
        const rank = id === MEMBER ? 0 : Number(e.body.rank)
        if (!Number.isFinite(rank) || (id !== MEMBER && (rank <= 0 || rank >= mine.rank))) return false
        const asked = Array.isArray(e.body.can) ? e.body.can.map(String) : []
        const can = ALL.filter((p) => asked.includes(p) && mine.can.includes(p))
        levels.set(id, { id, name, colour: cleanColour(e.body.colour), rank, can })
        return true
      }
      if (e.kind !== 'role') return false
      const subject = String(e.body.subject ?? '')
      if (!/^[0-9a-f]{64}$/.test(subject) || subject === founder) return false
      const role = String(e.body.role ?? '')
      if (role === 'kicked') {
        if (!auth.mayRemove(e.author, subject)) return false
        kickedAt.set(subject, e.lamport)
        kickedArrival.set(subject, this.arrivedAt(e.id))
        if (e.body.ban === true) {
          bannedAt.set(subject, e.lamport)
          bans.push(e.lamport)
        }
        return true
      }
      const level = levels.get(role)
      if (!level || level.id === OWNER) return false
      if (kickedAt.has(subject)) {
        if (!auth.mayRemove(e.author, subject) && !auth.mayPlace(e.author, subject)) return false
        kickedAt.delete(subject)
        kickedArrival.delete(subject)
        bannedAt.delete(subject)
        letBackAt.set(subject, e.lamport)
        if (level.id === MEMBER) {
          placed.delete(subject)
          return true
        }
      }
      if (!auth.mayPlace(e.author, subject) || !auth.mayGive(e.author, level)) return false
      if (level.id === MEMBER) placed.delete(subject)
      else placed.set(subject, level.id)
      return true
    }

    for (const e of all) if (step(e)) took.add(e.id)
    return { auth, took }
  }

  roles(): Map<string, Role> {
    return this.cached('roles', () => this.foldRoles())
  }

  private foldRoles(): Map<string, Role> {
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

  can(key: string, what: Permission): boolean {
    return this.authority().can(key, what)
  }

  resetAt(): number {
    return this.cached('resetAt', () => this.foldResetAt())
  }

  private foldResetAt(): number {
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

  closed(): boolean {
    return this.cached('closed', () => this.foldClosed())
  }

  private foldClosed(): boolean {
    const auth = this.authority()
    for (const e of this.all()) {
      if (e.kind === 'close' && auth.can(e.author, 'space')) return true
    }
    return false
  }

  pinned(): Set<string> {
    const auth = this.authority()
    const on = new Set<string>()
    for (const e of this.all()) {
      if (e.kind !== 'pin') continue
      if (!auth.can(e.author, 'pin')) continue
      const target = String(e.body.target ?? '')
      if (!/^[0-9a-f]{64}$/.test(target)) continue
      if (e.body.on === false) on.delete(target)
      else on.add(target)
    }
    return on
  }

  roleOf(pubkey: string): Role {
    return this.authority().roleOf(pubkey)
  }

  spaceName(): string {
    return this.cached('spaceName', () => this.foldSpaceName())
  }

  /** The space's picture, or '' for its initials. The newest one from a level that may change the space wins. */
  spacePicture(): string {
    return this.cached('spacePicture', () => {
      let picture = ''
      const auth = this.authority()
      for (const e of this.all()) {
        if (e.kind !== 'space' || !('picture' in e.body)) continue
        if (!auth.can(e.author, 'space')) continue
        picture = cleanSpacePicture(e.body.picture)
      }
      return picture
    })
  }

  private foldSpaceName(): string {
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

  /** Every event in agreed order, even from people a ban keeps out. Shared: never mutate it. */
  everything(): LogEvent[] {
    this.ordered ??= [...this.byId.values()].sort(compare)
    this.orderedShared = true
    return this.ordered
  }

  /**
   * Every event that counts, in agreed order. After a ban, what people without admission
   * write is left out: they came in with an old invite. Shared: never mutate it.
   */
  all(): LogEvent[] {
    return this.cached('visible', () => {
      const ok = this.admitted()
      const raw = this.everything()
      const hooks = new Set(this.hooks().map((hook) => hook.pub))
      // A webhook only posts. Its key is in the log, so anything else signed with it is not its own.
      const asHook = (e: LogEvent): boolean => HOOK_KINDS.has(e.kind)
      if (!ok) return hooks.size === 0 ? raw : raw.filter((e) => !hooks.has(e.author) || asHook(e))
      const auth = this.authority()
      // A removed person's own events stay: the removal already decides what of theirs is shown.
      return raw.filter((e) =>
        hooks.has(e.author)
          ? asHook(e)
          : ok.has(e.author) || auth.isKicked(e.author) || e.kind === 'key' || e.kind === 'join',
      )
    })
  }

  /**
   * The ban whose new key is made, and that key's place in keyEpochs(). A ban whose key is still
   * to come waits: until then the ban before it stands.
   */
  private banEpoch(): { ban: number; at: number } | null {
    return this.cached('banEpoch', () => {
      const bans = this.authority().bans
      const epochs = this.keyEpochs()
      for (let i = bans.length - 1; i >= 0; i--) {
        const at = epochs.findIndex((e) => e.covers >= bans[i])
        if (at >= 0) return { ban: bans[i], at }
      }
      return null
    })
  }

  /** Whether somebody was ever banned here, so the code alone no longer lets a person in. */
  invitesClosed(): boolean {
    return this.banEpoch() !== null
  }

  /**
   * After a ban, the people let in: whoever made the space, whoever may remove people, whoever
   * was let back in since, and whoever was given the key made for the ban or a newer one by
   * somebody already let in. Null when nobody was banned: then the code lets anybody in.
   */
  admitted(): Set<string> | null {
    return this.cached('admitted', () => {
      const found = this.banEpoch()
      if (!found) return null
      const auth = this.authority()
      const ids = new Set(this.keyEpochs().slice(found.at).map((e) => e.id))
      const out = new Set<string>(this.founder ? [this.founder] : [])
      for (const [key, when] of auth.letBackAt) if (when > found.ban) out.add(key)
      const copies = this.everything().filter((e) => e.kind === 'key' && ids.has(String(e.body.id ?? '')))
      // Round again while it grows: a copy counts once its giver counts.
      for (let grew = true; grew; ) {
        grew = false
        for (const e of copies) {
          if (!out.has(e.author) && !auth.can(e.author, 'remove')) continue
          const boxes = e.body.boxes
          if (!boxes || typeof boxes !== 'object') continue
          for (const person of Object.keys(boxes)) {
            if (!PERSON_KEY.test(person) || out.has(person)) continue
            out.add(person)
            grew = true
          }
        }
      }
      for (const key of [...out]) if (auth.isKicked(key)) out.delete(key)
      return out
    })
  }

  /** The keys made for the ban and after it: after a ban, a signal under an older key is not heard. */
  keysSinceBan(): string[] {
    const found = this.banEpoch()
    return found ? this.keyEpochs().slice(found.at).map((e) => e.id) : []
  }

  /** Passes in invites made since the ban, by people let in. A newcomer shows one to get the key. */
  passes(): string[] {
    return this.cached('passes', () => {
      const found = this.banEpoch()
      const ok = this.admitted()
      if (!found || !ok) return []
      const auth = this.authority()
      const out = new Set<string>()
      for (const e of this.everything()) {
        if (e.kind !== 'invite' || e.lamport <= found.ban) continue
        if (!ok.has(e.author) && !auth.can(e.author, 'remove')) continue
        const pass = cleanPass(e.body.pass)
        if (pass) out.add(pass)
      }
      return [...out]
    })
  }

  /** The newest pass this person put in an invite since the ban, or ''. */
  passOf(author: string): string {
    const found = this.banEpoch()
    if (!found) return ''
    const events = this.everything()
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.lamport <= found.ban) break
      if (e.kind === 'invite' && e.author === author && cleanPass(e.body.pass)) return cleanPass(e.body.pass)
    }
    return ''
  }

  /** What each person showed when they came in with an invite made after a ban. */
  joins(): Map<string, string[]> {
    return this.cached('joins', () => {
      const out = new Map<string, string[]>()
      for (const e of this.everything()) {
        if (e.kind !== 'join') continue
        const proof = String(e.body.proof ?? '')
        if (!/^[0-9a-f]{64}$/.test(proof)) continue
        out.set(e.author, [...(out.get(e.author) ?? []), proof].slice(-8))
      }
      return out
    })
  }

  /** The channels you may see. */
  channels(voice = false): string[] {
    return this.channelList(voice).map((c) => c.name)
  }

  /** The channels you may see, as `me`. */
  channelList(voice = false): ChannelInfo[] {
    const auth = this.authority()
    return this.everyChannel(voice).filter((c) => mayEnter(auth, this.me, c))
  }

  /** Whether this person may see and use this channel. */
  mayEnter(key: string, name: string, voice = false): boolean {
    const info = this.everyChannel(voice).find((c) => c.name === name)
    return !info || mayEnter(this.authority(), key, info)
  }

  /** Deleted by somebody who could, and not made again since. A channel not heard of yet is not. */
  wasDropped(name: string, voice = false): boolean {
    return this.cached(voice ? 'voiceDropped' : 'textDropped', () => {
      const auth = this.authority()
      const gone = new Set<string>()
      for (const e of this.all()) {
        if (e.kind !== 'channel' || (e.body.voice === true) !== voice || !auth.can(e.author, 'channels')) continue
        const channel = cleanChannel(String(e.body.name ?? ''))
        if (e.body.gone === true) gone.add(channel)
        else gone.delete(channel)
      }
      return gone
    }).has(name)
  }

  /** Every channel, those kept to some levels too. */
  everyChannel(voice = false): ChannelInfo[] {
    return this.cached(voice ? 'voiceChannels' : 'textChannels', () => this.foldChannels(voice))
  }

  private foldChannels(voice: boolean): ChannelInfo[] {
    const defaultName = voice ? DEFAULT_VOICE : DEFAULT_CHANNEL
    const names = new Set<string>([defaultName])
    const label = new Map<string, string>()
    const topic = new Map<string, string>()
    const levels = new Map<string, string[]>()
    const nsfw = new Set<string>()
    const gone = new Set<string>()
    const auth = this.authority()
    /** The newest order somebody who keeps the channels put them in. */
    let order: string[] = []

    for (const e of this.all()) {
      if (e.kind === 'channel') {
        if (!auth.can(e.author, 'channels')) continue
        if ((e.body.voice === true) !== voice) continue
        if (Array.isArray(e.body.order)) {
          order = cleanOrder(e.body.order)
          continue
        }
        const name = cleanChannel(String(e.body.name ?? ''))
        if (!name) continue
        names.add(name)
        if (typeof e.body.label === 'string') {
          const shown = e.body.label.slice(0, 32).trim()
          if (shown) label.set(name, shown)
        }
        if (typeof e.body.topic === 'string') topic.set(name, e.body.topic.slice(0, 140).trim())
        if (Array.isArray(e.body.levels)) levels.set(name, cleanLevelIds(e.body.levels))
        if (e.body.nsfw === true) nsfw.add(name)
        else if (e.body.nsfw === false) nsfw.delete(name)
        if (e.body.gone === true) gone.add(name)
        else gone.delete(name)
      } else if (!voice && e.kind === 'said' && auth.can(e.author, 'channels')) {
        names.add(channelOf(e))
      }
    }

    gone.delete(defaultName)
    // Everybody lands in the default channels, so they stay open to all.
    levels.delete(defaultName)

    // In the order they were put in, and any channel it does not name after them, by name.
    const place = new Map(order.map((name, at) => [name, at]))
    const rank = (name: string): number => place.get(name) ?? Number.MAX_SAFE_INTEGER
    return [...names]
      .filter((name) => !gone.has(name))
      .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
      .map((name) => ({
        name,
        label: label.get(name) || name,
        topic: topic.get(name) ?? '',
        levels: levels.get(name) ?? [],
        nsfw: nsfw.has(name),
      }))
  }

  /**
   * Shared notes. Anybody still in the space may write; the maker or a channel keeper may delete
   * one, or keep it to some levels. A kept note is out of sight for everybody else, and what they
   * write to it is ignored. Anybody with the space's key can still open the lines.
   */
  notes(): NoteInfo[] {
    return this.cached('notes', () => this.foldNotes('note'))
  }

  /**
   * Shared whiteboards: kept, seen and deleted as a note is. What is drawn on one is in
   * whiteboardRecords.
   */
  whiteboards(): WhiteboardInfo[] {
    return this.cached('whiteboards', () => this.foldNotes('whiteboard').map(({ text: _, ...board }) => board))
  }

  /**
   * The tldraw records on a whiteboard: its shapes, the arrows' bindings, and its pages. The last
   * write to a record, in the order of the log, wins, so every device ends on the same board. A
   * record taken away stays as { id, gone: true }, so a device that still has it lets it go.
   */
  whiteboardRecords(id: string): WhiteboardEntry[] {
    return this.cached(`whiteboardRecords:${id}`, () => {
      const board = this.whiteboards().find((b) => b.id === id)
      if (!board) return []
      const auth = this.authority()
      const hooks = new Set(this.hooks().map((hook) => hook.pub))
      const records = new Map<string, WhiteboardEntry>()
      for (const e of this.all()) {
        if (e.kind !== 'whiteboard' || e.body.id !== id || !Array.isArray(e.body.records)) continue
        if (auth.isKicked(e.author) || hooks.has(e.author) || !mayOpenNote(auth, e.author, board)) continue
        for (const raw of e.body.records.slice(0, MAX_RECORDS_PER_EVENT)) {
          const entry = cleanWhiteboardEntry(raw)
          if (entry) records.set(entry.id, entry)
        }
      }
      return [...records.values()]
    })
  }

  /** The notes and the whiteboards, which are kept the same way. */
  private foldNotes(kind: 'note' | 'whiteboard'): NoteInfo[] {
    const auth = this.authority()
    const notes = new Map<string, NoteInfo>()
    const gone = new Set<string>()
    const hooks = new Set(this.hooks().map((hook) => hook.pub))
    // Its maker wrote to it first, in the order the server kept them. Not first by place, which
    // anybody can sign as earlier, and so take a note over.
    const makers = new Map<string, string>()
    const arrived = this.all()
      .filter((e) => e.kind === kind && e.body.gone !== true)
      .sort((a, b) => this.arrivedAt(a.id) - this.arrivedAt(b.id))
    for (const e of arrived) {
      const id = cleanNoteId(e.body.id)
      if (id && !makers.has(id)) makers.set(id, e.author)
    }
    for (const e of this.all()) {
      if (e.kind !== kind || auth.isKicked(e.author) || hooks.has(e.author)) continue
      const id = cleanNoteId(e.body.id)
      if (!id || gone.has(id)) continue
      let note = notes.get(id)
      if (!note) {
        if (e.body.gone === true) continue
        const maker = makers.get(id) ?? e.author
        note = { id, title: 'Untitled', text: '', maker, by: e.author, at: e.at, lamport: e.lamport, levels: [] }
        notes.set(id, note)
      }
      const keeper = e.author === note.maker || auth.can(e.author, 'channels')
      if (e.body.gone === true) {
        if (!keeper) continue
        notes.delete(id)
        gone.add(id)
        continue
      }
      if (!mayOpenNote(auth, e.author, note)) continue
      if (Array.isArray(e.body.levels) && keeper) note.levels = cleanLevelIds(e.body.levels)
      if (typeof e.body.title === 'string') note.title = cleanNoteTitle(e.body.title) || 'Untitled'
      if (kind === 'note' && typeof e.body.text === 'string') note.text = e.body.text.slice(0, MAX_TEXT)
      const changed = typeof e.body.title === 'string' || (kind === 'note' ? typeof e.body.text === 'string' : Array.isArray(e.body.records))
      if (!changed) continue
      note.by = e.author
      note.at = e.at
      note.lamport = e.lamport
    }
    return [...notes.values()]
      .filter((note) => mayOpenNote(auth, this.me, note))
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  /** Sounds people added to the soundboard. The adder or a channel keeper may rename one or take it off. */
  boardSounds(): BoardSound[] {
    return this.cached('board', () => {
      const auth = this.authority()
      const sounds = new Map<string, BoardSound>()
      const gone = new Set<string>()
      for (const e of this.all()) {
        if (e.kind !== 'board' || e.body.group === true || auth.isKicked(e.author)) continue
        // Only somebody whose level has the soundboard adds to it, or changes a sound on it.
        if (e.body.gone !== true && !auth.can(e.author, 'soundboard')) continue
        const id = cleanNoteId(e.body.id)
        if (!id || gone.has(id)) continue
        const had = sounds.get(id)
        if (e.body.gone === true) {
          if (!had || (e.author !== had.maker && !auth.can(e.author, 'channels'))) continue
          sounds.delete(id)
          gone.add(id)
          continue
        }
        // A move to another group: anybody who may add a sound may sort the board.
        if (had && typeof e.body.in === 'string' && e.body.label === undefined) {
          sounds.set(id, { ...had, group: cleanNoteId(e.body.in) })
          continue
        }
        if (had) {
          // A new name or emoji, from whoever added it or a channel keeper. The sound stays.
          if (e.author !== had.maker && !auth.can(e.author, 'channels')) continue
          const label = String(e.body.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
          const emoji = oneEmoji(String(e.body.emoji ?? ''))
          sounds.set(id, { ...had, label: label || had.label, emoji: emoji || had.emoji })
          continue
        }
        const file = cleanFiles([e.body.file])[0]
        if (!file || sounds.size >= MAX_BOARD_SOUNDS) continue
        const label = String(e.body.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Sound'
        const emoji = oneEmoji(String(e.body.emoji ?? '')) || '🔊'
        sounds.set(id, { id, label, emoji, file, maker: e.author, group: cleanNoteId(e.body.in) })
      }
      return [...sounds.values()]
    })
  }

  /**
   * The groups the soundboard is sorted into. Anybody who may add a sound may make one; its maker or
   * a channel keeper may rename it or take it off, and its sounds then stand outside any group.
   */
  boardGroups(): BoardGroup[] {
    return this.cached('board-groups', () => {
      const auth = this.authority()
      const groups = new Map<string, BoardGroup>()
      const gone = new Set<string>()
      for (const e of this.all()) {
        if (e.kind !== 'board' || e.body.group !== true || auth.isKicked(e.author)) continue
        if (e.body.gone !== true && !auth.can(e.author, 'soundboard')) continue
        const id = cleanNoteId(e.body.id)
        if (!id || gone.has(id)) continue
        const had = groups.get(id)
        if (had && e.author !== had.maker && !auth.can(e.author, 'channels')) continue
        if (e.body.gone === true) {
          if (!had) continue
          groups.delete(id)
          gone.add(id)
          continue
        }
        const label = String(e.body.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
        const emoji = oneEmoji(String(e.body.emoji ?? ''))
        if (had) {
          groups.set(id, { ...had, label: label || had.label, emoji: emoji || had.emoji })
          continue
        }
        if (groups.size >= MAX_BOARD_GROUPS) continue
        groups.set(id, { id, label: label || 'Group', emoji: emoji || '📁', maker: e.author })
      }
      return [...groups.values()]
    })
  }

  /** Channels that are there, but kept from you or from whoever writes in them. */
  private keptChannels(): Map<string, ChannelInfo> {
    return new Map(this.everyChannel().filter((c) => c.levels.length > 0).map((c) => [c.name, c]))
  }

  private deletedChannels(): Set<string> {
    const live = new Set(this.everyChannel().map((c) => c.name))
    const gone = new Set<string>()
    const auth = this.authority()
    for (const e of this.all()) {
      if (e.kind !== 'channel' || !auth.can(e.author, 'channels')) continue
      if (e.body.voice === true) continue
      const name = cleanChannel(String(e.body.name ?? ''))
      if (name && !live.has(name)) gone.add(name)
    }
    return gone
  }

  /**
   * Where each moved message is now, by its id. The newest move stands. Its writer may move
   * it, and so may whoever may move messages, to a channel there is that the mover may enter.
   * It keeps its time.
   */
  private moved(auth: Authority): Map<string, string> {
    const writers = new Map<string, string>()
    const to = new Map<string, string>()
    const there = new Map(this.everyChannel().map((c) => [c.name, c]))
    const hooks = new Set(this.hooks().map((hook) => hook.pub))
    for (const e of this.all()) {
      if (e.kind === 'said' || e.kind === 'poll') {
        writers.set(e.id, e.author)
        continue
      }
      // Anybody can sign as a webhook: its key is in the log. It moves nothing, its own posts neither.
      if (e.kind !== 'relocate' || hooks.has(e.author)) continue
      if (auth.removedBy(e.author, e.lamport, this.arrivedAt(e.id))) continue
      const target = String(e.body.target ?? '')
      const writer = writers.get(target)
      if (!writer || (e.author !== writer && !auth.can(e.author, 'relocate'))) continue
      const channel = cleanChannel(String(e.body.channel ?? ''))
      const info = there.get(channel)
      if (info && mayEnter(auth, e.author, info)) to.set(target, channel)
    }
    return to
  }

  /**
   * Pass a channel to get what its readers see, thread replies excluded. Computed once per state
   * of the log, so callers must not change the list, and only set `name` on a message.
   */
  messages(channel?: string): Message[] {
    const all = this.cached('messages', () => this.foldMessages())
    if (!channel) return all
    return this.cached(`messages:${channel}`, () => all.filter((m) => m.channel === channel && !m.inThread))
  }

  private foldMessages(): Message[] {
    const out: Message[] = []
    const index = new Map<string, Message>()
    const names = new Map<string, string>()
    const auth = this.authority()
    const cleared = this.resetAt()
    const removed = this.deletedChannels()
    const kept = this.keptChannels()
    const moved = this.moved(auth)
    const hookBy = new Map(this.hooks().map((hook) => [hook.pub, hook]))
    // What a webhook posts after it stopped, or after it was deleted, is not shown.
    const hookLate = (e: LogEvent, hook: HookInfo): boolean =>
      (hook.stoppedAt !== null && e.lamport > hook.stoppedAt) || (hook.goneAt !== null && e.lamport > hook.goneAt)
    // A thread's replies go where their first message goes.
    const placeOf = (e: LogEvent): string =>
      moved.get(e.id) ??
      (e.body.thread === true && typeof e.body.replyTo === 'string' ? moved.get(e.body.replyTo) : undefined) ??
      channelOf(e)
    // Not for you to read, or written by somebody it is not for. Anybody with the space's
    // key can still open these lines; the app only keeps them out of sight.
    const shut = (e: LogEvent): boolean => {
      const info = kept.get(placeOf(e))
      // A webhook posts only into its own channel, so it counts as let in there.
      return !!info && (!mayEnter(auth, this.me, info) || (!hookBy.has(e.author) && !mayEnter(auth, e.author, info)))
    }

    for (const e of this.all()) {
      if (e.lamport < cleared && CLEARABLE.has(e.kind)) continue
      const hook = hookBy.get(e.author)
      if (hook && (hookLate(e, hook) || (e.kind !== 'said' && e.kind !== 'edit' && e.kind !== 'retract'))) continue
      if (hook && e.kind === 'said' && channelOf(e) !== hook.channel) continue
      if (auth.removedBy(e.author, e.lamport, this.arrivedAt(e.id))) continue
      if (e.kind === 'profile') {
        const name = String(e.body.name ?? '').slice(0, 24)
        if (name) names.set(e.author, name)
        continue
      }
      if (e.kind === 'poll') {
        if (removed.has(placeOf(e)) || shut(e)) continue
        const question = String(e.body.question ?? '').slice(0, 200).trim()
        const raw = Array.isArray(e.body.options) ? e.body.options : []
        const options = raw
          .map((o) => String(o).slice(0, 80).trim())
          .filter(Boolean)
          .slice(0, 6)
        if (!question || options.length < 2) continue
        const message: Message = {
          id: e.id,
          author: e.author,
          at: e.at,
          lamport: e.lamport,
          channel: placeOf(e),
          text: question,
          replyTo: null,
          edited: false,
          retracted: false,
          reactions: new Map(),
          poll: { question, options, votes: new Map(), mine: null, total: 0 },
        }
        index.set(e.id, message)
        out.push(message)
        continue
      }
      if (e.kind === 'vote') {
        const target = index.get(String(e.body.target ?? ''))
        if (!target?.poll) continue
        const choice = Number(e.body.choice)
        if (!Number.isInteger(choice) || choice < 0 || choice >= target.poll.options.length) continue
        for (const who of target.poll.votes.values()) who.delete(e.author)
        const set = target.poll.votes.get(choice) ?? new Set<string>()
        set.add(e.author)
        target.poll.votes.set(choice, set)
        continue
      }
      if (e.kind === 'said') {
        if (removed.has(placeOf(e)) || shut(e)) continue
        const message: Message = {
          id: e.id,
          author: e.author,
          at: e.at,
          lamport: e.lamport,
          channel: placeOf(e),
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
        if (hook) {
          message.hook = { id: hook.id, avatar: cleanWebAddress(e.body.avatar) }
          message.name = cleanHookName(e.body.name) || hook.name
          const embeds = cleanEmbeds(e.body.embeds)
          if (embeds.length) message.embeds = embeds
        }
        index.set(e.id, message)
        out.push(message)
        continue
      }
      if (e.kind !== 'edit' && e.kind !== 'retract' && e.kind !== 'react') continue
      const target = index.get(String(e.body.target ?? ''))
      if (!target) continue
      if (e.kind === 'edit') {
        if (e.author !== target.author) continue
        // A webhook's edit that leaves out the words keeps them, as Discord's does.
        if (!hook || e.body.text !== undefined) target.text = String(e.body.text ?? '')
        target.edited = true
        if (hook && Array.isArray(e.body.embeds)) {
          const embeds = cleanEmbeds(e.body.embeds)
          if (embeds.length) target.embeds = embeds
          else delete target.embeds
        }
      } else if (e.kind === 'retract') {
        if (e.author !== target.author && !auth.can(e.author, 'delete')) continue
        target.retracted = true
        target.text = ''
        target.files = []
        target.reactions.clear()
      } else {
        const emoji = oneEmoji(String(e.body.emoji ?? ''))
        if (!emoji) continue
        const who = target.reactions.get(emoji) ?? new Set<string>()
        if (e.body.on === false) who.delete(e.author)
        else who.add(e.author)
        if (who.size) target.reactions.set(emoji, who)
        else target.reactions.delete(emoji)
      }
    }

    const pins = this.pinned()
    const replies = new Map<string, number>()
    for (const m of out) {
      if (!m.hook) m.name = names.get(m.author) ?? ''
      m.pinned = pins.has(m.id)
      if (m.inThread && m.replyTo && !m.retracted) replies.set(m.replyTo, (replies.get(m.replyTo) ?? 0) + 1)
      if (!m.poll) continue
      let total = 0
      for (const [choice, who] of m.poll.votes) {
        total += who.size
        if (who.has(this.me)) m.poll.mine = choice
      }
      m.poll.total = total
    }
    for (const m of out) {
      const count = replies.get(m.id)
      if (count) m.replies = count
    }

    return out.filter((m) => !m.retracted)
  }

  /** Computed once per state of the log. Callers must not change what it returns. */
  threads(): ThreadInfo[] {
    return this.cached('threads', () => this.foldThreads())
  }

  private foldThreads(): ThreadInfo[] {
    const all = this.messages()
    const latest = new Map<string, { last: number; newest: number }>()
    for (const m of all) {
      if (!m.inThread || !m.replyTo) continue
      const was = latest.get(m.replyTo)
      if (!was) latest.set(m.replyTo, { last: m.at, newest: m.lamport })
      else {
        if (m.at > was.last) was.last = m.at
        if (m.lamport > was.newest) was.newest = m.lamport
      }
    }
    const out: ThreadInfo[] = []
    for (const root of all) {
      if (!root.replies) continue
      const reply = latest.get(root.id)
      const last = reply && reply.last > root.at ? reply.last : root.at
      const newest = reply && reply.newest > root.lamport ? reply.newest : root.lamport
      out.push({ root, replies: root.replies, last, newest })
    }
    return out.sort((a, b) => b.last - a.last)
  }

  thread(rootId: string): Message[] {
    const all = this.messages()
    const root = all.find((m) => m.id === rootId)
    if (!root) return []
    return [root, ...all.filter((m) => m.inThread && m.replyTo === rootId)]
  }

  /**
   * Where each person's devices take a notification while Nook is closed, and what they want
   * one for. The newest word from each device stands. Somebody removed gets none.
   */
  pushTargets(): Map<string, PushTarget[]> {
    return this.cached('pushTargets', () => {
      const auth = this.authority()
      const devices = new Map<string, PushTarget | null>()
      for (const e of this.all()) {
        if (e.kind !== 'push') continue
        const id = cleanNoteId(e.body.id)
        if (!id) continue
        devices.set(`${e.author}:${id}`, e.body.gone === true ? null : cleanPushTarget(e.author, id, e.body))
      }
      const out = new Map<string, PushTarget[]>()
      for (const target of devices.values()) {
        if (!target || auth.isKicked(target.person)) continue
        out.set(target.person, [...(out.get(target.person) ?? []), target])
      }
      return out
    })
  }

  /** The space's newer keys, oldest first: each made by somebody who may remove people. */
  /**
   * The webhooks: each posts as its own key, into one channel. Whoever may manage webhooks
   * makes, renames and deletes them, and a webhook may delete itself. When somebody is removed,
   * the space gets a new key and every webhook made before that stops: what it posts after the
   * removal is not shown. Its link has to be made again.
   */
  hooks(): HookInfo[] {
    return this.cached('hooks', () => {
      const auth = this.authority()
      const epochs = this.keyEpochs()
      const byId = new Map<string, HookInfo>()
      for (const e of this.everything()) {
        if (e.kind !== 'hook') continue
        const id = String(e.body.id ?? '')
        if (!HOOK_ID.test(id)) continue
        const held = byId.get(id)
        const manager = auth.can(e.author, 'webhooks')
        if (!held) {
          if (!manager) continue
          const pub = String(e.body.pub ?? '')
          const key = String(e.body.key ?? '')
          const seed = String(e.body.seed ?? '')
          const channel = cleanChannel(String(e.body.channel ?? ''))
          if (!PERSON_KEY.test(pub) || !/^[A-Za-z0-9+/]{43}=$/.test(key) || !/^[0-9a-f]{64}$/.test(seed) || !channel) continue
          // Its key is the one its seed makes. Otherwise a manager could name somebody's own key a
          // webhook's, and what that person writes would be taken for the webhook's.
          if (publicKeyOf(seed) !== pub) continue
          const stop = epochs.find((k) => k.covers > e.lamport)
          byId.set(id, {
            id,
            pub,
            key,
            seed,
            channel,
            name: cleanHookName(e.body.name) || 'Webhook',
            maker: e.author,
            made: e.lamport,
            stoppedAt: stop ? stop.covers : null,
            goneAt: null,
          })
          continue
        }
        if (held.goneAt !== null || !(manager || e.author === held.pub)) continue
        if (e.body.gone === true) held.goneAt = e.lamport
        else if (manager && typeof e.body.name === 'string') held.name = cleanHookName(e.body.name) || held.name
      }
      return [...byId.values()]
    })
  }

  keyEpochs(): { id: string; lamport: number; covers: number }[] {
    return this.cached('keyEpochs', () => {
      const out: { id: string; lamport: number; covers: number }[] = []
      const seen = new Set<string>()
      for (const e of this.everything()) {
        // Made by somebody who could remove people then: one put on a lower level later does not
        // undo the keys they made, and one raised later did not make theirs as somebody trusted.
        if (e.kind !== 'key' || e.body.new !== true || !this.authorityAt(e.lamport).can(e.author, 'remove')) continue
        const id = String(e.body.id ?? '')
        if (!KEY_ID.test(id) || seen.has(id)) continue
        seen.add(id)
        // The removal it was made for, which a clock ahead of this one can put after it. Within a
        // day, so a key cannot claim to cover removals still to come.
        const after = Math.min(Number(e.body.after) || 0, e.lamport + KEY_COVERS_MS)
        out.push({ id, lamport: e.lamport, covers: Math.max(e.lamport, after) })
      }
      return out
    })
  }

  /**
   * Whether this device holds the removal a key was made for. A server that keeps the removal
   * back, and passes on the new key, would have the removed person look like somebody still
   * here who lacks it, and be given a copy.
   */
  holdsRemovalFor(id: string): boolean {
    const made = this.everything().find((e) => e.kind === 'key' && e.body.new === true && e.body.id === id)
    const after = Number(made?.body.after) || 0
    if (!made || after <= 0) return true
    // At or after: a removal placed ahead of the clock is made a key for as if it were now.
    return this.everything().some((e) => e.kind === 'role' && e.body.role === 'kicked' && e.lamport >= after)
  }

  /** Every copy of a key sealed for this person. Whoever sealed it, it opens only to the key its id names. */
  keyBoxes(person: string): { id: string; author: string; sealed: string }[] {
    return this.cached(`keyBoxes:${person}`, () => {
      const out: { id: string; author: string; sealed: string }[] = []
      for (const e of this.everything()) {
        if (e.kind !== 'key') continue
        const id = String(e.body.id ?? '')
        const boxes = e.body.boxes as Record<string, unknown> | undefined
        const sealed = boxes && typeof boxes === 'object' ? boxes[person] : undefined
        if (KEY_ID.test(id) && typeof sealed === 'string' && sealed.length < 200) out.push({ id, author: e.author, sealed })
      }
      return out
    })
  }

  /**
   * Who has a copy of this key: whoever made it, and whoever was given one by somebody who had
   * it. A copy from anybody else is not counted: somebody without the key could write a box
   * that opens to nothing, and the person named in it would never be given the real one.
   */
  keyHolders(id: string): Set<string> {
    return this.cached(`keyHolders:${id}`, () => {
      const copies = this.everything().filter((e) => e.kind === 'key' && e.body.id === id)
      const made = copies.find((e) => e.body.new === true)
      const out = new Set<string>(made ? [made.author] : [])
      // Round again while it grows: a copy counts once its giver counts.
      for (let grew = true; grew; ) {
        grew = false
        for (const e of copies) {
          if (!out.has(e.author)) continue
          const boxes = e.body.boxes
          if (!boxes || typeof boxes !== 'object') continue
          for (const person of Object.keys(boxes)) {
            if (!PERSON_KEY.test(person) || out.has(person)) continue
            out.add(person)
            grew = true
          }
        }
      }
      return out
    })
  }

  /** Everybody in the space who is not removed: whoever made it, and whoever has written in it. */
  keyMembers(): string[] {
    return this.cached('keyMembers', () => {
      const auth = this.authority()
      const people = new Set<string>(this.founder ? [this.founder] : [])
      for (const e of this.everything()) people.add(e.author)
      // A webhook is not a person. It never gets the space's key: its link would open the space.
      for (const hook of this.hooks()) people.delete(hook.pub)
      return [...people].filter((p) => PERSON_KEY.test(p) && !auth.isKicked(p))
    })
  }

  lastProfileAt(author: string): number {
    const events = this.all()
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'profile' && events[i].author === author) return events[i].at
    }
    return 0
  }

  avatars(): Map<string, string> {
    return this.cached('avatars', () => this.foldAvatars())
  }

  private foldAvatars(): Map<string, string> {
    const out = new Map<string, string>()
    const auth = this.authority()
    for (const e of this.all()) {
      // Somebody removed keeps the name and picture they had: they cannot pass as somebody else.
      if (e.kind !== 'profile' || auth.removedBy(e.author, e.lamport, this.arrivedAt(e.id))) continue
      const picture = cleanAvatar(e.body.avatar)
      if (picture) out.set(e.author, picture)
      else if (e.body.avatar === '') out.delete(e.author)
    }
    return out
  }

  covers(): Map<string, string> {
    return this.cached('covers', () => this.foldCovers())
  }

  /** Like the pictures: a profile that says nothing about a cover leaves the last one alone. */
  private foldCovers(): Map<string, string> {
    const out = new Map<string, string>()
    const auth = this.authority()
    for (const e of this.all()) {
      if (e.kind !== 'profile' || auth.removedBy(e.author, e.lamport, this.arrivedAt(e.id))) continue
      const cover = cleanCover(e.body.cover)
      if (cover) out.set(e.author, cover)
      else if (e.body.cover === '') out.delete(e.author)
    }
    return out
  }

  names(): Map<string, string> {
    return this.cached('names', () => this.foldNames())
  }

  private foldNames(): Map<string, string> {
    const names = new Map<string, string>()
    const auth = this.authority()
    for (const e of this.all()) {
      if (e.kind !== 'profile' || auth.removedBy(e.author, e.lamport, this.arrivedAt(e.id))) continue
      const name = String(e.body.name ?? '').slice(0, 24)
      if (name) names.set(e.author, name)
    }
    return names
  }

  lastSeen(): Map<string, number> {
    return this.cached('lastSeen', () => this.foldLastSeen())
  }

  private foldLastSeen(): Map<string, number> {
    const out = new Map<string, number>()
    for (const e of this.all()) {
      const was = out.get(e.author) ?? 0
      if (e.at > was) out.set(e.author, e.at)
    }
    return out
  }
}

const ZERO_WIDTH_JOINER = 0x200d

// Hand-written, not Intl.Segmenter: every browser must bucket a reaction identically.
export function oneEmoji(raw: string): string {
  const points = [...raw]
  if (points.length === 0) return ''

  const code = (s: string): number => s.codePointAt(0) ?? 0
  const regional = (s: string): boolean => code(s) >= 0x1f1e6 && code(s) <= 0x1f1ff
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
    if (cp === ZERO_WIDTH_JOINER && points[i + 1]) {
      out += points[i] + points[i + 1]
      i += 1
      continue
    }
    break
  }
  return out
}

/** The most channels an order names. */
export const MAX_ORDER = 200

/** Channel names, each once, in the order given. */
export function cleanOrder(raw: unknown[]): string[] {
  const out = new Set<string>()
  for (const one of raw.slice(0, MAX_ORDER)) {
    const name = typeof one === 'string' ? cleanChannel(one) : ''
    if (name) out.add(name)
  }
  return [...out]
}

export function cleanChannel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}

function channelOf(e: LogEvent): string {
  return cleanChannel(String(e.body.channel ?? '')) || DEFAULT_CHANNEL
}

export interface ThreadInfo {
  root: Message
  replies: number
  /** Wall clock. */
  last: number
  /** Lamport clock. */
  newest: number
}

export const MAX_BOARD_SOUNDS = 60
export const MAX_BOARD_GROUPS = 20

export interface BoardSound {
  id: string
  label: string
  emoji: string
  file: Attachment
  maker: string
  /** The id of its group, or '' when it is in none. A group that is gone counts as none. */
  group: string
}

export interface BoardGroup {
  id: string
  label: string
  emoji: string
  maker: string
}

export interface PushTarget {
  person: string
  /** This device's own id, so a new address takes the place of its old one. */
  id: string
  endpoint: string
  /** The browser's P-256 key and auth secret, base64url, that a notification is sealed to (RFC 8291). */
  p256dh: string
  auth: string
  /** The server that signs for the push service. */
  via: string
  what: 'mentions' | 'all'
  /** Whether a notification shows what was said. */
  text: boolean
  /** The whole space is muted. */
  muted: boolean
  /** Text channels muted on their own. */
  mute: string[]
  /** Do not disturb: nothing at all until it is turned off. */
  dnd: boolean
}

function cleanPushTarget(person: string, id: string, body: Record<string, unknown>): PushTarget | null {
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
  const via = typeof body.via === 'string' ? body.via : ''
  const web = (raw: string): boolean => {
    try {
      const url = new URL(raw)
      const local = url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)
      return raw.length <= 1024 && (url.protocol === 'https:' || local) && !url.username && !url.password
    } catch {
      return false
    }
  }
  if (!web(endpoint) || !web(via)) return null
  const p256dh = String(body.p256dh ?? '')
  const secret = String(body.auth ?? '')
  // 65 bytes of an uncompressed point, and 16 of secret.
  if (!/^[A-Za-z0-9_-]{87}$/.test(p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(secret)) return null
  const mute = Array.isArray(body.mute) ? cleanOrder(body.mute) : []
  return {
    person,
    id,
    endpoint,
    p256dh,
    auth: secret,
    via: via.replace(/\/+$/, ''),
    what: body.what === 'all' ? 'all' : 'mentions',
    text: body.text !== false,
    muted: body.muted === true,
    mute,
    dnd: body.dnd === true,
  }
}

export interface NoteInfo {
  id: string
  title: string
  /** Markdown. */
  text: string
  maker: string
  /** Who wrote the newest version, and when by their clock. */
  by: string
  at: number
  lamport: number
  /** The levels that may see it. Empty is everybody. */
  levels: string[]
}

/** A whiteboard: a note with shapes in place of text. */
export type WhiteboardInfo = Omit<NoteInfo, 'text'>

/** One tldraw record, as somebody wrote it. tldraw's own store checks the rest before the board draws it. */
export interface WhiteboardRecord {
  id: string
  typeName: string
  type?: string
  [field: string]: unknown
}

export type WhiteboardEntry = WhiteboardRecord | { id: string; gone: true }

/** At most this many records in one line of the log. */
export const MAX_RECORDS_PER_EVENT = 400

/** The records of a board that are shared. Not the document, which each device has of its own. */
const RECORD_TYPES = new Set(['shape', 'binding', 'page'])
/**
 * No picture, video, bookmark or web page: each would load from somewhere on every device that
 * opens the board.
 */
const LOADS_FROM_ELSEWHERE = new Set(['image', 'video', 'bookmark', 'embed'])

export function cleanWhiteboardEntry(raw: unknown): WhiteboardEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || !/^(shape|binding|page):[\w-]{1,64}$/.test(record.id)) return null
  if (record.gone === true) return { id: record.id, gone: true }
  if (typeof record.typeName !== 'string' || !RECORD_TYPES.has(record.typeName)) return null
  if (!record.id.startsWith(`${record.typeName}:`)) return null
  if (record.typeName === 'shape' && (typeof record.type !== 'string' || LOADS_FROM_ELSEWHERE.has(record.type))) return null
  return record as WhiteboardRecord
}

/** A pass in an invite: 16 letters of the same alphabet as a code. */
export function cleanPass(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.toUpperCase() : ''
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(text) ? text : ''
}

const passEncoder = new TextEncoder()

/** What a newcomer shows for a pass: bound to their own key, so nobody else can show it. */
export async function passProof(pass: string, person: string): Promise<string> {
  const bytes = passEncoder.encode(`nook-pass-1|${pass}|${person}`)
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)))
}

export function cleanNoteId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw : ''
  return /^[0-9a-f]{8,32}$/.test(id) ? id : ''
}

export function cleanNoteTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 80)
}

export interface ChannelInfo {
  name: string
  label: string
  topic: string
  /** The levels that may see and use it. Empty is everybody. */
  levels: string[]
  /** Its pictures and videos are blurred until somebody clicks one. */
  nsfw: boolean
}

/** Stored on the server under `id` (SHA-256 of the sealed bytes), sealed with `key`, which the server never sees. */
export interface Attachment {
  id: string
  name: string
  type: string
  /** Plaintext bytes. */
  size: number
  key: string
  w?: number
  h?: number
  /** Seconds. */
  dur?: number
  thumb?: string
  /** Id of the sealed first frame, stored as its own file. */
  poster?: string
  /** Sealed in pieces of this many plain bytes, so it can be read a piece at a time. */
  chunk?: number
}

export const MIN_CHUNK = 64 * 1024
export const MAX_CHUNK = 16 * 1024 * 1024

export const MAX_FILES = 10

export function cleanFiles(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return []
  const out: Attachment[] = []
  const bounded = (v: unknown, most: number): number | undefined =>
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
      // No control or direction marks: one could turn `fdp.exe` round to show as `exe.pdf`.
      name: String(f.name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 120).trim() || 'file',
      type: /^[\w.+-]+\/[\w.+-]+$/.test(String(f.type ?? '')) ? String(f.type).slice(0, 80) : 'application/octet-stream',
    }
    const w = bounded(f.w, 20_000)
    const h = bounded(f.h, 20_000)
    if (w && h) {
      file.w = Math.round(w)
      file.h = Math.round(h)
    }
    const dur = bounded(f.dur, 1_000_000)
    if (dur) file.dur = dur
    if (
      typeof f.thumb === 'string' &&
      f.thumb.length <= 4000 &&
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(f.thumb)
    ) {
      file.thumb = f.thumb
    }
    if (typeof f.poster === 'string' && /^[0-9a-f]{64}$/.test(f.poster)) file.poster = f.poster
    if (typeof f.chunk === 'number' && Number.isInteger(f.chunk) && f.chunk >= MIN_CHUNK && f.chunk <= MAX_CHUNK) {
      file.chunk = f.chunk
    }
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
  lamport: number
  text: string
  replyTo: string | null
  inThread?: boolean
  emote?: boolean
  files?: Attachment[]
  live?: boolean
  replies?: number
  edited: boolean
  retracted: boolean
  pinned?: boolean
  poll?: Poll
  /** Posted by a webhook: its id, and the picture it asked for, a web address. */
  hook?: { id: string; avatar: string }
  embeds?: Embed[]
  reactions: Map<string, Set<string>>
}

export interface HookInfo {
  id: string
  /** The key it signs with. */
  pub: string
  /** Its own key, base64: what it posts is sealed with it. Everybody in the space has it. */
  key: string
  /** The secret half of `pub`, hex. It is in the link. */
  seed: string
  channel: string
  name: string
  maker: string
  made: number
  /** The removal after which it stopped, as a lamport time. Null while it works. */
  stoppedAt: number | null
  goneAt: number | null
}

/** A Discord embed, the parts Nook shows. */
export interface Embed {
  title?: string
  description?: string
  url?: string
  /** `#rrggbb`. */
  colour?: string
  author?: { name: string; url?: string; icon?: string }
  fields?: { name: string; value: string; inline: boolean }[]
  footer?: string
  image?: string
  thumbnail?: string
  /** Epoch milliseconds. */
  at?: number
}

export function cleanHookName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
}

/** An http or https address, or ''. */
export function cleanWebAddress(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
  } catch {
    return ''
  }
}

const words = (raw: unknown, most: number): string => (typeof raw === 'string' ? raw.trim().slice(0, most) : '')

/** At most ten, with Discord's limits on each part. */
export function cleanEmbeds(raw: unknown): Embed[] {
  if (!Array.isArray(raw)) return []
  const out: Embed[] = []
  for (const item of raw.slice(0, 10)) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const embed: Embed = {}
    const title = words(e.title, 256)
    if (title) embed.title = title
    const description = words(e.description, 4096)
    if (description) embed.description = description
    const url = cleanWebAddress(e.url)
    if (url) embed.url = url
    if (typeof e.color === 'number' && Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff) {
      embed.colour = `#${e.color.toString(16).padStart(6, '0')}`
    }
    const author = e.author as Record<string, unknown> | undefined
    const authorName = words(author?.name, 256)
    if (authorName) {
      embed.author = { name: authorName }
      const link = cleanWebAddress(author?.url)
      if (link) embed.author.url = link
      const icon = cleanWebAddress(author?.icon_url)
      if (icon) embed.author.icon = icon
    }
    if (Array.isArray(e.fields)) {
      const fields = e.fields
        .slice(0, 25)
        .map((f) => f as Record<string, unknown>)
        .map((f) => ({ name: words(f?.name, 256), value: words(f?.value, 1024), inline: f?.inline === true }))
        .filter((f) => f.name || f.value)
      if (fields.length) embed.fields = fields
    }
    const footer = words((e.footer as Record<string, unknown> | undefined)?.text, 2048)
    if (footer) embed.footer = footer
    const image = cleanWebAddress((e.image as Record<string, unknown> | undefined)?.url)
    if (image) embed.image = image
    const thumbnail = cleanWebAddress((e.thumbnail as Record<string, unknown> | undefined)?.url)
    if (thumbnail) embed.thumbnail = thumbnail
    if (typeof e.timestamp === 'string') {
      const at = Date.parse(e.timestamp)
      if (Number.isFinite(at)) embed.at = at
    }
    if (Object.keys(embed).length) out.push(embed)
  }
  return out
}

export interface Poll {
  question: string
  options: string[]
  votes: Map<number, Set<string>>
  mine: number | null
  total: number
}
