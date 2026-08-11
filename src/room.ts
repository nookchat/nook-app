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

/**
 * Turn a code, and an optional password, into a room.
 *
 * The code alone is already a key, so a password is a second factor rather than
 * the only one: it means holding the link is not enough. It is mixed into both
 * the topic and the key, so a wrong password does not produce a room you can
 * see and fail to read. It produces a different room entirely, on a topic
 * nobody is talking on.
 *
 * That also means a password cannot be changed later without changing the
 * space, which is why it is asked for once, when the space is made.
 */
export async function deriveRoom(secret: string, password = ''): Promise<Room> {
  const canonical = parseSecret(secret)
  if (!canonical) throw new Error('That is not a valid room code.')
  const salted = password ? `${canonical}|${password}` : canonical

  const digest = await crypto.subtle.digest('SHA-256', enc.encode('cathode-room-id|' + salted))
  const id = hex(new Uint8Array(digest)).slice(0, 32)

  const material = await crypto.subtle.importKey(
    'raw',
    enc.encode(salted) as BufferSource,
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
export function roomLink(secret: string, locked = false): string {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#${formatSecret(secret)}${locked ? LOCK : ''}`
}

/**
 * A locked space says so in its link, so whoever opens it is asked for the
 * password rather than dropped into an empty room they cannot explain.
 */
const LOCK = '.P'

export interface LinkInfo {
  secret: string
  locked: boolean
}

export function parseLink(raw: string): LinkInfo | null {
  const trimmed = raw.trim()
  const locked = trimmed.toUpperCase().endsWith(LOCK)
  const secret = parseSecret(locked ? trimmed.slice(0, -LOCK.length) : trimmed)
  return secret ? { secret, locked } : null
}

/** The link without its scheme, for showing rather than for copying. */
export function shortLink(secret: string, locked = false): string {
  const { host, pathname } = window.location
  const tail = `${formatSecret(secret)}${locked ? LOCK : ''}`
  return `${host}${pathname === '/' ? '' : pathname}/#${tail}`.replace('//#', '/#')
}

/** Read the room out of the current URL, or null when this is a fresh visit. */
export function readLink(): LinkInfo | null {
  const frag = window.location.hash.replace(/^#/, '')
  return frag ? parseLink(frag) : null
}

/**
 * Put the room in the address bar, so the link can be shared straight from
 * there. replaceState rather than pushState: the back button should leave the
 * app, not walk backwards through rooms that no longer exist.
 */
export function setLinkSecret(secret: string, locked = false): void {
  history.replaceState(null, '', `#${formatSecret(secret)}${locked ? LOCK : ''}`)
}

export function clearLink(): void {
  history.replaceState(null, '', window.location.pathname)
}
