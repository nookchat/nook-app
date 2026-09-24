/**
 * A server, and the others in its cluster.
 *
 * A space on a server is kept on every server in that server's cluster: they
 * copy one another all the time (see server/src/cluster.mjs). So when the one
 * a space names is down, any other in the cluster has the same space, and
 * this is how the page finds them.
 *
 * A space is always named by one server, its first, which is what its invite
 * and its note say. The rest are learned: from the invite, which lists the
 * cluster after the first, and from any server's health check, which lists
 * its cluster. They are kept on this device as addresses only, beside the
 * server they belong to, because they are how the device finds the space
 * when the first one is gone.
 */

import { serverUrl } from '../backend'

const KEY = 'cathode.clusters.v1'
/** How long one server gets to answer before the next is asked. */
const ANSWER_MS = 5000

type Clusters = Record<string, string[]>

function load(): Clusters {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Clusters) : {}
  } catch {
    return {}
  }
}

function save(all: Clusters): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* known for this visit only */
  }
}

/** Which one answered last, per space server, so it is asked first next time. */
const lastGood = new Map<string, string>()

/** Every server a space named by `primary` can be reached on, the likeliest first. */
export function endpoints(primary: string): string[] {
  const first = serverUrl(primary)
  const known = (load()[first] ?? []).map(serverUrl).filter(Boolean)
  const all = [...new Set([first, ...known])]
  const good = lastGood.get(first)
  return good && all.includes(good) ? [good, ...all.filter((u) => u !== good)] : all
}

/** Remember more servers in the same cluster as `primary`. */
export function learn(primary: string, others: string[]): void {
  const first = serverUrl(primary)
  if (!first) return
  const all = load()
  const was = all[first] ?? []
  const next = [...new Set([...was, ...others.map(serverUrl)])].filter((u) => u && u !== first)
  if (next.join() === was.join()) return
  all[first] = next
  save(all)
}

/** Say which one answered, so it is tried first from now on. */
export function answered(primary: string, url: string): void {
  lastGood.set(serverUrl(primary), url)
}

/** Ask one server what its cluster is, and remember the answer. */
export async function discover(primary: string, from = primary): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl(from)}/api/v1/health`, {
      mode: 'cors',
      signal: AbortSignal.timeout(ANSWER_MS),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { cluster?: unknown }
    if (Array.isArray(body.cluster)) learn(primary, body.cluster.filter((u): u is string => typeof u === 'string'))
    return true
  } catch {
    return false
  }
}

/**
 * A request to whichever server of the cluster answers, first to last.
 *
 * A server that answers at all, even with an error, is the answer: an error
 * from a live server is about the request, and asking the next one would get
 * the same. Only silence moves on. Null when none of them answered.
 */
export async function ask(primary: string, path: string, init: RequestInit = {}): Promise<Response | null> {
  for (const base of endpoints(primary)) {
    try {
      const res = await fetch(`${base}${path}`, {
        mode: 'cors',
        ...init,
        signal: init.signal ?? AbortSignal.timeout(ANSWER_MS),
      })
      if (res.status >= 500 && res.status !== 501) continue
      answered(primary, base)
      return res
    } catch {
      /* silent: the next one */
    }
  }
  return null
}
