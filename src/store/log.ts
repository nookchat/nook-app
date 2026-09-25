import { toHex } from '../bytes'
import { sign, verify } from './identity'

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
] as const

export type EventKind = (typeof EVENT_KINDS)[number]

const KNOWN_KINDS = new Set<string>(EVENT_KINDS)

/** A level's id, or 'kicked'. */
export type Role = string

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
  { id: 'mod', name: 'Moderator', colour: '#3ddc84', rank: 50, can: ['pin', 'delete', 'remove', 'move'] },
  { id: MEMBER, name: 'Member', colour: '', rank: 0, can: [] },
]

export class Authority {
  constructor(
    readonly founder: string,
    private readonly levels: Map<string, Level>,
    private readonly placed: Map<string, string>,
    readonly kickedAt: Map<string, number>,
  ) {}

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

  mayEdit(who: string, level: Level): boolean {
    return level.id !== OWNER && this.can(who, 'levels') && level.rank < this.levelOf(who).rank
  }
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

export async function openEvent(raw: unknown, room: string): Promise<LogEvent | null> {
  if (!raw || typeof raw !== 'object') return null
  const e = { ...(raw as Partial<LogEvent>) }
  // Room and id are never read from the wire: hashing the supplied room stops replay into another space.
  e.room = room
  if (typeof e.sig !== 'string' || !/^[0-9a-f]{128}$/.test(e.sig)) return null
  if (typeof e.author !== 'string' || !/^[0-9a-f]{64}$/.test(e.author)) return null
  if (typeof e.lamport !== 'number' || !Number.isInteger(e.lamport) || e.lamport < 0) return null
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return null
  if (!KNOWN_KINDS.has(String(e.kind))) return null
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

const CLEARABLE = new Set<EventKind>(['said', 'edit', 'react', 'retract', 'pin', 'poll', 'vote'])

// A 48 px WebP thumbnail is about 1500 characters.
export const MAX_AVATAR = 2600

export function cleanAvatar(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  if (!text || text.length > MAX_AVATAR) return ''
  // No SVG: it is a document that can carry script, and this ends up in a src.
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(text) ? text : ''
}

const MAX_CLOCK_LEAD_MS = 5 * 60 * 1000

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
  private clock = 0
  private ordered: LogEvent[] | null = null
  private memoFrom: LogEvent[] | null = null
  private memoFounder = ''
  private readonly memo = new Map<string, unknown>()

  constructor(room: string) {
    this.room = room
  }

  nextLamport(): number {
    return Math.max(this.clock + 1, Date.now())
  }

  /** Returns true when the event was new. */
  add(event: LogEvent): boolean {
    if (this.byId.has(event.id)) return false
    this.byId.set(event.id, event)
    this.advance(event.lamport)
    const ordered = this.ordered
    if (ordered && (ordered.length === 0 || compare(ordered[ordered.length - 1], event) < 0)) {
      // A new array, not a push: holders of the old one, and the memo, rely on it never changing.
      this.ordered = [...ordered, event]
    } else {
      this.ordered = null
    }
    return true
  }

  private advance(lamport: number): void {
    const capped = Math.min(lamport, Date.now() + MAX_CLOCK_LEAD_MS)
    if (capped > this.clock) this.clock = capped
  }

  /** Computed once per state of the log. Callers must not mutate what it returns. */
  private cached<T>(key: string, make: () => T): T {
    const all = this.all()
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

  private foldAuthority(): Authority {
    const all = this.all()
    const levels = new Map<string, Level>(STARTING_LEVELS.map((l) => [l.id, { ...l, can: [...l.can] }]))
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
          if (id === MEMBER || !was) continue
          levels.delete(id)
          for (const [key, at] of placed) if (at === id) placed.delete(key)
          continue
        }
        const name = String(e.body.name ?? '').slice(0, 24).trim()
        if (!name) continue
        const rank = id === MEMBER ? 0 : Number(e.body.rank)
        if (!Number.isFinite(rank) || (id !== MEMBER && (rank <= 0 || rank >= mine.rank))) continue
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
    return auth
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

  /** Every event in agreed order. Shared: never mutate it. */
  all(): LogEvent[] {
    this.ordered ??= [...this.byId.values()].sort(compare)
    return this.ordered
  }

  channels(voice = false): string[] {
    return this.channelList(voice).map((c) => c.name)
  }

  channelList(voice = false): ChannelInfo[] {
    const defaultName = voice ? DEFAULT_VOICE : DEFAULT_CHANNEL
    const names = new Set<string>([defaultName])
    const label = new Map<string, string>()
    const topic = new Map<string, string>()
    const gone = new Set<string>()
    const auth = this.authority()

    for (const e of this.all()) {
      if (e.kind === 'channel') {
        if (!auth.can(e.author, 'channels')) continue
        if ((e.body.voice === true) !== voice) continue
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
        names.add(channelOf(e))
      }
    }

    gone.delete(defaultName)

    return [...names]
      .filter((name) => !gone.has(name))
      .sort()
      .map((name) => ({ name, label: label.get(name) || name, topic: topic.get(name) ?? '' }))
  }

  private deletedChannels(): Set<string> {
    const live = new Set(this.channels())
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

  /** Pass a channel to get what its readers see, thread replies excluded. */
  messages(channel?: string): Message[] {
    const out: Message[] = []
    const index = new Map<string, Message>()
    const names = new Map<string, string>()
    const auth = this.authority()
    const kicked = auth.kickedAt
    const cleared = this.resetAt()
    const removed = this.deletedChannels()

    for (const e of this.all()) {
      if (e.lamport < cleared && CLEARABLE.has(e.kind)) continue
      const removedAt = kicked.get(e.author)
      if (removedAt !== undefined && e.lamport > removedAt) continue
      if (e.kind === 'profile') {
        const name = String(e.body.name ?? '').slice(0, 24)
        if (name) names.set(e.author, name)
        continue
      }
      if (e.kind === 'poll') {
        if (removed.has(channelOf(e))) continue
        if (channel && channelOf(e) !== channel) continue
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
        continue
      }
      if (e.kind !== 'edit' && e.kind !== 'retract' && e.kind !== 'react') continue
      const target = index.get(String(e.body.target ?? ''))
      if (!target) continue
      if (e.kind === 'edit') {
        if (e.author !== target.author) continue
        target.text = String(e.body.text ?? '')
        target.edited = true
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
      m.name = names.get(m.author) ?? ''
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

    const live = out.filter((m) => !m.retracted)
    return channel ? live.filter((m) => !m.inThread) : live
  }

  threads(): ThreadInfo[] {
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
    for (const e of this.all()) {
      if (e.kind !== 'profile') continue
      const picture = cleanAvatar(e.body.avatar)
      if (picture) out.set(e.author, picture)
      else if (e.body.avatar === '') out.delete(e.author)
    }
    return out
  }

  names(): Map<string, string> {
    return this.cached('names', () => this.foldNames())
  }

  private foldNames(): Map<string, string> {
    const names = new Map<string, string>()
    for (const e of this.all()) {
      if (e.kind !== 'profile') continue
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

export interface ChannelInfo {
  name: string
  label: string
  topic: string
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
}

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
      name: String(f.name ?? '').slice(0, 120).trim() || 'file',
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
  reactions: Map<string, Set<string>>
}

export interface Poll {
  question: string
  options: string[]
  votes: Map<number, Set<string>>
  mine: number | null
  total: number
}
