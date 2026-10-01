import { openEvent, plainEnough, type LogEvent } from './log'

const MIN_EVENTS_FOR_WORKERS = 48

let workers: Worker[] | null = null
let job = 0
const waiting = new Map<number, (out: (LogEvent | null)[]) => void>()

function pool(): Worker[] {
  if (workers) return workers
  const count = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
  workers = []
  try {
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./verify-worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (ev: MessageEvent<{ job: number; out: (LogEvent | null)[] }>) => {
        waiting.get(ev.data.job)?.(ev.data.out)
        waiting.delete(ev.data.job)
      }
      workers.push(worker)
    }
  } catch {
    // Some locked down pages forbid workers.
    workers = []
  }
  return workers
}

async function here(events: unknown[], room: string): Promise<(LogEvent | null)[]> {
  const out: (LogEvent | null)[] = []
  for (const raw of events) out.push(await openEvent(raw, room))
  return out
}

export async function openEvents(raw: unknown[], room: string): Promise<(LogEvent | null)[]> {
  // One nested too deep for a worker to be handed is dropped here, so it cannot stop its page.
  const events = raw.map((e) => (plainEnough(e) ? e : null))
  if (events.length <= MIN_EVENTS_FOR_WORKERS) return here(events, room)
  const all = pool()
  if (all.length === 0) return here(events, room)
  const size = Math.ceil(events.length / all.length)
  const parts = await Promise.all(
    all.map((worker, i) => {
      const slice = events.slice(i * size, (i + 1) * size)
      if (slice.length === 0) return Promise.resolve([] as (LogEvent | null)[])
      const id = ++job
      return new Promise<(LogEvent | null)[]>((done) => {
        waiting.set(id, done)
        try {
          worker.postMessage({ job: id, room, events: slice })
        } catch {
          waiting.delete(id)
          done(here(slice, room))
        }
      })
    }),
  )
  return parts.flat()
}
