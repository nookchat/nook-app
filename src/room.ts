/**
 * A room is one screen share session.
 *
 * The host makes a 128 bit secret. The link carries the secret in the URL
 * fragment, so the browser never sends it to the webserver. From the secret we
 * derive two values:
 *
 *   roomId   the public topic name on the signal relay
 *   roomKey  an AES-GCM key that encrypts every signal message
 *
 * The public relay therefore sees a random topic name and ciphertext only. It
 * cannot read the offer, the answer, or the IP candidates.
 */

const enc = new TextEncoder()

export interface Room {
  /** The base64url secret from the link. Treat it as the password of the room. */
  secret: string
  /** The relay topic. Derived from the secret, so it leaks nothing. */
  id: string
  /** AES-GCM key for the signal envelopes. */
  key: CryptoKey
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(text: string): Uint8Array {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A fresh 128 bit room secret, 22 characters of base64url. */
export function newSecret(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
}

/** A short random id for one peer in one session. */
export function newPeerId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(6)))
}

export async function deriveRoom(secret: string): Promise<Room> {
  const raw = b64urlDecode(secret)
  if (raw.length < 8) throw new Error('The room key in this link is too short.')

  const digest = await crypto.subtle.digest('SHA-256', enc.encode('cathode-room-id|' + secret))
  const id = hex(new Uint8Array(digest)).slice(0, 32)

  const material = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode('cathode-signal-salt-v1'),
      info: enc.encode('cathode-signal-key-v1'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  return { secret, id, key }
}

/** The link the host shares. The secret stays after the hash, so it is client side only. */
export function roomLink(secret: string): string {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#r=${secret}`
}

/** Read the room secret out of the current URL, or null when this is a fresh visit. */
export function readLinkSecret(): string | null {
  const frag = window.location.hash.replace(/^#/, '')
  if (!frag) return null
  const params = new URLSearchParams(frag)
  const secret = params.get('r')
  if (!secret) return null
  return /^[A-Za-z0-9_-]{10,64}$/.test(secret) ? secret : null
}

export function setLinkSecret(secret: string): void {
  history.replaceState(null, '', `#r=${secret}`)
}

export function clearLink(): void {
  history.replaceState(null, '', window.location.pathname)
}
