/**
 * What this device keeps of what the server sent, so a start shows it at once. The lines stay
 * sealed, as the server holds them: this is a copy of the server's, no more readable than it.
 * Every call fails quietly. A device that cannot keep a copy loads from the server, as before.
 */

const DB_NAME = 'nook-cache'
const DB_VERSION = 2
const LINES = 'lines'
const META = 'meta'
/** The sealed bytes of each file and picture, as the server holds them, by the file's id. */
const FILES = 'files'
/** Each kept file's size and when it was last looked at: small, so a start reads it all. */
const FILE_INFO = 'file-info'
/** The kept files stay under this. The ones looked at longest ago go first. */
const FILES_MOST_BYTES = 2 * 1024 * 1024 * 1024
/** A bigger file than this is not kept: it plays from the server, as before. */
export const FILE_MOST_BYTES = 200 * 1024 * 1024
/** How often a kept file that is looked at again has its time moved on. */
const TOUCH_EVERY_MS = 60 * 60 * 1000

export interface RoomCopy {
  /** The server whose numbering `at` and the places follow. */
  server: string
  /** How far the server's lines were read: the next hello starts here. */
  at: number
  /** The sealed lines, each at its place: the first is place 0. */
  lines: string[]
}

interface RoomMeta {
  key: string
  server: string
  at: number
  count: number
}

let opening: Promise<IDBDatabase | null> | null = null
let queue: Promise<unknown> = Promise.resolve()

function db(): Promise<IDBDatabase | null> {
  opening ??= new Promise((done) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const made = request.result.objectStoreNames
        if (!made.contains(LINES)) request.result.createObjectStore(LINES, { keyPath: ['room', 'place'] })
        if (!made.contains(META)) request.result.createObjectStore(META, { keyPath: 'key' })
        if (!made.contains(FILES)) request.result.createObjectStore(FILES, { keyPath: 'id' })
        if (!made.contains(FILE_INFO)) request.result.createObjectStore(FILE_INFO, { keyPath: 'id' }).createIndex('used', 'used')
      }
      request.onsuccess = () => done(request.result)
      request.onerror = () => done(null)
      request.onblocked = () => done(null)
    } catch {
      done(null)
    }
  })
  return opening
}

function wait<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((done, fail) => {
    request.onsuccess = () => done(request.result)
    request.onerror = () => fail(request.error)
  })
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((done, fail) => {
    tx.oncomplete = () => done()
    tx.onerror = () => fail(tx.error)
    tx.onabort = () => fail(tx.error)
  })
}

/** Writes go one after the other, so a late one never lands before an early one. */
function inOrder<T>(work: () => Promise<T>): Promise<T | null> {
  const next = queue.then(work, work).catch(() => null)
  queue = next
  return next
}

/** Null when nothing is kept, or what is kept does not add up: then the server sends it all. */
export async function readRoom(room: string): Promise<RoomCopy | null> {
  const open = await db()
  if (!open) return null
  try {
    const tx = open.transaction([LINES, META], 'readonly')
    const meta = (await wait(tx.objectStore(META).get(`room:${room}`))) as RoomMeta | undefined
    if (!meta) return null
    const rows = (await wait(
      tx.objectStore(LINES).getAll(IDBKeyRange.bound([room, 0], [room, Number.MAX_SAFE_INTEGER])),
    )) as { place: number; line: string }[]
    // Whole and in order, or not used: a hole would be lines the server never sends again.
    if (rows.length !== meta.count || rows.some((row, i) => row.place !== i || typeof row.line !== 'string')) return null
    return { server: meta.server, at: meta.at, lines: rows.map((row) => row.line) }
  } catch {
    return null
  }
}

/** Keeps `lines` from place `from`, and how far the server has been read. */
export function writeRoom(room: string, server: string, from: number, lines: string[], at: number): Promise<unknown> {
  return inOrder(async () => {
    const open = await db()
    if (!open) return
    const tx = open.transaction([LINES, META], 'readwrite')
    const store = tx.objectStore(LINES)
    lines.forEach((line, i) => store.put({ room, place: from + i, line }))
    const meta: RoomMeta = { key: `room:${room}`, server, at, count: from + lines.length }
    tx.objectStore(META).put(meta)
    await finished(tx)
  })
}

export function dropRoom(room: string): Promise<unknown> {
  return inOrder(async () => {
    const open = await db()
    if (!open) return
    const tx = open.transaction([LINES, META], 'readwrite')
    tx.objectStore(LINES).delete(IDBKeyRange.bound([room, 0], [room, Number.MAX_SAFE_INTEGER]))
    tx.objectStore(META).delete(`room:${room}`)
    tx.objectStore(META).delete(`mine:${room}`)
    await finished(tx)
  })
}

/**
 * What this device wrote that the server has not sent back: it never echoes a write to the one
 * who made it, so these are in no kept place yet.
 */
export async function readMine(room: string): Promise<string[]> {
  const open = await db()
  if (!open) return []
  try {
    const found = (await wait(open.transaction(META, 'readonly').objectStore(META).get(`mine:${room}`))) as
      | { lines?: unknown }
      | undefined
    return Array.isArray(found?.lines) ? found.lines.filter((line): line is string => typeof line === 'string') : []
  } catch {
    return []
  }
}

export function writeMine(room: string, lines: string[]): Promise<unknown> {
  return inOrder(async () => {
    const open = await db()
    if (!open) return
    const tx = open.transaction(META, 'readwrite')
    tx.objectStore(META).put({ key: `mine:${room}`, lines })
    await finished(tx)
  })
}

