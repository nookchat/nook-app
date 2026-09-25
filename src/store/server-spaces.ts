import { BUILT_IN_SERVER, defaultServer, serverUrl, setDefaultServer } from '../backend'
import { fromBase64, toBase64, toHex } from '../bytes'
import { ask } from '../net/cluster'
import { personalBytes } from './identity'
import { roomsChanged, type RoomNote } from './notes'
import { localPrefs, takePrefs, watchPrefs } from './prefs'

const SERVERS_KEY = 'nook.servers.v1'
const OWN_KEY = 'nook.own.v1'
const SAVE_MS = 2000
const SAVE_SOON_MS = 300
const RETRY_MS = SAVE_MS * 10

/** JSON with sorted object keys, so equal values give equal strings. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  )
}

function withoutMarks(note: RoomNote & { changed?: number; gone?: boolean }): Record<string, unknown> {
  const { read: _read, readDm: _readDm, lastSeen: _lastSeen, changed: _changed, gone: _gone, ...rest } = note
  return rest
}

interface Kept extends RoomNote {
  changed: number
  /** Tombstone, so a merge with an older copy does not bring the space back. */
  gone?: boolean
}

interface Keys {
  id: string
  token: string
  key: CryptoKey
}

let keys: Promise<Keys> | null = null

function personal(): Promise<Keys> {
  keys ??= (async () => {
    const id = toHex(await personalBytes('nook-me-id'))
    const token = toHex(await personalBytes('nook-me-write'))
    const key = await crypto.subtle.importKey(
      'raw',
      (await personalBytes('nook-me-key')) as BufferSource,
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
  return `${toBase64(iv)}.${toBase64(sealed)}`
}

async function unseal(key: CryptoKey, blob: string): Promise<unknown> {
  const [iv, body] = blob.split('.')
  if (!iv || !body) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv) },
      key,
      fromBase64(body),
    )
    return JSON.parse(new TextDecoder().decode(plain))
  } catch {
    return null
  }
}

export class ServerBook {
  readonly server: string
  private notes = new Map<string, Kept>()
  private loading: Promise<void> | null = null
  private timer = 0
  private due = 0
  private saving: Promise<void> = Promise.resolve()

  constructor(server: string) {
    this.server = server
  }

  load(): Promise<void> {
    this.loading ??= this.pull().then((notes) => {
      if (notes === null) this.loading = null
      for (const note of notes ?? []) this.take(note)
      if (notes?.length) roomsChanged()
    })
    return this.loading
  }

  async list(): Promise<RoomNote[]> {
    await this.load()
    return [...this.notes.values()].filter((n) => !n.gone).map(strip)
  }

  async get(room: string): Promise<RoomNote | null> {
    await this.load()
    const note = this.notes.get(room)
    return note && !note.gone ? strip(note) : null
  }

  async put(note: RoomNote): Promise<void> {
    await this.load()
    const was = this.notes.get(note.room)
    this.notes.set(note.room, { ...structuredClone(note), server: this.server, changed: Date.now() })
    const fresh = !was || was.gone === true
    const onlyRead = !fresh && stable(withoutMarks(was)) === stable(withoutMarks(note))
    this.later(fresh ? 0 : onlyRead ? SAVE_MS : SAVE_SOON_MS)
  }

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

  touch(): void {
    void this.load().then(() => this.later(SAVE_MS))
  }

  flush(): Promise<void> {
    if (this.timer) {
      window.clearTimeout(this.timer)
      this.timer = 0
      this.queuePush()
    }
    return this.saving
  }

  private take(note: Kept): void {
    const held = this.notes.get(note.room)
    if (!held || (note.changed ?? 0) > (held.changed ?? 0)) this.notes.set(note.room, note)
  }

  private queuePush(): void {
    this.saving = this.saving.then(() => this.push())
  }

  private later(delay: number): void {
    roomsChanged()
    const at = Date.now() + delay
    if (this.timer && this.due <= at) return
    window.clearTimeout(this.timer)
    this.due = at
    this.timer = window.setTimeout(() => {
      this.timer = 0
      this.due = 0
      this.queuePush()
    }, delay)
  }

  /** Null when unreadable: a save must never overwrite a record it could not read. */
  private async pull(): Promise<Kept[] | null> {
    try {
      const { id, key } = await personal()
      const res = await ask(this.server, `/api/v1/people/${id}`)
      if (!res?.ok) return null
      const body = (await res.json()) as { blob?: unknown }
      if (body.blob === null || body.blob === undefined) return []
      if (typeof body.blob !== 'string') return null
      const record = (await unseal(key, body.blob)) as { notes?: unknown; prefs?: unknown } | null
      if (!record) return null
      takePrefs(record.prefs)
      return Array.isArray(record.notes)
        ? (record.notes.filter((n) => n && typeof n === 'object' && typeof (n as Kept).room === 'string') as Kept[])
        : []
    } catch {
      return null
    }
  }

  private async push(): Promise<void> {
    try {
      const theirs = await this.pull()
      if (theirs === null) {
        this.timer = window.setTimeout(() => {
          this.timer = 0
          this.queuePush()
        }, RETRY_MS)
        return
      }
      for (const note of theirs) this.take(note)
      const { id, token, key } = await personal()
      const blob = await seal(key, { notes: [...this.notes.values()], prefs: localPrefs() })
      await ask(this.server, `/api/v1/people/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-nook-write': token },
        body: JSON.stringify({ blob }),
        // Browsers cap keepalive bodies at 64 KiB.
        keepalive: blob.length < 60_000,
      })
    } catch {}
  }
}

function strip(note: Kept): RoomNote {
  const { changed: _changed, gone: _gone, ...rest } = note
  return rest
}

const books = new Map<string, ServerBook>()

watchPrefs(() => {
  for (const server of knownServers()) bookFor(server).touch()
})

export function bookFor(server: string): ServerBook {
  const url = serverUrl(server)
  let book = books.get(url)
  if (!book) {
    book = new ServerBook(url)
    books.set(url, book)
  }
  return book
}

export function knownServers(): string[] {
  const all = [...(BUILT_IN_SERVER ? [BUILT_IN_SERVER] : []), ...readList(SERVERS_KEY), ...ownServers()]
  return [...new Set(all.map(serverUrl).filter(Boolean))]
}

export function ownServers(): string[] {
  let own = readList(OWN_KEY, null)
  // Legacy: before OWN_KEY existed, the picked server was always the user's own.
  if (own === null) {
    try {
      const picked = serverUrl(localStorage.getItem('nook.server.v1') ?? '')
      own = picked ? [picked] : []
    } catch {
      own = []
    }
  }
  const all = [...(BUILT_IN_SERVER ? [BUILT_IN_SERVER] : []), ...own]
  return [...new Set(all.map(serverUrl).filter(Boolean))]
}

export function newSpaceServer(): string {
  const own = ownServers()
  const picked = defaultServer()
  return own.includes(picked) ? picked : (own[0] ?? '')
}

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

export function adoptServers(known: string[], own: string[], pick: string): void {
  const clean = (list: string[]): string[] => list.map(serverUrl).filter(Boolean)
  writeList(SERVERS_KEY, [...readList(SERVERS_KEY), ...clean(known)])
  writeList(OWN_KEY, [...(readList(OWN_KEY, null) ?? ownServers()), ...clean(own)])
  if (serverUrl(pick)) setDefaultServer(serverUrl(pick))
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
  } catch {}
}
