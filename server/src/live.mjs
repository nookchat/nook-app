import { randomBytes } from 'node:crypto'
import { CLUSTERED } from './config.mjs'

const BOOT = randomBytes(8).toString('hex')
const OUTBOX_MAX = 5000

const outbox = []
let counter = 0
const waiting = new Set()

export function emitLive(event) {
  if (!CLUSTERED) return
  counter += 1
  outbox.push({ n: counter, ...event })
  if (outbox.length > OUTBOX_MAX) outbox.shift()
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
