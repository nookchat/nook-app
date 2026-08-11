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

import { schnorr } from '@noble/curves/secp256k1'
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

/** A short, stable handle for a key, for when there is no name yet. */
export function shortKey(pubkey: string): string {
  return pubkey.slice(0, 6)
}
