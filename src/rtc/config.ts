const STUN_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: ['stun:stun.cloudflare.com:3478'] },
]

// Put TURN relays here with short lived credentials: a key in a static site is public.
const TURN_SERVERS: RTCIceServer[] = []

let served: RTCIceServer[] = []
let relayOnly = false

export function useServedIce(servers: RTCIceServer[] = [], only = false): void {
  served = servers
  relayOnly = only && servers.length > 0
}

export function rtcConfig(servers: RTCIceServer[] = served, only = relayOnly): RTCConfiguration {
  const relay = only && servers.length > 0
  return {
    iceServers: [...STUN_SERVERS, ...TURN_SERVERS, ...servers],
    iceTransportPolicy: relay ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 0,
  }
}
