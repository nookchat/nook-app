import { BUILT_IN_SERVER } from '../backend'
import type { RoomNote } from './notes'
import { bookFor, knownServers } from './server-spaces'

const SLOW_SERVER_MS = 1200

function servers(): string[] {
  const all = knownServers()
  return BUILT_IN_SERVER && !all.includes(BUILT_IN_SERVER) ? [BUILT_IN_SERVER, ...all] : all
}

/** `patient` waits for every server, however slow, in place of leaving a slow one out. */
export async function listSpaces(patient = false): Promise<RoomNote[]> {
  const slow = (): Promise<RoomNote[]> => new Promise((done) => window.setTimeout(() => done([]), SLOW_SERVER_MS))
  const lists = await Promise.all(
    servers().map((server) => (patient ? bookFor(server).list() : Promise.race([bookFor(server).list(), slow()]))),
  )
  return lists.flat().sort((a, b) => b.lastSeen - a.lastSeen)
}

/**
 * The note for a space, the one with its password first. A wrong password once opened an empty
 * space that kept its own note, so of those with a password, one with a name goes first.
 */
export async function findSpace(secret: string, server?: string, patient = false): Promise<RoomNote | null> {
  const mine = (await listSpaces(patient)).filter(
    (r) => r.secret === secret && (server === undefined || (r.server ?? '') === server),
  )
  return mine.find((r) => r.locked && r.password && r.title) ?? mine.find((r) => r.locked && r.password) ?? mine[0] ?? null
}

export async function forgetSpace(note: RoomNote): Promise<void> {
  if (note.server) await bookFor(note.server).forget(note.room)
}
