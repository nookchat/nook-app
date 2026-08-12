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
/** How long to wait before trying again after the archive said no. */
const RETRY_MS = 15_000
/** Sweep for anything that never made it, this often. */
const SWEEP_MS = 60_000

export interface ArchiveConfig {
  /** Where it lives, or empty for no archive at all. */
  url: string
  /** How many lines of it we have already read. */
  at: number
}

/**
 * The archive every new space uses, unless it is told otherwise.
 *
 * Set once. Asking somebody to paste the same address into every space they
 * ever open is asking them to forget, and a history that is kept for some of
 * your spaces and not others is worse than one you know you do not have.
 *
 * A space that has been given its own address keeps it, including the empty
 * one: turning the archive off for a single space has to survive the default
 * being on.
 */
const DEFAULT_KEY = 'cathode.archive.v1'

export function defaultArchive(): string {
  try {
    return clean(localStorage.getItem(DEFAULT_KEY) ?? '')
  } catch {
    return ''
  }
}

export function setDefaultArchive(raw: string): string {
  const url = clean(raw)
  try {
    if (url) localStorage.setItem(DEFAULT_KEY, url)
    else localStorage.removeItem(DEFAULT_KEY)
  } catch {
    /* the choice lasts for this session only */
  }
  return url
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
  /** Proof we hold the code, sent with every write. See Room.write. */
  private readonly write: string
  private url = ''
  private at = 0
  private busy = false
  /**
   * Everything written that the archive has not confirmed.
   *
   * This used to be nothing at all: push refused to run while another push was
   * in flight and dropped what it had been given, so anything said during a
   * slow request was archived nowhere. A network that hiccuped lost the same
   * way. It kept a history with holes in it and never said so, which is worse
   * than keeping none, because the holes are invisible until you need what was
   * in them.
   */
  private readonly waiting = new Map<string, LogEvent>()
  private sweeper: number | null = null
  private nextTry = 0

  constructor(room: string, key: CryptoKey, write: string) {
    this.room = room
    this.key = key
    this.write = write
  }

  get on(): boolean {
    return this.url !== ''
  }

  get address(): string {
    return this.url
  }

  /**
   * Point it somewhere, or at nothing. Returns what was actually accepted.
   *
   * A cursor counts lines in one archive, so it means nothing once the address
   * changes and is thrown away when it does. It used to be thrown away every
   * time: the address is empty until this is called, so the stored cursor never
   * matched and every visit read the whole archive from the top.
   */
  use(raw: string, at = 0): string {
    const next = clean(raw)
    const sameAddress = this.url === '' || next === this.url
    this.at = next && sameAddress ? at : 0
    this.url = next
    if (this.url) this.startSweeping()
    else this.stopSweeping()
    return this.url
  }

  /**
   * Keep trying, quietly, for as long as this space is open.
   *
   * Every event is offered the moment it is written, and the ones that did not
   * get through are offered again on a timer. Nothing is ever given up on
   * while the space is open, and nothing is ever waited on either.
   */
  private startSweeping(): void {
    if (this.sweeper !== null) return
    this.sweeper = window.setInterval(() => void this.flush(), SWEEP_MS)
  }

  private stopSweeping(): void {
    if (this.sweeper !== null) window.clearInterval(this.sweeper)
    this.sweeper = null
  }

  dispose(): void {
    this.stopSweeping()
  }

  /** How many events are still waiting to be kept. Zero is the healthy answer. */
  get pending(): number {
    return this.waiting.size
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
    const page = await this.page(this.at)
    if (!page) return []
    /*
     * An archive that got shorter trimmed itself, and trimming rewrites the
     * file, so every line number after it moved. Ours now points past the end
     * and would sit there for ever, reading nothing while the archive filled up
     * again. Start over from the top: everything already held costs one merge
     * that finds nothing new, and nothing else.
     */
    if (page.at < this.at) {
      this.at = 0
      const again = await this.page(0)
      return again ? this.take(again) : []
    }
    return this.take(page)
  }

  /** One request. Null when the archive is unreachable or unhappy. */
  private async page(from: number): Promise<{ at: number; events: unknown[] } | null> {
    try {
      const res = await globalThis.fetch(`${this.url}/events/${this.room}?from=${from}`, {
        method: 'GET',
        mode: 'cors',
      })
      if (!res.ok) return null
      const body = (await res.json()) as { at?: number; events?: unknown }
      return {
        at: typeof body.at === 'number' && body.at >= 0 ? body.at : from,
        events: Array.isArray(body.events) ? body.events : [],
      }
    } catch {
      return null
    }
  }

  /** Open what came back, and move the cursor to where it ended. */
  private async take(page: { at: number; events: unknown[] }): Promise<LogEvent[]> {
    const out: LogEvent[] = []
    for (const line of page.events) {
      if (typeof line !== 'string') continue
      const env = await unseal(this.key, line)
      if (!env?.data) continue
      out.push(env.data as unknown as LogEvent)
    }
    if (page.at >= this.at) this.at = page.at
    return out
  }

  /**
   * Hand it some events.
   *
   * Queues rather than sends. Nothing is dropped for being inconvenient: an
   * event written during a slow request waits for the next one instead of
   * vanishing, which is the difference between a history and a history with
   * holes in it.
   *
   * Never blocks anything and never reports failure, because a space whose
   * archive is down is still a space, and telling somebody their message did
   * not reach a machine they set up last month helps nobody.
   */
  push(events: LogEvent[]): void {
    if (!this.url || events.length === 0) return
    for (const event of events) this.waiting.set(event.id, event)
    void this.flush()
  }

  /** Try to empty the queue. Safe to call at any time, from anywhere. */
  async flush(): Promise<void> {
    if (!this.url || this.busy || this.waiting.size === 0) return
    if (Date.now() < this.nextTry) return
    this.busy = true
    try {
      // A copy, so anything written while this runs joins the next round
      // rather than being lost or sent twice.
      const batch = [...this.waiting.values()].slice(0, BATCH)
      const sealed = await Promise.all(batch.map((e) => seal(this.key, wrap(e))))
      const res = await globalThis.fetch(`${this.url}/events/${this.room}`, {
        method: 'POST',
        mode: 'cors',
        headers: { 'content-type': 'application/json', 'x-cathode-write': this.write },
        body: JSON.stringify(sealed),
      })
      if (!res.ok) {
        /*
         * Refused outright means the room was claimed with a different token,
         * which does not heal on its own the way an outage does. Retry rarely
         * rather than never: an archive wiped and restarted would take a fresh
         * claim, and a quiet loop every quarter hour costs nothing.
         */
        this.nextTry = Date.now() + (res.status === 403 ? RETRY_MS * 60 : RETRY_MS)
        return
      }
      // Only now, and only these. Anything added since is still waiting.
      for (const event of batch) this.waiting.delete(event.id)
      this.nextTry = 0
    } catch {
      this.nextTry = Date.now() + RETRY_MS
    } finally {
      this.busy = false
    }
    // More to go, and the last round worked, so keep going.
    if (this.waiting.size > 0 && this.nextTry === 0) void this.flush()
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
