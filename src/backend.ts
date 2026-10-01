import { ask, learn } from './net/cluster'

export const BUILT_IN_SERVER = serverUrl(import.meta.env.VITE_NOOK_SERVER ?? '')

const DEFAULT_SERVER_KEY = 'nook.server.v1'
const HEALTH_TIMEOUT_MS = 6000

export const SELF_HOSTING_URL = 'https://github.com/nookchat/nook-app/blob/main/docs/self-hosting.md'

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
    // Servers before 1.2 answer nook-archive and speak the same API.
    if (body.service !== 'nook-server' && body.service !== 'nook-archive') return false
    if (Array.isArray(body.cluster)) learn(clean, body.cluster.filter((u): u is string => typeof u === 'string'))
    return true
  } catch {
    return false
  }
}

type Ice = { iceServers: RTCIceServer[]; relayOnly: boolean }

const ICE_KEY = 'nook.ice.v1'
const NO_ICE: Ice = { iceServers: [], relayOnly: false }

/** The newest answer from each server, with when its credentials run out. */
function heldIce(): Record<string, Ice & { until: number }> {
  try {
    const raw = JSON.parse(localStorage.getItem(ICE_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, Ice & { until: number }>) : {}
  } catch {
    return {}
  }
}

/** A TURN credential's name starts with the second it runs out (RFC 7635 style, as server/src/turn.mjs). */
function untilOf(servers: RTCIceServer[]): number {
  const times = servers.map((s) => Number(String(s.username ?? '').split(':')[0]) * 1000).filter((t) => Number.isFinite(t) && t > 0)
  return times.length ? Math.min(...times) : 0
}

/**
 * The server's relays. When it does not answer, the last answer it gave, while its credentials
 * last: a relay-only server is that so nobody learns anybody's address, and a slow answer must
 * not turn that into straight connections.
 */
export async function fetchIce(url: string): Promise<Ice> {
  const key = serverUrl(url)
  try {
    const res = await ask(url, '/api/v1/ice')
    if (!res?.ok) return lastIce(key)
    const body = (await res.json()) as { iceServers?: unknown; relayOnly?: unknown }
    const iceServers = Array.isArray(body.iceServers)
      ? (body.iceServers.filter((s) => s && typeof s === 'object' && 'urls' in (s as object)) as RTCIceServer[])
      : []
    const ice = { iceServers, relayOnly: body.relayOnly === true && iceServers.length > 0 }
    try {
      const all = heldIce()
      all[key] = { ...ice, until: untilOf(iceServers) }
      localStorage.setItem(ICE_KEY, JSON.stringify(all))
    } catch {
      /* not kept: only this answer */
    }
    return ice
  } catch {
    return lastIce(key)
  }
}

function lastIce(key: string): Ice {
  const held = heldIce()[key]
  if (!held || held.until - Date.now() < 60_000) return NO_ICE
  return { iceServers: held.iceServers, relayOnly: held.relayOnly }
}