/** What a server last sent of this person's own record: sealed with their key, as there. */
export async function readPeople(server: string): Promise<string | null> {
  const open = await db()
  if (!open) return null
  try {
    const found = (await wait(open.transaction(META, 'readonly').objectStore(META).get(`people:${server}`))) as
      | { blob?: unknown }
      | undefined
    return typeof found?.blob === 'string' ? found.blob : null
  } catch {
    return null
  }
}

export function writePeople(server: string, blob: string): Promise<unknown> {
  return inOrder(async () => {
    const open = await db()
    if (!open) return
    const tx = open.transaction(META, 'readwrite')
    tx.objectStore(META).put({ key: `people:${server}`, blob })
    await finished(tx)
  })
}

interface FileInfo {
  id: string
  size: number
  /** When it was last looked at. */
  used: number
}

/** The ids of the files kept here, known at once, so a video kept here plays from it, not as a stream. */
const keptIds = new Set<string>()
let keptBytes = 0
const listed = (async () => {
  const open = await db()
  if (!open) return
  try {
    const all = (await wait(open.transaction(FILE_INFO, 'readonly').objectStore(FILE_INFO).getAll())) as FileInfo[]
    for (const info of all) {
      keptIds.add(info.id)
      keptBytes += info.size || 0
    }
  } catch {
    /* the list stays empty: files load from the server */
  }
})()

export function fileKept(id: string): boolean {
  return keptIds.has(id)
}

/** The sealed bytes of a file kept here, or null. */
export async function readFile(id: string): Promise<Blob | null> {
  await listed
  if (!keptIds.has(id)) return null
  const open = await db()
  if (!open) return null
  try {
    const tx = open.transaction([FILES, FILE_INFO], 'readonly')
    const info = (await wait(tx.objectStore(FILE_INFO).get(id))) as FileInfo | undefined
    const found = (await wait(tx.objectStore(FILES).get(id))) as { sealed?: unknown } | undefined
    if (!info || !(found?.sealed instanceof Blob)) {
      keptIds.delete(id)
      return null
    }
    if (Date.now() - info.used > TOUCH_EVERY_MS) {
      void inOrder(async () => {
        const touch = open.transaction(FILE_INFO, 'readwrite')
        touch.objectStore(FILE_INFO).put({ ...info, used: Date.now() } satisfies FileInfo)
        await finished(touch)
      })
    }
    return found.sealed
  } catch {
    return null
  }
}

/** Keeps a file's sealed bytes. The ones looked at longest ago go to make room. */
export function writeFile(id: string, sealed: Blob): Promise<unknown> {
  if (sealed.size > FILE_MOST_BYTES || keptIds.has(id)) return Promise.resolve()
  keptIds.add(id)
  return inOrder(async () => {
    await listed
    const open = await db()
    if (!open) return
    try {
      if (keptBytes + sealed.size > FILES_MOST_BYTES) await makeRoom(open, keptBytes + sealed.size - FILES_MOST_BYTES)
      const tx = open.transaction([FILES, FILE_INFO], 'readwrite')
      tx.objectStore(FILES).put({ id, sealed })
      tx.objectStore(FILE_INFO).put({ id, size: sealed.size, used: Date.now() } satisfies FileInfo)
      await finished(tx)
      keptBytes += sealed.size
    } catch {
      // The disk is full, or the browser keeps no more: it loads from the server next time.
      keptIds.delete(id)
    }
  })
}

async function makeRoom(open: IDBDatabase, needed: number): Promise<void> {
  const tx = open.transaction([FILES, FILE_INFO], 'readwrite')
  const bytes = tx.objectStore(FILES)
  let freed = 0
  await new Promise<void>((done, fail) => {
    const cursor = tx.objectStore(FILE_INFO).index('used').openCursor()
    cursor.onerror = () => fail(cursor.error)
    cursor.onsuccess = () => {
      const at = cursor.result
      if (!at || freed >= needed) return done()
      const info = at.value as FileInfo
      freed += info.size || 0
      keptIds.delete(info.id)
      bytes.delete(info.id)
      at.delete()
      at.continue()
    }
  })
  await finished(tx)
  keptBytes = Math.max(0, keptBytes - freed)
}

/** What a server said about a link last time, for its card. */
export async function readPreview(key: string): Promise<unknown> {
  const open = await db()
  if (!open) return null
  try {
    const found = (await wait(open.transaction(META, 'readonly').objectStore(META).get(`preview:${key}`))) as
      | { card?: unknown }
      | undefined
    return found?.card ?? null
  } catch {
    return null
  }
}

export function writePreview(key: string, card: unknown): Promise<unknown> {
  return inOrder(async () => {
    const open = await db()
    if (!open) return
    const tx = open.transaction(META, 'readwrite')
    tx.objectStore(META).put({ key: `preview:${key}`, card })
    await finished(tx)
  })
}

/** A log out: what this device kept goes with the rest. */
export async function wipeCache(): Promise<void> {
  try {
    const open = await db()
    open?.close()
    opening = null
    keptIds.clear()
    keptBytes = 0
    await new Promise<void>((done) => {
      const request = indexedDB.deleteDatabase(DB_NAME)
      request.onsuccess = () => done()
      request.onerror = () => done()
      request.onblocked = () => done()
    })
  } catch {
    /* nothing was kept */
  }
}
