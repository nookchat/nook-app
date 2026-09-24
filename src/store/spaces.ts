/**
 * Every space you are in, wherever it is kept.
 *
 * A peer to peer space keeps its note on this device, in IndexedDB. A space on
 * a server keeps its note on that server (see server-spaces.ts). The rail and
 * the home screen want one list, so this is the one list.
 *
 * A space on a server that this device noted before notes moved to the server
 * is moved there the first time it is seen, and its events are taken off this
 * device, because a space on a server keeps nothing here.
 */

import { forgetRoom, listRooms, type RoomNote } from './db'
import { addServer, bookFor, knownServers } from './server-spaces'

let moved: Promise<void> | null = null

/** Move any server space still noted on this device to its server, once. */
function moveOld(): Promise<void> {
  moved ??= (async () => {
    for (const note of await listRooms()) {
      if (!note.server) continue
      addServer(note.server)
      const book = bookFor(note.server)
      if (!(await book.get(note.room))) await book.put(note)
      await forgetRoom(note.room)
    }
  })()
  return moved
}

export async function listSpaces(): Promise<RoomNote[]> {
  await moveOld()
  /*
   * A server slow to answer does not hold the list up: it is drawn without
   * that server's spaces, and drawn again when they arrive (see ServerBook).
   */
  const slow = (): Promise<RoomNote[]> => new Promise((done) => window.setTimeout(() => done([]), 1200))
  const [local, ...remote] = await Promise.all([
    listRooms(),
    ...knownServers().map((server) => Promise.race([bookFor(server).list(), slow()])),
  ])
  return [...local.filter((n) => !n.server), ...remote.flat()].sort((a, b) => b.lastSeen - a.lastSeen)
}

/** A space by its code, preferring the one on the named server when there is one. */
export async function findSpace(secret: string, server?: string): Promise<RoomNote | null> {
  const mine = (await listSpaces()).filter(
    (r) => r.secret === secret && (server === undefined || (r.server ?? '') === server),
  )
  return mine.find((r) => r.locked && r.password) ?? mine[0] ?? null
}

/** Take a space off your list: off this device, or out of your record on its server. */
export async function forgetSpace(note: RoomNote): Promise<void> {
  if (note.server) await bookFor(note.server).forget(note.room)
  else await forgetRoom(note.room)
}
