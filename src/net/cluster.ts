import { serverUrl } from '../backend'

/** Each server's cluster, as that server says. */
const KEY = 'nook.clusters.v1'
/**
 * The other servers an invite named, before its own server said. Anybody can write a link, so
 * these only help to reach a space whose server is down; they are never passed on in an invite.
 */
const HINTS = 'nook.cluster-hints.v1'
const ANSWER_MS = 5000
const MAX_HINTS = 5

type Clusters = Record<string, string[]>

function load(key = KEY): Clusters {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Clusters) : {}
  } catch {
    return {}
  }
}

function save(all: Clusters, key = KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(all))
  } catch {
    /* known for this visit only */
  }
}

export function knownClusters(): Clusters {
  return load()
}

const lastGood = new Map<string, string>()

export function endpoints(primary: string): string[] {
  const first = serverUrl(primary)
  const known = (load()[first] ?? load(HINTS)[first] ?? []).map(serverUrl).filter(Boolean)
  const all = [...new Set([first, ...known])]
  const good = lastGood.get(first)
  return good && all.includes(good) ? [good, ...all.filter((u) => u !== good)] : all
}

/**
 * A server's cluster, as that server says it. It replaces what was known: a server taken out of
 * the cluster, or one that was never in it, goes.
 */
export function learn(primary: string, others: string[]): void {
  const first = serverUrl(primary)
  if (!first) return
  const all = load()
  const was = all[first]
  const next = [...new Set(others.map(serverUrl))].filter((u) => u && u !== first)
  if (was && next.join() === was.join()) return
  all[first] = next
  save(all)
}

/** The servers a link names beside its own, kept only until that server says which are its cluster. */
export function hint(primary: string, others: string[]): void {
  const first = serverUrl(primary)
  if (!first || load()[first]) return
  const next = [...new Set(others.map(serverUrl))]
    .filter((u) => u && u !== first && (u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(u)))
    .slice(0, MAX_HINTS)
  if (next.length === 0) return
  const all = load(HINTS)
  all[first] = next
  save(all, HINTS)
}

/** The servers to name in an invite: only those the server itself said are its cluster. */
export function confirmedEndpoints(primary: string): string[] {
  const first = serverUrl(primary)
  return first ? [first, ...(load()[first] ?? []).map(serverUrl).filter((u) => u && u !== first)] : []
}

export function answered(primary: string, url: string): void {
  lastGood.set(serverUrl(primary), url)
}

export async function discover(primary: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl(primary)}/api/v1/health`, {
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

/** Only silence or a 5xx moves on to the next server: any other answer is about the request. */
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
