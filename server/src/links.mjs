import { ApiError } from './http.mjs'

export const LINK_ID = /^[0-9a-f]{32}$/
const TTL_MS = 10 * 60 * 1000
const MAX_WAITING = 2000
/** A link carries a key, a name and a few server addresses: a few kilobytes. */
export const MAX_LINK = 64 * 1024
/** Links waiting from one address: a person links a device or two at a time. */
const MAX_PER_ADDRESS = 5

/** How long a question about a link's state waits for it to change. Under what a proxy lets wait. */
const STATE_WAIT_MS = 25_000

/**
 * Each link by its id. A taken link stays, without what it carried, until it runs out, so the
 * device that made it can learn what happened: waiting, opened (taken), then linked or declined.
 */
const held = new Map()
/** The questions waiting for a link's state to change, by its id. */
const watchers = new Map()

function tell(id) {
  const waiting = watchers.get(id)
  if (!waiting) return
  watchers.delete(id)
  for (const done of waiting) done()
}

function sweep() {
  const now = Date.now()
  for (const [id, link] of held) {
    if (link.until > now) continue
    held.delete(id)
    tell(id)
  }
}

export function putLink(id, blob, address = '') {
  sweep()
  if (typeof blob !== 'string' || blob.length === 0 || blob.length > MAX_LINK) {
    throw new ApiError(400, 'bad_body', 'A link is one sealed string.')
  }
  if (held.has(id)) throw new ApiError(409, 'taken', 'That link is already waiting.')
  if (held.size >= MAX_WAITING) throw new ApiError(503, 'busy', 'Too many links are waiting. Try again in a few minutes.')
  let mine = 0
  for (const link of held.values()) if (link.address === address && link.state === 'waiting') mine += 1
  if (mine >= MAX_PER_ADDRESS) throw new ApiError(429, 'slow_down', 'Too many links are waiting from here. Try again in a few minutes.')
  const until = Date.now() + TTL_MS
  held.set(id, { blob, until, address, state: 'waiting' })
  return { ok: true, until }
}

export function takeLink(id) {
  sweep()
  const link = held.get(id)
  if (!link || link.state !== 'waiting') throw new ApiError(404, 'gone', 'That code has been used, or has run out.')
  const { blob } = link
  link.blob = ''
  link.state = 'opened'
  tell(id)
  return { blob }
}

/** The device that took a link says whether it became the account: `linked`, or `declined`. */
export function endLink(id, linked) {
  sweep()
  const link = held.get(id)
  if (!link || link.state !== 'opened') throw new ApiError(404, 'gone', 'That link was not opened, or has run out.')
  link.state = linked ? 'linked' : 'declined'
  tell(id)
  return { ok: true }
}

/**
 * A link's state: waiting, opened, linked, declined, or gone once it runs out. Given the state
 * the asker knows as `from`, it waits for a change, up to 25 seconds, so nobody has to ask often.
 */
export async function linkState(id, from = '', res = null) {
  sweep()
  const now = () => held.get(id)?.state ?? 'gone'
  if (!from || now() !== from || now() === 'gone') return { state: now() }
  await new Promise((done) => {
    let finish = () => undefined
    const timer = setTimeout(() => finish(), STATE_WAIT_MS)
    finish = () => {
      clearTimeout(timer)
      watchers.get(id)?.delete(finish)
      res?.off('close', finish)
      done()
    }
    if (!watchers.has(id)) watchers.set(id, new Set())
    watchers.get(id).add(finish)
    // The asker went away.
    res?.on('close', finish)
  })
  return { state: now() }
}

setInterval(sweep, 60_000).unref()
