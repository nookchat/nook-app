/**
 * Who you are.
 *
 * Names used to be a claim: you typed one and everybody believed it. That is
 * fine for an hour long screen share and useless for a room you come back to,
 * because there is nothing tying yesterday's messages to today's you, and
 * nothing stopping somebody else answering to your name.
 *
 * So each person holds a key pair. It is made once, kept on the device, and
 * every event is signed with it. The public key is the identity; the name is
 * just a label attached to it that anyone can change for themselves and nobody
 * can change for you.
 *
 * schnorr over secp256k1, which is already in the bundle for the Nostr
 * transport, so this costs no new dependency.
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1'
import { cleanName, sillyName } from '../chat'

const PRIV_KEY = 'cathode.identity.v1'
const NAME_KEY = 'cathode.name.v1'

export interface Identity {
  /** Hex x-only public key. This is who you are. */
  pubkey: string
  /** The label you go by. Yours to change, nobody else's. */
  name: string
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16)
  return out
}

let priv: Uint8Array | null = null
let pub = ''

/**
 * Load the key from this device, or make one and keep it.
 *
 * localStorage rather than IndexedDB: a 32 byte key is not worth an async API,
 * and both are cleared by the same "clear site data" anyway.
 */
export function loadIdentity(): Identity {
  if (!priv) {
    let stored = ''
    try {
      stored = localStorage.getItem(PRIV_KEY) ?? ''
    } catch {
      // Private mode. A key that lasts one session still signs correctly.
    }
    if (/^[0-9a-f]{64}$/.test(stored)) {
      priv = fromHex(stored)
    } else {
      priv = schnorr.utils.randomSecretKey()
      try {
        localStorage.setItem(PRIV_KEY, toHex(priv))
      } catch {
        /* nothing to keep it in */
      }
    }
    pub = toHex(schnorr.getPublicKey(priv))
  }
  return { pubkey: pub, name: loadDisplayName() }
}

export function loadDisplayName(): string {
  try {
    const saved = cleanName(localStorage.getItem(NAME_KEY) ?? '')
    if (saved) return saved
  } catch {
    /* private mode */
  }
  const fresh = sillyName()
  saveDisplayName(fresh)
  return fresh
}

export function saveDisplayName(name: string): void {
  const clean = cleanName(name)
  if (!clean) return
  try {
    localStorage.setItem(NAME_KEY, clean)
  } catch {
    /* the name lasts for this session only */
  }
}

/**
 * The key two people share, and nobody else has.
 *
 * Both sides of a conversation work out the same bytes from their own private
 * key and the other person's public one, which is what makes a private message
 * possible with no server to hold a key and no exchange to intercept. The x
 * coordinate of the shared point is hashed into an AES key; the y coordinate is
 * dropped, which is what everybody who does this does, because an x-only public
 * key does not carry it.
 *
 * Cached per person: the elliptic curve part is the expensive half and the
 * answer never changes.
 */
const shared = new Map<string, Promise<CryptoKey>>()

export function sharedKey(theirPubkey: string): Promise<CryptoKey> {
  const held = shared.get(theirPubkey)
  if (held) return held
  const making = (async () => {
    if (!priv) loadIdentity()
    if (!/^[0-9a-f]{64}$/.test(theirPubkey)) throw new Error('That is not a key.')
    // An x-only key is a point with the even y, which is the convention every
    // schnorr key is written under. 02 says so.
    const point = secp256k1.getSharedSecret(priv!, `02${theirPubkey}`, true)
    const x = point.slice(1)
    const bits = await crypto.subtle.digest('SHA-256', x as BufferSource)
    return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  })()
  shared.set(theirPubkey, making)
  return making
}

/** Forget the shared keys, for when the identity behind them is replaced. */
export function forgetShared(): void {
  shared.clear()
}

/**
 * The private key, for putting on a screen so another device can take it.
 *
 * The only place in the app that reads it back out, and it is called from one
 * button behind one question. Empty when the browser has nowhere to keep it,
 * which is a session that cannot be linked anywhere anyway.
 */
export function secretForLinking(): string {
  try {
    const stored = localStorage.getItem(PRIV_KEY) ?? ''
    return /^[0-9a-f]{64}$/.test(stored) ? stored : ''
  } catch {
    return ''
  }
}

/**
 * Become somebody else, on this device.
 *
 * Everything worked out from the old key goes with it: the public key, and
 * every shared key derived for a private conversation. They are held in memory
 * for speed and would otherwise answer for the person who has just left.
 */
export function takeIdentity(secret: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(secret)) return false
  try {
    localStorage.setItem(PRIV_KEY, secret)
  } catch {
    return false
  }
  priv = null
  pub = ''
  forgetShared()
  loadIdentity()
  return true
}

/**
 * Sign a claim that is not an event: a handful of fields, hashed and signed,
 * for the messages that live on the wire and never in the log. Both sides
 * build the same array in the same order, so JSON of it is canonical enough.
 */
export async function signClaim(parts: unknown[]): Promise<string> {
  return sign(await hashParts(parts))
}

/** Check a signed claim. Anything malformed is a no, never an exception. */
export async function verifyClaim(
  parts: unknown[],
  sigHex: string,
  pubkeyHex: string,
): Promise<boolean> {
  return verify(await hashParts(parts), sigHex, pubkeyHex)
}

async function hashParts(parts: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return toHex(new Uint8Array(digest))
}

/** Sign 32 bytes of hash. Returns hex. */
export function sign(idHex: string): string {
  if (!priv) loadIdentity()
  return toHex(schnorr.sign(fromHex(idHex), priv!))
}

/** Check a signature. Anything malformed is a no, never an exception. */
export function verify(idHex: string, sigHex: string, pubkeyHex: string): boolean {
  try {
    if (!/^[0-9a-f]{64}$/.test(idHex)) return false
    if (!/^[0-9a-f]{128}$/.test(sigHex)) return false
    if (!/^[0-9a-f]{64}$/.test(pubkeyHex)) return false
    return schnorr.verify(fromHex(sigHex), fromHex(idHex), fromHex(pubkeyHex))
  } catch {
    return false
  }
}

/**
 * A short handle for a key.
 *
 * Six hex characters, written the way a tag is written. The whole key is 64
 * characters and nobody reads that; six is enough to tell two people apart at a
 * glance and the full thing is a copy away in settings when it matters.
 */
export function shortKey(pubkey: string): string {
  return `#${pubkey.slice(0, 6)}`
}
