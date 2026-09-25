import { openEvent } from './log'

self.onmessage = async (ev: MessageEvent<{ job: number; room: string; events: unknown[] }>) => {
  const { job, room, events } = ev.data
  const out = []
  for (const raw of events) out.push(await openEvent(raw, room))
  ;(self as unknown as Worker).postMessage({ job, out })
}
