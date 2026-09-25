import { open as unseal, seal, type Envelope } from '../signal/envelope'
import type { LogEvent } from '../store/log'
import { ask } from './cluster'

export interface LinkPreview {
  title?: string
  description?: string
  image?: string
  site?: string
}

/** A kept line is an event sealed in a signal envelope, so there is one sealed format. */
export function sealEvent(key: CryptoKey, event: LogEvent): Promise<string> {
  const env: Envelope = { v: 1, id: event.id, from: event.author, t: event.at, type: 'ping', data: event }
  return seal(key, env)
}

/** The event is unchecked: the caller verifies it. */
export async function openLine(key: CryptoKey, line: unknown): Promise<unknown> {
  if (typeof line !== 'string') return null
  const env = await unseal(key, line)
  return env?.data ?? null
}

const previews = new Map<string, Promise<LinkPreview | null>>()

export function preview(server: string, url: string): Promise<LinkPreview | null> {
  const key = `${server} ${url}`
  const held = previews.get(key)
  if (held) return held
  const asking = (async (): Promise<LinkPreview | null> => {
    const res = await ask(server, `/api/v1/preview?url=${encodeURIComponent(url)}`)
    if (!res?.ok) return null
    const body = (await res.json().catch(() => null)) as LinkPreview | null
    return body && (body.title || body.description || body.image) ? body : null
  })()
  previews.set(key, asking)
  return asking
}

const gifAnswers = new Map<string, Promise<boolean>>()

export function serverHasGifs(server: string): Promise<boolean> {
  let held = gifAnswers.get(server)
  if (!held) {
    held = health(server).then((h) => h.gifs === true)
    gifAnswers.set(server, held)
  }
  return held
}

/** An empty term gets what is popular. `from` names the service that answered. */
export async function gifs(server: string, term: string): Promise<{ gifs: { url: string; preview: string }[]; from: string }> {
  const res = await ask(server, `/api/v1/gifs?q=${encodeURIComponent(term)}`)
  if (!res?.ok) return { gifs: [], from: '' }
  const body = (await res.json().catch(() => null)) as { gifs?: { url?: string; preview?: string }[]; from?: string } | null
  const found = (body?.gifs ?? [])
    .filter((g) => typeof g.url === 'string' && g.url.startsWith('https://'))
    .map((g) => ({
      url: g.url as string,
      preview: typeof g.preview === 'string' && g.preview.startsWith('https://') ? g.preview : (g.url as string),
    }))
    .slice(0, 24)
  return { gifs: found, from: typeof body?.from === 'string' && body.from ? body.from : 'the server' }
}

export interface ServerHealth {
  up: boolean
  version?: string
  gifs?: boolean
  /** Absent on a server that does not take files. */
  files?: { max: number }
  peers: { url: string; up: boolean }[]
}

export async function health(server: string): Promise<ServerHealth> {
  try {
    const res = await fetch(`${server}/api/v1/health`, { mode: 'cors', signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { up: false, peers: [] }
    const body = (await res.json()) as Partial<ServerHealth> & { ok?: boolean }
    return {
      up: body.ok === true,
      version: body.version,
      gifs: body.gifs,
      files: body.files && typeof body.files.max === 'number' ? { max: body.files.max } : undefined,
      peers: Array.isArray(body.peers) ? body.peers : [],
    }
  } catch {
    return { up: false, peers: [] }
  }
}
