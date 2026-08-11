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

export type EventKind = 'said' | 'edit' | 'react' | 'retract' | 'profile'

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

const MAX_BODY = 4000

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
  const e = raw as Partial<LogEvent>
  if (typeof e.id !== 'string' || !/^[0-9a-f]{64}$/.test(e.id)) return null
  if (typeof e.sig !== 'string' || !/^[0-9a-f]{128}$/.test(e.sig)) return null
  if (typeof e.author !== 'string' || !/^[0-9a-f]{64}$/.test(e.author)) return null
  if (e.room !== room) return null
  if (typeof e.lamport !== 'number' || !Number.isInteger(e.lamport) || e.lamport < 0) return null
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return null
  if (!['said', 'edit', 'react', 'retract', 'profile'].includes(String(e.kind))) return null
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
  if ((await hash(canonical(base))) !== e.id) return null
  if (!verify(e.id, e.sig, e.author)) return null
  return { ...base, id: e.id, sig: e.sig }
}

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

  /** The next clock value to stamp on something written here. */
  nextLamport(): number {
    return this.clock + 1
  }

  /** Returns true when the event was new, so callers know whether to redraw. */
  add(event: LogEvent): boolean {
    if (this.byId.has(event.id)) return false
    this.byId.set(event.id, event)
    if (event.lamport > this.clock) this.clock = event.lamport
    return true
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
  messages(): Message[] {
    const out: Message[] = []
    const index = new Map<string, Message>()
    const names = new Map<string, string>()

    for (const e of this.all()) {
      if (e.kind === 'profile') {
        const name = String(e.body.name ?? '').slice(0, 24)
        if (name) names.set(e.author, name)
        continue
      }
      if (e.kind === 'said') {
        const message: Message = {
          id: e.id,
          author: e.author,
          at: e.at,
          text: String(e.body.text ?? ''),
          replyTo: typeof e.body.replyTo === 'string' ? e.body.replyTo : null,
          edited: false,
          retracted: false,
          reactions: new Map(),
        }
        index.set(e.id, message)
        out.push(message)
        continue
      }
      const target = index.get(String(e.body.target ?? ''))
      if (!target) continue
      if (e.kind === 'edit') {
        if (e.author !== target.author) continue
        target.text = String(e.body.text ?? '')
        target.edited = true
      } else if (e.kind === 'retract') {
        if (e.author !== target.author) continue
        target.retracted = true
        target.text = ''
        target.reactions.clear()
      } else if (e.kind === 'react') {
        const emoji = String(e.body.emoji ?? '').slice(0, 8)
        if (!emoji) continue
        const who = target.reactions.get(emoji) ?? new Set<string>()
        // A reaction toggles, so sending it twice takes it back.
        if (who.has(e.author)) who.delete(e.author)
        else who.add(e.author)
        if (who.size) target.reactions.set(emoji, who)
        else target.reactions.delete(emoji)
      }
    }

    for (const m of out) m.name = names.get(m.author) ?? ''
    return out.filter((m) => !m.retracted)
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
}

export interface Message {
  id: string
  author: string
  name?: string
  at: number
  text: string
  replyTo: string | null
  edited: boolean
  retracted: boolean
  reactions: Map<string, Set<string>>
}
