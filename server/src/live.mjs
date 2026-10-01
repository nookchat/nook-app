import { randomBytes } from 'node:crypto'
import { CLUSTERED } from './config.mjs'

const BOOT = randomBytes(8).toString('hex')
const OUTBOX_MAX = 5000
/** A signal can be half a megabyte, so the count alone would let the outbox hold gigabytes. */
const OUTBOX_MAX_BYTES = 64 * 1024 * 1024

const outbox = []
let outboxBytes = 0
let counter = 0
const waiting = new Set()

const sizeOf = (event) => (typeof event.d === 'string' ? event.d.length : 0) + 64

export function emitLive(event) {
  if (!CLUSTERED) return
  counter += 1
  outbox.push({ n: counter, ...event })
  outboxBytes += sizeOf(event)
  while (outbox.length > OUTBOX_MAX || (outboxBytes > OUTBOX_MAX_BYTES && outbox.length > 1)) {
    outboxBytes -= sizeOf(outbox.shift())
  }
  for (const wake of waiting) wake()
  waiting.clear()
}

const outboxAfter = (after) => (outbox.length ? outbox.slice(Math.max(0, after + 1 - outbox[0].n)) : [])

export async function liveFor(after, boot, wait, snapshot) {
  // A restart is told by the boot id, since a quiet server's count stays at 0.
  const behind = boot !== BOOT || (outbox.length > 0 && after < outbox[0].n - 1)
  if (behind) return { boot: BOOT, at: counter, reset: true, events: snapshot() }
  let events = outboxAfter(after)
  if (events.length === 0 && wait > 0) {
    await new Promise((done) => {
      const wake = () => {
        clearTimeout(timer)
        waiting.delete(wake)
        done()
      }
      const timer = setTimeout(wake, wait * 1000)
      waiting.add(wake)
    })
    events = outboxAfter(after)
  }
  return { boot: BOOT, at: counter, reset: false, events }
}
