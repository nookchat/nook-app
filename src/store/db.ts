/**
 * The store on this device.
 *
 * This is the whole answer to "will it still be there tomorrow". It will,
 * because you have it: every event you have ever seen in a room is written to
 * IndexedDB on arrival, and read back on the next visit before any peer is
 * contacted. History renders offline, instantly, with nobody else online.
 *
 * A server is only needed for the narrower case of catching up on what was said
 * while you were away, which is a different problem and a later stage.
 */

import type { LogEvent } from './log'

const DB_NAME = 'cathode'
const DB_VERSION = 1
const EVENTS = 'events'
const ROOMS = 'rooms'

/** Nothing here is worth an exception. A store that will not open is a store we do without. */
let opening: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening
  opening = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(EVENTS)) {
        const store = db.createObjectStore(EVENTS, { keyPath: 'id' })
        store.createIndex('room', 'room', { unique: false })
      }
      if (!db.objectStoreNames.contains(ROOMS)) {
        db.createObjectStore(ROOMS, { keyPath: 'room' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return opening
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store)
}

/** Write events, ignoring any that are already there. */
export async function putEvents(events: LogEvent[]): Promise<void> {
  if (events.length === 0) return
  const db = await open()
  if (!db) return
  await new Promise<void>((resolve) => {
    let store: IDBObjectStore
    try {
      const transaction = db.transaction(EVENTS, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
      store = transaction.objectStore(EVENTS)
    } catch {
      resolve()
      return
    }
    for (const event of events) {
      try {
        store.put(event)
      } catch {
        // One bad record must not lose the rest of the batch.
      }
    }
  })
}

/** Everything this device holds for one room. */
export async function loadRoom(room: string): Promise<LogEvent[]> {
  const db = await open()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const request = tx(db, EVENTS, 'readonly').index('room').getAll(room)
      request.onsuccess = () => resolve((request.result as LogEvent[]) ?? [])
      request.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

export interface RoomNote {
  room: string
  /** The code, so a room can be reopened from the list without the link. */
  secret: string
  lastSeen: number
  title: string
}

/** Remember that this room exists, so it can be listed and reopened. */
export async function noteRoom(note: RoomNote): Promise<void> {
  const db = await open()
  if (!db) return
  try {
    tx(db, ROOMS, 'readwrite').put(note)
  } catch {
    /* nothing to do */
  }
}

export async function listRooms(): Promise<RoomNote[]> {
  const db = await open()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const request = tx(db, ROOMS, 'readonly').getAll()
      request.onsuccess = () =>
        resolve(((request.result as RoomNote[]) ?? []).sort((a, b) => b.lastSeen - a.lastSeen))
      request.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

/** Forget one room and everything said in it. */
export async function forgetRoom(room: string): Promise<void> {
  const db = await open()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction([EVENTS, ROOMS], 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      const store = transaction.objectStore(EVENTS)
      const cursor = store.index('room').openKeyCursor(room)
      cursor.onsuccess = () => {
        const c = cursor.result
        if (!c) return
        store.delete(c.primaryKey)
        c.continue()
      }
      transaction.objectStore(ROOMS).delete(room)
    } catch {
      resolve()
    }
  })
}
