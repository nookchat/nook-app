import { createHmac } from 'node:crypto'
import { HAS_TURN, TURN_ONLY, TURN_SECRET, TURN_TTL_S, TURN_URLS } from './config.mjs'

export function iceServers() {
  if (!HAS_TURN) return { iceServers: [], relayOnly: false }
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:cathode`
  const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64')
  return { iceServers: [{ urls: TURN_URLS, username, credential }], relayOnly: TURN_ONLY }
}
