/**
 * TURN credentials, for calls and screen shares in a space on this server.
 *
 * The relay is coturn, beside this in the compose file. This hands out short
 * lived credentials made the way coturn's use-auth-secret expects, so the
 * shared secret never leaves this machine. The media itself stays encrypted
 * end to end: WebRTC seals it between the browsers with DTLS-SRTP, and TURN
 * carries packets it cannot open.
 */

import { createHmac } from 'node:crypto'
import { HAS_TURN, TURN_ONLY, TURN_SECRET, TURN_TTL_S, TURN_URLS } from './config.mjs'

export function iceServers() {
  if (!HAS_TURN) return { iceServers: [], relayOnly: false }
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:cathode`
  const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64')
  return { iceServers: [{ urls: TURN_URLS, username, credential }], relayOnly: TURN_ONLY }
}
