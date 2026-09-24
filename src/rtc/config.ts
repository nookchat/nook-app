/**
 * ICE configuration.
 *
 * Nook ships with public STUN only, which keeps the promise of no server. STUN
 * tells a peer its public address. It never carries media.
 *
 * About one connection in eight fails with STUN alone, because of symmetric NAT
 * or a strict firewall. The only fix is a TURN relay, and a TURN relay is a
 * server. Put your credentials in TURN_SERVERS when you decide to run one. No
 * other file changes.
 */

export const STUN_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: ['stun:stun.cloudflare.com:3478'] },
]

/**
 * Leave this empty to stay serverless. To add TURN later:
 *
 *   export const TURN_SERVERS: RTCIceServer[] = [
 *     { urls: ['turn:turn.example.com:3478?transport=udp',
 *              'turns:turn.example.com:5349?transport=tcp'],
 *       username: '...', credential: '...' },
 *   ]
 *
 * Use short lived credentials. A key in a static site is a public key.
 *
 * A space on a Nook server needs none of this: the server hands out its
 * own short lived TURN credentials, and useServedIce puts them here for as
 * long as that space is open.
 */
export const TURN_SERVERS: RTCIceServer[] = []

/** What the server of the open space handed out, if it runs on one. */
let served: RTCIceServer[] = []
/** True when that server says every call goes through its TURN relay. */
let relayOnly = false

/**
 * Use a server's ICE servers until told otherwise. Called with nothing when
 * the space closes, so the next space starts from the shipped list.
 */
export function useServedIce(servers: RTCIceServer[] = [], only = false): void {
  served = servers
  relayOnly = only && servers.length > 0
}

export function hasTurn(): boolean {
  return TURN_SERVERS.length > 0 || served.length > 0
}

/** For the space on show, or for the servers and rule a given space was handed. */
export function rtcConfig(servers: RTCIceServer[] = served, only = relayOnly): RTCConfiguration {
  const relay = only && servers.length > 0
  return {
    iceServers: [...STUN_SERVERS, ...TURN_SERVERS, ...servers],
    // Relay only hides every address from everybody, and costs the server
    // the bandwidth of every call. The server decides. See server/README.md.
    iceTransportPolicy: relay ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 0,
  }
}
