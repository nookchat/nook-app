/**
 * Where a space runs: peer to peer, or on a server.
 *
 * Peer to peer is what Cathode always was. The handshakes ride public relays,
 * chat crosses a data channel between every pair, and every device keeps the
 * history. Nothing has to be running anywhere.
 *
 * On a server, one machine does the carrying. Every handshake, chat line and
 * event goes over one WebSocket to it, the history is kept there as well as on
 * every device, and it hands out TURN credentials so the picture and the sound
 * get through networks that block peer to peer. What it carries is sealed with
 * the key made from the space code exactly as before, so it cannot read any of
 * it. Run one with server/docker-compose.yml.
 *
 * The choice belongs to the space, not to the device, and it travels in the
 * invite: everybody in one space has to be talking in the same place. A space
 * on a server says which one after an @ in its link.
 */

/** The server a deployment offers, from VITE_CATHODE_SERVER at build time. */
export const BUILT_IN_SERVER = serverUrl(import.meta.env.VITE_CATHODE_SERVER ?? '')

const CHOICE_KEY = 'cathode.backend.v1'

export interface BackendChoice {
  /** Empty for peer to peer. */
  server: string
}

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

/** What this device picked last time it made a space, or what the page offers. */
export function lastChoice(): BackendChoice {
  try {
    const raw = localStorage.getItem(CHOICE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<BackendChoice & { last: string }>
      return { server: serverUrl(String(saved.server ?? '')) }
    }
  } catch {
    /* nothing kept, or nothing readable */
  }
  return { server: BUILT_IN_SERVER }
}

/** The server this device used last, even when the last space was peer to peer. */
export function lastServer(): string {
  try {
    const raw = localStorage.getItem(CHOICE_KEY)
    const saved = raw ? (JSON.parse(raw) as { last?: string }) : null
    return serverUrl(saved?.last ?? '') || BUILT_IN_SERVER
  } catch {
    return BUILT_IN_SERVER
  }
}

export function rememberChoice(choice: BackendChoice): void {
  try {
    const last = choice.server || lastServer()
    localStorage.setItem(CHOICE_KEY, JSON.stringify({ server: choice.server, last }))
  } catch {
    /* the choice lasts for this visit only */
  }
}

/**
 * Is a Cathode server answering there?
 *
 * The service name is the one the server kept from when it was only an
 * archive, which is how an old server and a new one are both recognised.
 */
export async function checkServer(url: string): Promise<boolean> {
  const clean = serverUrl(url)
  if (!clean) return false
  try {
    const res = await fetch(`${clean}/health`, { mode: 'cors', signal: AbortSignal.timeout(6000) })
    if (!res.ok) return false
    const body = (await res.json()) as { service?: string }
    return body.service === 'cathode-archive'
  } catch {
    return false
  }
}

/** The ICE servers a server hands out, and whether every call must use them. */
export async function fetchIce(
  url: string,
): Promise<{ iceServers: RTCIceServer[]; relayOnly: boolean }> {
  try {
    const res = await fetch(`${serverUrl(url)}/ice`, { mode: 'cors', signal: AbortSignal.timeout(6000) })
    if (!res.ok) return { iceServers: [], relayOnly: false }
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
