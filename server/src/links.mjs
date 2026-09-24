/**
 * Linking a device: the one moment somebody's identity crosses a server.
 *
 * The device they already use makes a code, seals everything the new one
 * needs (the key, the name, the picture, which servers hold their spaces)
 * with a key made from that code, and leaves it here. The new device, given
 * the code, asks for it by an id also made from the code, and opens it.
 *
 * This holds a sealed blob it cannot open, under a name that says nothing,
 * for ten minutes at the most, and hands it out once: the first read takes
 * it away. It is kept in memory only, never in the database or on disk, so a
 * restart forgets every link, which costs somebody a second try at worst.
 */

import { ApiError } from './http.mjs'

export const LINK_ID = /^[0-9a-f]{32}$/
const TTL_MS = 10 * 60 * 1000
const MOST = 2000
export const MAX_LINK = 256 * 1024

const held = new Map()

function sweep() {
  const now = Date.now()
  for (const [id, link] of held) if (link.until <= now) held.delete(id)
}

export function putLink(id, blob) {
  sweep()
  if (typeof blob !== 'string' || blob.length === 0 || blob.length > MAX_LINK) {
    throw new ApiError(400, 'bad_body', 'A link is one sealed string.')
  }
  if (held.has(id)) throw new ApiError(409, 'taken', 'That link is already waiting.')
  if (held.size >= MOST) throw new ApiError(503, 'busy', 'Too many links are waiting. Try again in a few minutes.')
  held.set(id, { blob, until: Date.now() + TTL_MS })
  return { ok: true, until: Date.now() + TTL_MS }
}

export function takeLink(id) {
  sweep()
  const link = held.get(id)
  if (!link) throw new ApiError(404, 'gone', 'That code has been used, or has run out.')
  held.delete(id)
  return { blob: link.blob }
}

setInterval(sweep, 60_000).unref()
