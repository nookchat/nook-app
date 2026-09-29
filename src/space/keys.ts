import { fromBase64, toBase64, toHex } from '../bytes'
import { sharedKey } from '../store/identity'
import { KEY_ID, type RoomLog } from '../store/log'

/**
 * A space starts with one key, made from its code. When somebody is removed, the device of
 * whoever removed them makes a new one, and seals a copy for each person still in the space
 * with a key only that person and the sealer can work out. What is written after that is
 * sealed with the new key, so the code alone no longer opens it. Nobody sees any of this:
 * the copies ride in the log, and each device opens its own.
 *
 * Somebody who joins later has only the code. The first device that is online and holds the
 * newest key seals a copy for them too, a few seconds after they arrive.
 */

/** How many copies go in one event, so it stays well inside one line. */
const BOXES_PER_EVENT = 200
/** Somebody else who may do it waits a while first, so only one of them does. */
const OTHERS_WAIT_MS = [2000, 6000]
const GRANT_WAIT_MS = [800, 5000]

const enc = new TextEncoder()

/** The id of a key: a hash of it, so a copy that opens to a different key is caught. */
async function idOf(raw: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(raw.length + 16)
  bytes.set(enc.encode('nook-space-key-1'), 0)
  bytes.set(raw, 16)
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))).slice(0, 32)
}

function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function sealFor(person: string, raw: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const box = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await sharedKey(person), raw as BufferSource),
  )
  const out = new Uint8Array(iv.length + box.length)
  out.set(iv, 0)
  out.set(box, iv.length)
  return toBase64(out)
}

async function openFrom(author: string, sealed: string): Promise<Uint8Array | null> {
  try {
    const bytes = fromBase64(sealed)
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
      await sharedKey(author),
      bytes.subarray(12),
    )
    return new Uint8Array(plain)
  } catch {
    return null
  }
}

/** A line or a signal sealed with a newer key starts with that key's id and a dot. */
export function tagged(tag: string, wire: string): string {
  return tag ? `${tag}.${wire}` : wire
}

/** The key id a line names, '' for the code's own key, and the sealed part. */
export function untag(line: string): { tag: string; wire: string } {
  if (line.charCodeAt(32) === 46 && KEY_ID.test(line.slice(0, 32))) return { tag: line.slice(0, 32), wire: line.slice(33) }
  return { tag: '', wire: line }
}

export class SpaceKeys {
  /** A key was learned, or the one to write with changed. */
  readonly changed = new Set<() => void>()

  private readonly held = new Map<string, CryptoKey>()
  /** Raw bytes of each key held, to seal copies for somebody new. */
  private readonly raw = new Map<string, Uint8Array>()
  private readonly tried = new Set<string>()
  private current = ''

  constructor(readonly base: CryptoKey) {}

  /** The key a tag names, or undefined when this device does not hold it yet. */
  key(tag: string): CryptoKey | undefined {
    return tag ? this.held.get(tag) : this.base
  }

  has(tag: string): boolean {
    return this.held.has(tag)
  }

  /** The key to seal with now, and its tag. */
  get writing(): { tag: string; key: CryptoKey } {
    return { tag: this.current, key: this.key(this.current) ?? this.base }
  }

  /** Opens every copy sealed for `me`, and picks the newest trusted key held to write with. */
  async learn(log: RoomLog, me: string): Promise<void> {
    let learned = false
    for (const box of log.keyBoxes(me)) {
      const seen = `${box.author}:${box.id}:${box.sealed}`
      if (this.held.has(box.id) || this.tried.has(seen)) continue
      this.tried.add(seen)
      const raw = await openFrom(box.author, box.sealed)
      if (!raw || raw.length !== 32 || (await idOf(raw)) !== box.id) continue
      await this.add(box.id, raw)
      learned = true
    }
    const newest = [...log.keyEpochs()].reverse().find((e) => this.held.has(e.id))?.id ?? ''
    if (newest !== this.current || learned) {
      this.current = newest
      for (const fn of this.changed) fn()
    }
  }

