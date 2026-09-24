/**
 * Your spaces on a server, kept on the server.
 *
 * A space that runs on a server keeps nothing on this device: not its
 * history, and not the note that says you are in it, what it is called, its
 * password, or how far you have read. That note lives on the server instead,
 * in one record per person, sealed with a key made from your identity. The
 * server holds it without being able to read it, and any device holding the
 * same identity (see link-device.ts) reads the same record, which is how a
 * second device finds your spaces without being told.
 *
 * The record holds one RoomNote per space (store/notes.ts): its code, its
 * name, its server, and how far you have read.
 *
 * Two devices can write at once. A save reads the record first and merges,
 * newest note per space winning, and a space you leave is kept as a
 * tombstone so the merge does not bring it back.
 */

import { BUILT_IN_SERVER, defaultServer, serverUrl, setDefaultServer } from '../backend'
import { roomsChanged, type RoomNote } from './notes'
import { personalBytes } from './identity'
import { ask } from '../net/cluster'

const SERVERS_KEY = 'cathode.servers.v1'
/** The servers this person added themselves, as against ones an invite led to. */
const OWN_KEY = 'cathode.own.v1'
/** How long after the last change a save waits, so a burst is one write. */
const SAVE_MS = 2000
/** The same, for a change worth having everywhere quickly, such as a name. */
const SOON_MS = 300

/** JSON with every object's keys in order, so two equal values are equal strings. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  )
}

/** A note with how far you have read, and when you were here, taken out. */
function withoutMarks(note: RoomNote & { changed?: number; gone?: boolean }): Record<string, unknown> {
  const { read: _read, readDm: _readDm, lastSeen: _lastSeen, changed: _changed, gone: _gone, ...rest } = note
  return rest
}

interface Kept extends RoomNote {
  /** When this note last changed, for the merge. */
  changed: number
  /** Left on purpose. Kept so a merge with an older copy does not undo it. */
  gone?: boolean
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function b64(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return btoa(out)
}

function unb64(text: string): Uint8Array {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

interface Keys {
  id: string
  token: string
  key: CryptoKey
}

let keys: Promise<Keys> | null = null

function personal(): Promise<Keys> {
  keys ??= (async () => {
    const id = toHex(await personalBytes('cathode-me-id'))
    const token = toHex(await personalBytes('cathode-me-write'))
    const key = await crypto.subtle.importKey(
      'raw',
      (await personalBytes('cathode-me-key')) as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    )
    return { id, token, key }
  })()
  return keys
}

async function seal(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify(value))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
  return `${b64(iv)}.${b64(sealed)}`
}

async function unseal(key: CryptoKey, blob: string): Promise<unknown> {
  const [iv, body] = blob.split('.')
  if (!iv || !body) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(iv) as BufferSource },
      key,
      unb64(body) as BufferSource,
    )
    return JSON.parse(new TextDecoder().decode(plain))
  } catch {
    return null
  }
}

/** One server's record of your spaces on it. */
export class ServerBook {
  readonly server: string
  private notes = new Map<string, Kept>()
  private loading: Promise<void> | null = null
  private timer = 0
  private saving: Promise<void> = Promise.resolve()

  constructor(server: string) {
    this.server = server
  }

  /** Read the record, once. Later calls wait on the same read. */
  load(): Promise<void> {
    this.loading ??= this.pull().then((notes) => {
      // Not readable: ask again next time rather than believe it is empty.
      if (notes === null) this.loading = null
      for (const note of notes ?? []) this.take(note)
      // Whoever drew a list without these, draw it again.
      if (notes?.length) roomsChanged()
    })
    return this.loading
  }

  /** Every space you are in on this server. */
  async list(): Promise<RoomNote[]> {
    await this.load()
    return [...this.notes.values()].filter((n) => !n.gone).map(strip)
  }

  async get(room: string): Promise<RoomNote | null> {
    await this.load()
    const note = this.notes.get(room)
    return note && !note.gone ? strip(note) : null
  }

  async findBySecret(secret: string): Promise<RoomNote | null> {
    const mine = (await this.list()).filter((r) => r.secret === secret)
    return mine.find((r) => r.locked && r.password) ?? mine[0] ?? null
  }

  /** Write a note for a space, and save the record soon. */
  async put(note: RoomNote): Promise<void> {
    await this.load()
    const was = this.notes.get(note.room)
    // A copy: the note handed in may be changed by its owner afterwards.
    this.notes.set(note.room, { ...structuredClone(note), server: this.server, changed: Date.now() })
    /*
     * A space you just joined, or renamed, is on your other devices at once.
     * How far you have read changes with every message and can wait a moment.
     */
    const fresh = !was || was.gone === true
    const onlyRead = !fresh && stable(withoutMarks(was)) === stable(withoutMarks(note))
    this.later(fresh ? 0 : onlyRead ? SAVE_MS : SOON_MS)
  }

  /** Leave: the note goes, and stays gone on every device. */
  async forget(room: string): Promise<void> {
    await this.load()
    const was = this.notes.get(room)
    this.notes.set(room, {
      room,
      secret: was?.secret ?? '',
      title: '',
      lastSeen: 0,
      server: this.server,
      changed: Date.now(),
      gone: true,
    })
    this.later(0)
  }

  /** Save now rather than in a moment. For a page about to go away. */
  flush(): Promise<void> {
    if (this.timer) {
      window.clearTimeout(this.timer)
      this.timer = 0
      this.saving = this.saving.then(() => this.push())
    }
    return this.saving
  }

