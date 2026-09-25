import { schnorr, secp256k1 } from '@noble/curves/secp256k1'
import { fromHex, toHex } from '../bytes'
import { cleanName, sillyName } from '../chat'

const PRIV_KEY = 'nook.identity.v1'
const NAME_KEY = 'nook.name.v1'
const MADE_UP_NAME_KEY = 'nook.name.auto.v1'

export interface Identity {
  /** Hex x-only public key. */
  pubkey: string
  name: string
}

let priv: Uint8Array | null = null
let pub = ''

export function loadIdentity(): Identity {
  if (!priv) {
    let stored = ''
    try {
      stored = localStorage.getItem(PRIV_KEY) ?? ''
    } catch {}
    if (/^[0-9a-f]{64}$/.test(stored)) {
      priv = fromHex(stored)
    } else {
      priv = schnorr.utils.randomSecretKey()
      try {
        localStorage.setItem(PRIV_KEY, toHex(priv))
      } catch {}
    }
    pub = toHex(schnorr.getPublicKey(priv))
  }
  return { pubkey: pub, name: loadDisplayName() }
}

function loadDisplayName(): string {
  try {
    const saved = cleanName(localStorage.getItem(NAME_KEY) ?? '')
    if (saved) return saved
  } catch {}
  const fresh = sillyName()
  try {
    localStorage.setItem(NAME_KEY, fresh)
    localStorage.setItem(MADE_UP_NAME_KEY, fresh)
  } catch {}
  return fresh
}

export function nameChosen(): boolean {
  try {
    const name = cleanName(localStorage.getItem(NAME_KEY) ?? '')
    return !!name && name !== localStorage.getItem(MADE_UP_NAME_KEY)
  } catch {
    return true
  }
}

export function saveDisplayName(name: string): void {
  const clean = cleanName(name)
  if (!clean) return
  try {
    localStorage.setItem(NAME_KEY, clean)
    localStorage.removeItem(MADE_UP_NAME_KEY)
  } catch {}
}

const shared = new Map<string, Promise<CryptoKey>>()

export function sharedKey(theirPubkey: string): Promise<CryptoKey> {
  const held = shared.get(theirPubkey)
  if (held) return held
  const making = (async () => {
    if (!priv) loadIdentity()
    if (!/^[0-9a-f]{64}$/.test(theirPubkey)) throw new Error('That is not a key.')
    // An x-only schnorr key is the point with even y, hence the 02 prefix.
    const point = secp256k1.getSharedSecret(priv!, `02${theirPubkey}`, true)
    // The AES key is SHA-256 of the shared x coordinate.
    const bits = await crypto.subtle.digest('SHA-256', point.slice(1) as BufferSource)
    return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  })()
  shared.set(theirPubkey, making)
  return making
}

export function secretForLinking(): string {
  try {
    const stored = localStorage.getItem(PRIV_KEY) ?? ''
    return /^[0-9a-f]{64}$/.test(stored) ? stored : ''
  } catch {
    return ''
  }
}

export function takeIdentity(secret: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(secret)) return false
  try {
    localStorage.setItem(PRIV_KEY, secret)
  } catch {
    return false
  }
  priv = null
  pub = ''
  // Shared keys derive from the old private key.
  shared.clear()
  loadIdentity()
  return true
}

export async function signClaim(parts: unknown[]): Promise<string> {
  return sign(await hashParts(parts))
}

export async function verifyClaim(parts: unknown[], sigHex: string, pubkeyHex: string): Promise<boolean> {
  return verify(await hashParts(parts), sigHex, pubkeyHex)
}

async function hashParts(parts: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return toHex(new Uint8Array(digest))
}

export function sign(idHex: string): string {
  if (!priv) loadIdentity()
  return toHex(schnorr.sign(fromHex(idHex), priv!))
}

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

export function shortKey(pubkey: string): string {
  return `#${pubkey.slice(0, 6)}`
}

// SHA-256(private key + label): each label gives independent bytes that reveal nothing of the key.
export async function personalBytes(label: string): Promise<Uint8Array> {
  loadIdentity()
  const material = new Uint8Array([...(priv as Uint8Array), ...new TextEncoder().encode(label)])
  return new Uint8Array(await crypto.subtle.digest('SHA-256', material as BufferSource))
}
