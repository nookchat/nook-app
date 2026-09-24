/**
 * What is live rather than kept, across the cluster: who is here, who is
 * typing, and the handshakes of calls and screen shares.
 *
 * Lines are kept and copied (see cluster.mjs); these are not kept at all, so
 * without this a person on one server of a cluster could read what somebody
 * on another wrote and never see them arrive, or call them. Each server puts
 * what its own devices say into an outbox, and every other server reads it by
 * long polling, the same way lines travel, so it crosses in about the time a
 * request takes. Only what a server's own devices said goes in: what arrived
 * from another server is never passed on again, so nothing goes round.
 *
 * A server that starts reading, or finds the other has restarted, is given
 * everybody's presence as it stands first, and then what changes. When a
 * server stops answering, everybody on it is gone as far as the others are
 * concerned, the moment that is noticed.
 *
 * All of it is sealed with the space's key on the device that said it. The
 * servers pass on what they cannot read.
 */

import { randomBytes } from 'node:crypto'
import { CLUSTERED } from './config.mjs'

/** Who this server is this time it is running, so a reader can tell a restart. */
export const BOOT = randomBytes(8).toString('hex')

/** How much the outbox holds for a reader that fell behind. More than that and it starts again from a snapshot. */
const KEEP = 5000

const outbox = []
let counter = 0
const waiting = new Set()

/** Something a device of this server said, for the other servers. */
export function emitLive(event) {
  // Nobody to tell: a server on its own keeps no outbox at all.
  if (!CLUSTERED) return
  counter += 1
  outbox.push({ n: counter, ...event })
  if (outbox.length > KEEP) outbox.splice(0, outbox.length - KEEP)
  for (const wake of waiting) wake()
  waiting.clear()
}

/**
 * What another server asks for: everything after `after`, waiting up to
 * `wait` seconds for something when there is nothing yet. A reader that has
 * not got this boot yet (the first time, or after a restart), or that is
 * further back than the outbox holds, starts with a snapshot of who is here.
 */
export async function liveFor(after, boot, wait, snapshot) {
  // Known by the boot, not by the count: a quiet server's count stays at nothing, and that is not a restart.
  const fresh = boot !== BOOT || (outbox.length > 0 && after < outbox[0].n - 1)
  if (fresh) return { boot: BOOT, at: counter, reset: true, events: snapshot() }
  let events = outbox.filter((e) => e.n > after)
  if (events.length === 0 && wait > 0) {
    await new Promise((done) => {
      const timer = setTimeout(done, wait * 1000)
      waiting.add(() => {
        clearTimeout(timer)
        done()
      })
    })
    events = outbox.filter((e) => e.n > after)
  }
  return { boot: BOOT, at: counter, reset: false, events }
}
