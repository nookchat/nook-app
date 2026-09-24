/**
 * Every space you are in, from every server you use, as one list: what the
 * rail and home draw. The notes live in your sealed record on each server
 * (see server-spaces.ts); nothing about a space is kept on this device.
 */

import { BUILT_IN_SERVER } from '../backend'
import type { RoomNote } from './notes'
import { bookFor, knownServers } from './server-spaces'

function servers(): string[] {
  const all = knownServers()
  return BUILT_IN_SERVER && !all.includes(BUILT_IN_SERVER) ? [BUILT_IN_SERVER, ...all] : all
}

export async function listSpaces(): Promise<RoomNote[]> {
  /*
   * A server slow to answer does not hold the list up: it is drawn without
   * that server's spaces, and drawn again when they arrive (see ServerBook).
   */
  const slow = (): Promise<RoomNote[]> => new Promise((done) => window.setTimeout(() => done([]), 1200))
  const lists = await Promise.all(servers().map((server) => Promise.race([bookFor(server).list(), slow()])))
  return lists.flat().sort((a, b) => b.lastSeen - a.lastSeen)
}

/** A space by its code, preferring the one on the named server when there is one. */
export async function findSpace(secret: string, server?: string): Promise<RoomNote | null> {
  const mine = (await listSpaces()).filter(
    (r) => r.secret === secret && (server === undefined || (r.server ?? '') === server),
  )
  return mine.find((r) => r.locked && r.password) ?? mine[0] ?? null
}

/** Take a space off your list, on every device. */
export async function forgetSpace(note: RoomNote): Promise<void> {
  if (note.server) await bookFor(note.server).forget(note.room)
}
