import { ApiError } from './http.mjs'

export const LINK_ID = /^[0-9a-f]{32}$/
const TTL_MS = 10 * 60 * 1000
const MAX_WAITING = 2000
/** A link carries a key, a name and a few server addresses: a few kilobytes. */
export const MAX_LINK = 64 * 1024
/** Links waiting from one address: a person links a device or two at a time. */
const MAX_PER_ADDRESS = 5

const held = new Map()

function sweep() {
  const now = Date.now()
  for (const [id, link] of held) if (link.until <= now) held.delete(id)
}

export function putLink(id, blob, address = '') {
  sweep()
  if (typeof blob !== 'string' || blob.length === 0 || blob.length > MAX_LINK) {
    throw new ApiError(400, 'bad_body', 'A link is one sealed string.')
  }
  if (held.has(id)) throw new ApiError(409, 'taken', 'That link is already waiting.')
  if (held.size >= MAX_WAITING) throw new ApiError(503, 'busy', 'Too many links are waiting. Try again in a few minutes.')
  let mine = 0
  for (const link of held.values()) if (link.address === address) mine += 1
  if (mine >= MAX_PER_ADDRESS) throw new ApiError(429, 'slow_down', 'Too many links are waiting from here. Try again in a few minutes.')
  const until = Date.now() + TTL_MS
  held.set(id, { blob, until, address })
  return { ok: true, until }
}

export function takeLink(id) {
  sweep()
  const link = held.get(id)
  if (!link) throw new ApiError(404, 'gone', 'That code has been used, or has run out.')
  held.delete(id)
  return { blob: link.blob }
}

setInterval(sweep, 60_000).unref()