  private async add(id: string, raw: Uint8Array): Promise<void> {
    this.held.set(id, await importKey(raw))
    this.raw.set(id, raw)
  }

  /** A new key, with a copy for each person. The first event makes it the space's key. */
  async make(people: string[], after: number): Promise<{ id: string; bodies: Record<string, unknown>[] }> {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const id = await idOf(raw)
    await this.add(id, raw)
    const bodies = await this.copies(id, people)
    if (bodies.length === 0) bodies.push({ id, boxes: {} })
    bodies[0].new = true
    bodies[0].after = after
    return { id, bodies }
  }

  /** Copies of a key this device holds, for these people, in events small enough for a line. */
  async copies(id: string, people: string[]): Promise<Record<string, unknown>[]> {
    const raw = this.raw.get(id)
    if (!raw) return []
    const bodies: Record<string, unknown>[] = []
    for (let i = 0; i < people.length; i += BOXES_PER_EVENT) {
      const boxes: Record<string, string> = {}
      for (const person of people.slice(i, i + BOXES_PER_EVENT)) boxes[person] = await sealFor(person, raw)
      bodies.push({ id, boxes })
    }
    return bodies
  }
}

const between = ([least, most]: number[]): number => least + Math.random() * (most - least)

/**
 * Looks after the space's key for this device: a new one after somebody is removed, if this
 * person may remove people, and a copy for anybody who does not have the newest one yet.
 */
export class KeyKeeper {
  private timer = 0
  private busy = false
  private stopped = false

  constructor(
    private readonly keys: SpaceKeys,
    private readonly log: RoomLog,
    private readonly me: string,
    private readonly write: (body: Record<string, unknown>) => Promise<unknown>,
  ) {}

  /** Call when the log changes. Cheap when there is nothing to do. */
  consider(): void {
    if (this.stopped || this.timer || this.busy) return
    const need = this.need()
    if (!need) return
    const wait = need.kind === 'rotate' ? (need.mine ? 0 : between(OTHERS_WAIT_MS)) : between(GRANT_WAIT_MS)
    this.timer = window.setTimeout(() => {
      this.timer = 0
      void this.act()
    }, wait)
  }

  stop(): void {
    this.stopped = true
    window.clearTimeout(this.timer)
  }

  /** Whether somebody was removed after the newest key was made, or somebody still lacks it. */
  private need(): { kind: 'rotate'; after: number; mine: boolean } | { kind: 'grant'; id: string; people: string[] } | null {
    const auth = this.log.authority()
    if (!this.me || auth.isKicked(this.me) || this.log.closed()) return null
    const newest = this.log.keyEpochs().at(-1)
    const lastKick = Math.max(0, ...auth.kickedAt.values())
    // A key covers every removal up to the one it was made for, whatever the clocks say.
    if (lastKick > (newest?.covers ?? 0)) {
      if (!auth.can(this.me, 'remove')) return null
      const kick = this.log.all().find((e) => e.kind === 'role' && e.body.role === 'kicked' && e.lamport === lastKick)
      return { kind: 'rotate', after: lastKick, mine: kick?.author === this.me }
    }
    if (!newest || !this.keys.has(newest.id)) return null
    const boxed = this.log.keyHolders(newest.id)
    const people = this.log.keyMembers().filter((p) => !boxed.has(p))
    return people.length ? { kind: 'grant', id: newest.id, people } : null
  }

  private async act(): Promise<void> {
    const need = this.need()
    if (!need || this.stopped) return
    this.busy = true
    try {
      if (need.kind === 'rotate') {
        const { bodies } = await this.keys.make([...new Set([this.me, ...this.log.keyMembers()])], need.after)
        for (const body of bodies) await this.write(body)
      } else {
        for (const body of await this.keys.copies(need.id, need.people)) await this.write(body)
      }
      await this.keys.learn(this.log, this.me)
    } catch (err) {
      console.warn('[nook] the space key was not passed on', err)
    } finally {
      this.busy = false
    }
    this.consider()
  }
}
