/**
 * The server's API, apart from the connection: sealing a line the way the
 * server keeps it, link cards, and GIF search.
 */

import { open as unseal, seal, type Envelope } from '../signal/envelope'
import type { LogEvent } from '../store/log'
import { ask } from './cluster'

/** What a server says is behind a link, all of it optional. */
export interface LinkPreview {
  title?: string
  description?: string
  image?: string
  site?: string
}

/**
 * An event on its way to the server, wrapped so the envelope's seal can carry
 * it. One sealed format, not two to get wrong.
 */
function wrap(event: LogEvent): Envelope {
  return { v: 1, id: event.id, from: event.author, t: event.at, type: 'ping', data: event }
}

/** One event as the line a server keeps. */
export function sealEvent(key: CryptoKey, event: LogEvent): Promise<string> {
  return seal(key, wrap(event))
}

/** A kept line back to the event it carries, unchecked, or null. */
export async function openLine(key: CryptoKey, line: unknown): Promise<unknown> {
  if (typeof line !== 'string') return null
  const env = await unseal(key, line)
  return env?.data ?? null
}

/*
 * Link cards. A browser cannot read another site's page, so the server goes
 * and looks. It learns which links get previewed, which is the price, and a
 * server can turn cards off. Cached per address for the tab's life.
 */
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

/** Whether a server can search for GIFs at all, asked once per page. */
export function serverHasGifs(server: string): Promise<boolean> {
  let held = gifAnswers.get(server)
  if (!held) {
    held = health(server).then((h) => h.gifs === true)
    gifAnswers.set(server, held)
  }
  return held
}

/**
 * GIFs matching a term, or what is popular for an empty one, found by the
 * server with its own key. `from` names the service that answered.
 */
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

/** What a server says about itself and its cluster. */
export interface ServerHealth {
  up: boolean
  version?: string
  turn?: boolean
  gifs?: boolean
  /** Whether it takes files, and the largest it takes. Absent on a server from before files. */
  files?: { max: number }
  cluster: string[]
  peers: { url: string; up: boolean }[]
}

export async function health(server: string): Promise<ServerHealth> {
  try {
    const res = await fetch(`${server}/api/v1/health`, { mode: 'cors', signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { up: false, cluster: [], peers: [] }
    const body = (await res.json()) as Partial<ServerHealth> & { ok?: boolean }
    return {
      up: body.ok === true,
      version: body.version,
      turn: body.turn,
      gifs: body.gifs,
      files: body.files && typeof body.files.max === 'number' ? { max: body.files.max } : undefined,
      cluster: Array.isArray(body.cluster) ? body.cluster : [],
      peers: Array.isArray(body.peers) ? body.peers : [],
    }
  } catch {
    return { up: false, cluster: [], peers: [] }
  }
}
