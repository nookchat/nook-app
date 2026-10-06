/**
 * What this device keeps of what the server sent, so a start shows it at once. The lines stay
 * sealed, as the server holds them: this is a copy of the server's, no more readable than it.
 * Every call fails quietly. A device that cannot keep a copy loads from the server, as before.
 */

const DB_NAME = 'nook-cache'
const LINES = 'lines'
const META = 'meta'

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
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(LINES, { keyPath: ['room', 'place'] })
        request.result.createObjectStore(META, { keyPath: 'key' })
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

/** A log out: what this device kept goes with the rest. */
export async function wipeCache(): Promise<void> {
  try {
    const open = await db()
    open?.close()
    opening = null
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
