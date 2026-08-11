/**
 * ICE configuration.
 *
 * Cathode ships with public STUN only, which keeps the promise of no server. STUN
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
 */
export const TURN_SERVERS: RTCIceServer[] = []

export function hasTurn(): boolean {
  return TURN_SERVERS.length > 0
}

export function rtcConfig(): RTCConfiguration {
  return {
    iceServers: [...STUN_SERVERS, ...TURN_SERVERS],
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 0,
  }
}
