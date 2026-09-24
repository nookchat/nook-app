/**
 * The servers Nook uses.
 *
 * Every space lives on a server: its history, its members, and your list of
 * spaces are kept there, sealed so the server cannot read them.
 *
 * The page offers no server of its own. Each person adds theirs, on the home
 * page or in Settings, and new spaces go there. An invite always names its
 * space's server, so opening one works with no server added at all, and a
 * server is seen only by the people somebody sends an invite to.
 *
 * VITE_CATHODE_SERVER, set at build time, gives every visitor a server. It is
 * for running the page and a server on one machine, as the tests do. Leave it
 * unset on a public page.
 */

import { ask, learn } from './net/cluster'

/** A server every visitor gets, from VITE_CATHODE_SERVER at build time. Empty on a public page. */
export const BUILT_IN_SERVER = serverUrl(import.meta.env.VITE_CATHODE_SERVER ?? '')

const DEFAULT_KEY = 'cathode.server.v1'

/** How to run a server of your own, step by step. */
export const SELF_HOSTING_URL = 'https://github.com/nebbsie/stream/blob/main/docs/self-hosting.md'

/**
 * Turn whatever was typed into a server address, or the empty string.
 *
 * A bare host is taken as https, except on this machine, where a server is
 * almost always a plain one being tried out. A trailing slash goes, so the
 * same server is always written the same way.
 */
export function serverUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(trimmed)
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${local ? 'http' : 'https'}://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    if (url.username || url.password || url.search || url.hash) return ''
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

/**
 * The server as a link writes it: the host and any path, with no scheme.
 *
 * The scheme is left out because it is always https, and on this machine
 * always http. A server that breaks that rule is written in full.
 */
export function serverTag(url: string): string {
  const clean = serverUrl(url)
  if (!clean) return ''
  const bare = clean.replace(/^https?:\/\//, '')
  return serverUrl(bare) === clean ? bare : clean
}

/** The server picked in Settings for new spaces. See newSpaceServer, which checks it is yours. */
export function defaultServer(): string {
  try {
    const picked = serverUrl(localStorage.getItem(DEFAULT_KEY) ?? '')
    if (picked) return picked
  } catch {
    /* nothing picked */
  }
  return BUILT_IN_SERVER
}

export function setDefaultServer(url: string): void {
  try {
    const clean = serverUrl(url)
    if (clean && clean !== BUILT_IN_SERVER) localStorage.setItem(DEFAULT_KEY, clean)
    else localStorage.removeItem(DEFAULT_KEY)
  } catch {
    /* for this visit only */
  }
}

/**
 * Is a Nook server answering there?
 *
 * A server says what it is in its health answer. Servers from before 1.2
 * said cathode-archive, and they speak the same API, so both are accepted.
 */
export async function checkServer(url: string): Promise<boolean> {
  const clean = serverUrl(url)
  if (!clean) return false
  try {
    const res = await fetch(`${clean}/api/v1/health`, { mode: 'cors', signal: AbortSignal.timeout(6000) })
    if (!res.ok) return false
    const body = (await res.json()) as { service?: string; cluster?: unknown }
    if (body.service !== 'cathode-server' && body.service !== 'cathode-archive') return false
    // And the others in its cluster, for when this one is down.
    if (Array.isArray(body.cluster)) learn(clean, body.cluster.filter((u): u is string => typeof u === 'string'))
    return true
  } catch {
    return false
  }
}

/** The ICE servers a server hands out, and whether every call must use them. */
export async function fetchIce(
  url: string,
): Promise<{ iceServers: RTCIceServer[]; relayOnly: boolean }> {
  try {
    const res = await ask(url, '/api/v1/ice')
    if (!res?.ok) return { iceServers: [], relayOnly: false }
    const body = (await res.json()) as { iceServers?: unknown; relayOnly?: unknown }
    const iceServers = Array.isArray(body.iceServers)
      ? (body.iceServers.filter(
          (s) => s && typeof s === 'object' && 'urls' in (s as object),
        ) as RTCIceServer[])
      : []
    return { iceServers, relayOnly: body.relayOnly === true && iceServers.length > 0 }
  } catch {
    return { iceServers: [], relayOnly: false }
  }
}