  private take(note: Kept): void {
    const held = this.notes.get(note.room)
    if (!held || (note.changed ?? 0) > (held.changed ?? 0)) this.notes.set(note.room, note)
  }

  /** When the save waiting now will run, so a later change never pushes it back. */
  private due = 0

  private later(delay = SAVE_MS): void {
    roomsChanged()
    const at = Date.now() + delay
    if (this.timer && this.due <= at) return
    window.clearTimeout(this.timer)
    this.due = at
    this.timer = window.setTimeout(() => {
      this.timer = 0
      this.due = 0
      this.saving = this.saving.then(() => this.push())
    }, delay)
  }

  /**
   * The record as the server has it. Empty when there is none yet, and null
   * when it could not be read: the difference is whether a save may go ahead,
   * because writing over a record this device could not read would throw
   * away every space the other devices put in it.
   */
  private async pull(): Promise<Kept[] | null> {
    try {
      const { id, key } = await personal()
      // Any server in the cluster has the same record.
      const res = await ask(this.server, `/api/v1/people/${id}`)
      if (!res?.ok) return null
      const body = (await res.json()) as { blob?: unknown }
      if (body.blob === null || body.blob === undefined) return []
      if (typeof body.blob !== 'string') return null
      const record = (await unseal(key, body.blob)) as { notes?: unknown } | null
      if (!record) return null
      return Array.isArray(record.notes)
        ? (record.notes.filter((n) => n && typeof n === 'object' && typeof (n as Kept).room === 'string') as Kept[])
        : []
    } catch {
      return null
    }
  }

  /** Read, merge, write: another device may have saved since this one read. */
  private async push(): Promise<void> {
    try {
      const theirs = await this.pull()
      // Not readable just now: keep this device's changes for the next try.
      if (theirs === null) {
        this.timer = window.setTimeout(() => {
          this.timer = 0
          this.saving = this.saving.then(() => this.push())
        }, SAVE_MS * 10)
        return
      }
      for (const note of theirs) this.take(note)
      const { id, token, key } = await personal()
      const blob = await seal(key, { notes: [...this.notes.values()] })
      await ask(this.server, `/api/v1/people/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-cathode-write': token },
        body: JSON.stringify({ blob }),
        // A small record still lands if the page is closing as it is sent.
        keepalive: blob.length < 60_000,
      })
    } catch {
      // Offline, or the server is down. The next change tries again.
    }
  }
}

function strip(note: Kept): RoomNote {
  const { changed: _changed, gone: _gone, ...rest } = note
  return rest
}

const books = new Map<string, ServerBook>()

/** The record for one server, made once per page. */
export function bookFor(server: string): ServerBook {
  const url = serverUrl(server)
  let book = books.get(url)
  if (!book) {
    book = new ServerBook(url)
    books.set(url, book)
  }
  return book
}

/**
 * The servers this device has spaces on, so it knows where to ask.
 *
 * Addresses only, never what is on them. It is the one thing about a space on
 * a server that has to be on the device, because it is how the device finds
 * the server that holds the rest.
 */
export function knownServers(): string[] {
  const all = [...(BUILT_IN_SERVER ? [BUILT_IN_SERVER] : []), ...readList(SERVERS_KEY), ...ownServers()]
  return [...new Set(all.map(serverUrl).filter(Boolean))]
}

/**
 * The servers this person added themselves. New spaces go only to these.
 *
 * An invite brings its server with it, and a space you joined lives there,
 * but a friend's server is not yours to fill: joining somebody's space does
 * not make their server the place your own spaces go. You add a server by
 * hand for that, in Settings or on the home page.
 */
export function ownServers(): string[] {
  let own = readList(OWN_KEY, null)
  // Before the two lists were apart, the one picked for new spaces was yours.
  if (own === null) {
    try {
      const picked = serverUrl(localStorage.getItem('cathode.server.v1') ?? '')
      own = picked ? [picked] : []
    } catch {
      own = []
    }
  }
  const all = [...(BUILT_IN_SERVER ? [BUILT_IN_SERVER] : []), ...own]
  return [...new Set(all.map(serverUrl).filter(Boolean))]
}

/** Where a new space goes: the one picked, if it is yours, or your first. Empty when you have none. */
export function newSpaceServer(): string {
  const own = ownServers()
  const picked = defaultServer()
  return own.includes(picked) ? picked : (own[0] ?? '')
}

/**
 * Remember a server. `mine` for one this person added themselves, which is
 * then also where new spaces go if there was nowhere before.
 */
export function addServer(server: string, mine = false): void {
  const url = serverUrl(server)
  if (!url) return
  if (!knownServers().includes(url)) writeList(SERVERS_KEY, [...readList(SERVERS_KEY), url])
  if (mine && !ownServers().includes(url)) {
    const first = newSpaceServer() === ''
    writeList(OWN_KEY, [...(readList(OWN_KEY, null) ?? ownServers()), url])
    if (first) setDefaultServer(url)
  }
}

function readList(key: string): string[]
function readList(key: string, missing: null): string[] | null
function readList(key: string, missing: string[] | null = []): string[] | null {
  try {
    const held = localStorage.getItem(key)
    if (held === null) return missing
    const raw = JSON.parse(held) as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : missing
  } catch {
    return missing
  }
}

function writeList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify([...new Set(list)]))
  } catch {
    /* known for this visit only */
  }
}
