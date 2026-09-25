import { BUILT_IN_SERVER } from '../backend'
import type { RoomNote } from './notes'
import { bookFor, knownServers } from './server-spaces'

const SLOW_SERVER_MS = 1200

function servers(): string[] {
  const all = knownServers()
  return BUILT_IN_SERVER && !all.includes(BUILT_IN_SERVER) ? [BUILT_IN_SERVER, ...all] : all
}

export async function listSpaces(): Promise<RoomNote[]> {
  const slow = (): Promise<RoomNote[]> => new Promise((done) => window.setTimeout(() => done([]), SLOW_SERVER_MS))
  const lists = await Promise.all(servers().map((server) => Promise.race([bookFor(server).list(), slow()])))
  return lists.flat().sort((a, b) => b.lastSeen - a.lastSeen)
}

export async function findSpace(secret: string, server?: string): Promise<RoomNote | null> {
  const mine = (await listSpaces()).filter(
    (r) => r.secret === secret && (server === undefined || (r.server ?? '') === server),
  )
  return mine.find((r) => r.locked && r.password) ?? mine[0] ?? null
}

export async function forgetSpace(note: RoomNote): Promise<void> {
  if (note.server) await bookFor(note.server).forget(note.room)
}
