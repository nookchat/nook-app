import { serverUrl } from '../backend'

const KEY = 'nook.clusters.v1'
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

export function knownClusters(): Clusters {
  return load()
}

const lastGood = new Map<string, string>()

export function endpoints(primary: string): string[] {
  const first = serverUrl(primary)
  const known = (load()[first] ?? []).map(serverUrl).filter(Boolean)
  const all = [...new Set([first, ...known])]
  const good = lastGood.get(first)
  return good && all.includes(good) ? [good, ...all.filter((u) => u !== good)] : all
}

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
