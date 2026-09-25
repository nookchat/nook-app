import { ask, learn } from './net/cluster'

export const BUILT_IN_SERVER = serverUrl(import.meta.env.VITE_CATHODE_SERVER ?? '')

const DEFAULT_SERVER_KEY = 'cathode.server.v1'
const HEALTH_TIMEOUT_MS = 6000

export const SELF_HOSTING_URL = 'https://github.com/nebbsie/stream/blob/main/docs/self-hosting.md'

export function serverUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(trimmed)
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${isLoopback ? 'http' : 'https'}://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    if (url.username || url.password || url.search || url.hash) return ''
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

// Leaves the scheme out when serverUrl would add the same one back.
export function serverTag(url: string): string {
  const clean = serverUrl(url)
  if (!clean) return ''
  const bare = clean.replace(/^https?:\/\//, '')
  return serverUrl(bare) === clean ? bare : clean
}

export function defaultServer(): string {
  try {
    const picked = serverUrl(localStorage.getItem(DEFAULT_SERVER_KEY) ?? '')
    if (picked) return picked
  } catch {}
  return BUILT_IN_SERVER
}

export function setDefaultServer(url: string): void {
  try {
    const clean = serverUrl(url)
    if (clean && clean !== BUILT_IN_SERVER) localStorage.setItem(DEFAULT_SERVER_KEY, clean)
    else localStorage.removeItem(DEFAULT_SERVER_KEY)
  } catch {}
}

export async function checkServer(url: string): Promise<boolean> {
  const clean = serverUrl(url)
  if (!clean) return false
  try {
    const res = await fetch(`${clean}/api/v1/health`, { mode: 'cors', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    if (!res.ok) return false
    const body = (await res.json()) as { service?: string; cluster?: unknown }
    // Servers before 1.2 answer cathode-archive and speak the same API.
    if (body.service !== 'cathode-server' && body.service !== 'cathode-archive') return false
    if (Array.isArray(body.cluster)) learn(clean, body.cluster.filter((u): u is string => typeof u === 'string'))
    return true
  } catch {
    return false
  }
}

export async function fetchIce(url: string): Promise<{ iceServers: RTCIceServer[]; relayOnly: boolean }> {
  try {
    const res = await ask(url, '/api/v1/ice')
    if (!res?.ok) return { iceServers: [], relayOnly: false }
    const body = (await res.json()) as { iceServers?: unknown; relayOnly?: unknown }
    const iceServers = Array.isArray(body.iceServers)
      ? (body.iceServers.filter((s) => s && typeof s === 'object' && 'urls' in (s as object)) as RTCIceServer[])
      : []
    return { iceServers, relayOnly: body.relayOnly === true && iceServers.length > 0 }
  } catch {
    return { iceServers: [], relayOnly: false }
  }
}
