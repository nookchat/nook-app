/**
 * A room is one screen share session.
 *
 * The host makes a 125 bit secret and writes it into the URL fragment, so the
 * browser never sends it to the webserver. From the secret we derive two values:
 *
 *   roomId   the public topic name on the signal relay
 *   roomKey  an AES-GCM key that encrypts every signal message
 *
 * The public relay therefore sees a random topic name and ciphertext only. It
 * cannot read the offer, the answer, or the IP candidates.
 *
 * The code is written the way Windows wrote a product key, five groups of five:
 *
 *   https://cathode.video/#K7M2X-9QPT4-VB2WN-P8ZQ3-MHRF6
 *
 * That is not only for looks. It uses Crockford's base32 alphabet, which leaves
 * out I, L, O and U, so there is no letter that can be misread as a digit and
 * nothing in it that spells anything. Twenty five symbols at five bits each is
 * 125 bits of key, which is the same order as the 128 bits it replaced: a code
 * you can read down a phone should not be a code that is easier to guess.
 */

const enc = new TextEncoder()

/** Crockford base32. No I, no L, no O, no U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SYMBOLS = 25
const GROUP = 5

export interface Room {
  /** The canonical code, upper case with no hyphens. The password of the room. */
  secret: string
  /** The relay topic. Derived from the secret, so it leaks nothing. */
  id: string
  /** AES-GCM key for the signal envelopes. */
  key: CryptoKey
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A fresh room code, 125 bits.
 *
 * One random byte per symbol, masked to five bits. A byte is uniform over 256
 * and 256 divides evenly by 32, so the mask leaves it uniform: no rejection
 * loop and no bias.
 */
export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SYMBOLS))
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('')
}

/** Five groups of five, for a person to read. */
export function formatSecret(secret: string): string {
  return (secret.match(new RegExp(`.{1,${GROUP}}`, 'g')) ?? []).join('-')
}

/**
 * Accept a code however it was typed: any case, with or without hyphens or
 * spaces, and with the letters Crockford says to fold. Returns null when what
 * is left is not a code.
 */
export function parseSecret(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (cleaned.length !== SYMBOLS) return null
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null
  return cleaned
}

/** A short random id for one peer in one session. */
export function newPeerId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(6)))
}

export async function deriveRoom(secret: string): Promise<Room> {
  const canonical = parseSecret(secret)
  if (!canonical) throw new Error('That is not a valid room code.')

  const digest = await crypto.subtle.digest('SHA-256', enc.encode('cathode-room-id|' + canonical))
  const id = hex(new Uint8Array(digest)).slice(0, 32)

  const material = await crypto.subtle.importKey(
    'raw',
    enc.encode(canonical) as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  )
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode('cathode-signal-salt-v2'),
      info: enc.encode('cathode-signal-key-v2'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  return { secret: canonical, id, key }
}

/** The link the host shares. The code stays after the hash, so it is client side only. */
export function roomLink(secret: string): string {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#${formatSecret(secret)}`
}

/** The link without its scheme, for showing rather than for copying. */
export function shortLink(secret: string): string {
  const { host, pathname } = window.location
  return `${host}${pathname === '/' ? '' : pathname}/#${formatSecret(secret)}`.replace('//#', '/#')
}

/** Read the room code out of the current URL, or null when this is a fresh visit. */
export function readLinkSecret(): string | null {
  const frag = window.location.hash.replace(/^#/, '')
  return frag ? parseSecret(frag) : null
}

/**
 * Put the room in the address bar, so the link can be shared straight from
 * there. replaceState rather than pushState: the back button should leave the
 * app, not walk backwards through rooms that no longer exist.
 */
export function setLinkSecret(secret: string): void {
  history.replaceState(null, '', `#${formatSecret(secret)}`)
}

export function clearLink(): void {
  history.replaceState(null, '', window.location.pathname)
}
