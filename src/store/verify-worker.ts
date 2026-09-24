/**
 * Checks events off the main thread.
 *
 * A space on a server keeps nothing on the device, so every visit reads its
 * whole history back and checks every event in it: the hash, then the
 * signature. The signature is the slow part, about a fifth of a millisecond
 * each in plain JavaScript, and a few thousand of them in a row froze the page
 * for most of a second. Several of these run at once, one per core, and the
 * page never waits on any of them.
 */

import { openEvent } from './log'

self.onmessage = async (ev: MessageEvent<{ job: number; room: string; events: unknown[] }>) => {
  const { job, room, events } = ev.data
  const out = []
  for (const raw of events) out.push(await openEvent(raw, room))
  ;(self as unknown as Worker).postMessage({ job, out })
}
