/**
 * An optional archive, for the one thing holding your own history cannot do.
 *
 * Every device keeps the whole log and hands it to whoever turns up, so a
 * space survives as long as one person who was in it opens it again. What that
 * cannot do is catch you up on something said while every single person was
 * offline, because there was nobody there to remember it. That is the one
 * hole, and an archive fills it.
 *
 * It is off unless somebody turns it on, per space, by pasting a URL. Nothing
 * about a space changes when it is on and nothing breaks when it goes away:
 * the peers are still the source of truth, and the archive is a peer that
 * happens to always be awake.
 *
 * What it is trusted with is nothing.
 *
 *   It cannot read. Every event is sealed with the key derived from the space
 *   code before it leaves, and the code lives in the fragment of a URL, which
 *   a browser never sends to anybody. A stolen disk is a pile of ciphertext.
 *
 *   It cannot lie. Every event inside is signed by whoever wrote it and is
 *   opened on the way back in exactly like an event from a person, so an
 *   archive that alters one produces one that fails its signature and is
 *   dropped.
 *
 *   It can forget, or refuse, and either of those puts you back to a working
 *   space with no archive.
 *
 * See server/ for one you can run, which is a single file and a container.
 */

import { open as unseal, seal, type Envelope } from '../signal/envelope'
import type { LogEvent } from './log'

/** How many events to push in one request. */
const BATCH = 200

export interface ArchiveConfig {
  /** Where it lives, or empty for no archive at all. */
  url: string
  /** How many lines of it we have already read. */
  at: number
}

function clean(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return trimmed
  } catch {
    return ''
  }
}

/**
 * An event on its way to the archive, wrapped so the existing seal can carry
 * it. The envelope shape is what seal and open agree on, so a stored event
 * borrows it rather than inventing a second sealed format to get wrong.
 */
function wrap(event: LogEvent): Envelope {
  return { v: 1, id: event.id, from: event.author, t: event.at, type: 'ping', data: event }
}

export class Archive {
  private readonly key: CryptoKey
  private readonly room: string
  private url = ''
  private at = 0
  private busy = false

  constructor(room: string, key: CryptoKey) {
    this.room = room
    this.key = key
  }

  get on(): boolean {
    return this.url !== ''
  }

  get address(): string {
    return this.url
  }

  /** Point it somewhere, or at nothing. Returns what was actually accepted. */
  use(raw: string, at = 0): string {
    const next = clean(raw)
    if (next !== this.url) this.at = 0
    else this.at = at
    this.url = next
    return this.url
  }

  /** How far through we have read, so the next visit starts where this ended. */
  get cursor(): number {
    return this.at
  }

  /**
   * Ask what happened while nobody was looking.
   *
   * Anything it cannot open is skipped rather than fatal: one bad line in an
   * archive should cost that line and nothing else.
   */
  async fetch(): Promise<LogEvent[]> {
    if (!this.url) return []
    let page: { at?: number; events?: unknown }
    try {
      const res = await globalThis.fetch(`${this.url}/events/${this.room}?from=${this.at}`, {
        method: 'GET',
        mode: 'cors',
      })
      if (!res.ok) return []
      page = (await res.json()) as { at?: number; events?: unknown }
    } catch {
      return []
    }

    const lines = Array.isArray(page.events) ? page.events : []
    const out: LogEvent[] = []
    for (const line of lines) {
      if (typeof line !== 'string') continue
      const env = await unseal(this.key, line)
      if (!env?.data) continue
      out.push(env.data as unknown as LogEvent)
    }
    if (typeof page.at === 'number' && page.at >= this.at) this.at = page.at
    return out
  }

  /**
   * Hand it some events. Never blocks anything and never reports failure,
   * because a space with an archive that is down is a space, and telling
   * somebody their message did not reach a machine they forgot they set up
   * helps nobody.
   */
  async push(events: LogEvent[]): Promise<void> {
    if (!this.url || events.length === 0 || this.busy) return
    this.busy = true
    try {
      for (let i = 0; i < events.length; i += BATCH) {
        const sealed = await Promise.all(
          events.slice(i, i + BATCH).map((e) => seal(this.key, wrap(e))),
        )
        await globalThis.fetch(`${this.url}/events/${this.room}`, {
          method: 'POST',
          mode: 'cors',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sealed),
        })
      }
    } catch {
      // Next time.
    } finally {
      this.busy = false
    }
  }

  /** Is anything there, and is it an archive rather than somebody's blog? */
  async check(): Promise<boolean> {
    if (!this.url) return false
    try {
      const res = await globalThis.fetch(`${this.url}/health`, { mode: 'cors' })
      if (!res.ok) return false
      const body = (await res.json()) as { service?: string }
      return body.service === 'cathode-archive'
    } catch {
      return false
    }
  }
}
