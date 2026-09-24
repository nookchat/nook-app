/**
 * Linking a device, so the same person has the same spaces on both.
 *
 * You are a key, kept on each device, and your spaces are listed on your
 * servers in a record only that key opens. So a second device needs two
 * things to be you: the key, and which servers to ask. This carries both,
 * with your name and picture, from the device you use to the new one.
 *
 * The device you use makes a code, three groups of four like a space's, and
 * seals the lot with a key stretched out of it. What it leaves on your server
 * is that sealed blob, under an id also made from the code, for ten minutes,
 * and the server hands it out once. The new device is given the code (by a
 * link, a QR code, or typing it) and fetches and opens it.
 *
 * Sixty bits of code, stretched two hundred thousand times, readable once, for
 * ten minutes, from a server that answers thirty requests a second at most:
 * guessing it is not a plan. The server holds only ciphertext throughout.
 */

import { serverTag, serverUrl } from '../backend'
import { formatSecret, newSecret, parseSecret } from '../room'
import { loadIdentity, saveDisplayName, secretForLinking, takeIdentity } from '../store/identity'
import { adoptServers, knownServers, newSpaceServer, ownServers } from '../store/server-spaces'
import { saveAvatar } from '../ui/avatar'
import { knownClusters, learn } from './cluster'

const ROUNDS = 200_000
const SALT = 'cathode device link v1'
const enc = new TextEncoder()

/** What travels. */
interface Bundle {
  k: string
  n: string
  a?: string
  servers: string[]
  own: string[]
  pick: string
  clusters: Record<string, string[]>
}

async function derive(code: string): Promise<{ id: string; key: CryptoKey }> {
  const base = await crypto.subtle.importKey('raw', enc.encode(code) as BufferSource, 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT) as BufferSource, iterations: ROUNDS },
      base,
      384,
    ),
  )
  const id = [...bits.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const key = await crypto.subtle.importKey('raw', bits.slice(16, 48) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { id, key }
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

export interface Offer {
  /** For a person to type: three groups of four. */
  code: string
  server: string
  /** For a camera or a click: opens the page and links in one go. */
  link: string
  until: number
}

/** Everything another device needs to be you: what a link carries, and a backup. */
function bundleOfThisDevice(): Bundle {
  const secret = secretForLinking()
  if (!secret) throw new Error('This browser will not let your key be read back, so it cannot be copied from here.')
  return {
    k: secret,
    n: loadIdentity().name,
    // No picture: it is on your servers, and arrives with your record.
    servers: knownServers(),
    own: ownServers(),
    pick: newSpaceServer(),
    clusters: knownClusters(),
  }
}

/** Become whoever a bundle is. Returns their name. */
function adopt(bundle: Bundle): string {
  if (!takeIdentity(bundle.k)) throw new Error('This browser will not keep a key.')
  if (bundle.n) saveDisplayName(bundle.n)
  // A link made before the picture lived on the server may still carry one.
  if (typeof bundle.a === 'string' && bundle.a) saveAvatar(bundle.a)
  adoptServers(
    Array.isArray(bundle.servers) ? bundle.servers : [],
    Array.isArray(bundle.own) ? bundle.own : [],
    typeof bundle.pick === 'string' ? bundle.pick : '',
  )
  for (const [primary, others] of Object.entries(bundle.clusters ?? {})) {
    if (Array.isArray(others)) learn(primary, others.filter((u): u is string => typeof u === 'string'))
  }
  return bundle.n || ''
}

/** Leave this device's identity on its server, sealed, for another device to take. */
export async function offerLink(): Promise<Offer> {
  const server = newSpaceServer() || knownServers()[0] || ''
  if (!server) throw new Error('Add a server first: the link waits there for the other device.')
  const bundle = bundleOfThisDevice()
  const code = newSecret()
  const { id, key } = await derive(code)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const box = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(JSON.stringify(bundle)) as BufferSource),
  )
  const res = await fetch(`${server}/api/v1/links/${id}`, {
    method: 'PUT',
    mode: 'cors',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob: `${b64(iv)}.${b64(box)}` }),
  })
  if (!res.ok) throw new Error('Your server would not keep the link. Try again in a moment.')
  const { until } = (await res.json()) as { until?: number }
  const { origin, pathname } = window.location
  return {
    code: formatSecret(code),
    server,
    link: `${origin}${pathname}#link=${code}@${serverTag(server)}`,
    until: until ?? Date.now() + 10 * 60 * 1000,
  }
}

/** A code and the server it waits on, from a link, a pasted link, or `code@server`. Null when it is neither. */
export function readOffer(raw: string, server = ''): { code: string; server: string } | null {
  const text = raw.trim()
  const tail = text.includes('link=') ? text.slice(text.indexOf('link=') + 5) : text
  const [codePart, serverPart] = tail.split('@')
  const code = parseSecret(codePart ?? '')
  const where = serverUrl(serverPart ?? server)
  return code && where ? { code, server: where } : null
}

/** The link this page was opened with, if it was opened with one. */
export function linkInAddress(): { code: string; server: string } | null {
  const hash = window.location.hash.slice(1)
  return hash.startsWith('link=') ? readOffer(hash) : null
}

/**
 * Become the person on the other device: their key, name and picture, and
 * their servers beside any this device already knows. The page reloads after,
 * so everything starts again as them.
 */
export async function takeOffer(offer: { code: string; server: string }): Promise<string> {
  const { id, key } = await derive(offer.code)
  const res = await fetch(`${offer.server}/api/v1/links/${id}`, { mode: 'cors' }).catch(() => null)
  if (!res) throw new Error(`${serverTag(offer.server)} could not be reached.`)
  if (res.status === 404) throw new Error('That code has been used, or has run out. Make a new one on the other device.')
  if (!res.ok) throw new Error(`${serverTag(offer.server)} said no (${res.status}).`)
  const { blob } = (await res.json()) as { blob?: string }
  const [iv, box] = (blob ?? '').split('.')
  let bundle: Bundle
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) as BufferSource }, key, unb64(box) as BufferSource)
    bundle = JSON.parse(new TextDecoder().decode(plain)) as Bundle
  } catch {
    throw new Error('That link would not open. Make a new one on the other device.')
  }
  return adopt(bundle)
}

// ---------------------------------------------------------------------------
// A backup: the same, in a file you keep
// ---------------------------------------------------------------------------

/*
 * For the day a browser forgets everything: its storage cleared, a new
 * computer, a phone reset. The file is the account, as a link carries it, and
 * restoring it on the first screen is being you again, with every space and
 * message, because those were on your servers all along.
 *
 * It can have a password. Without one the file is the account in the open,
 * which is simple and is how most people will keep it (in a password manager,
 * or somewhere private); with one it is sealed the way a link is, and useless
 * to anybody who finds it, and to you if the password is forgotten.
 */

interface BackupFile {
  cathode: 'backup'
  version: 1
  keep: string
  saved: string
  name: string
  account?: Bundle
  sealed?: { salt: string; iv: string; box: string }
}

const KEEP =
  'This file is your Cathode account. Anybody who has it can be you, so keep it somewhere private. ' +
  'To use it, open Cathode, choose "I already use Cathode", then "Restore from a backup file".'

async function passwordKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password) as BufferSource, 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 600_000 },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** This device's account as a file to keep, sealed with a password when one is given. */
export async function backupFile(password = ''): Promise<{ name: string; blob: Blob }> {
  const account = bundleOfThisDevice()
  const file: BackupFile = { cathode: 'backup', version: 1, keep: KEEP, saved: new Date().toISOString(), name: account.n }
  if (password) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const key = await passwordKey(password, salt)
    const box = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(JSON.stringify(account)) as BufferSource),
    )
    file.sealed = { salt: b64(salt), iv: b64(iv), box: b64(box) }
  } else {
    file.account = account
  }
  const safe = (account.n || 'account').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-') || 'account'
  return { name: `cathode-${safe}.json`, blob: new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }) }
}

/** Whether a backup needs its password, or null when the text is not a backup at all. */
export function readBackup(text: string): { locked: boolean; name: string } | null {
  try {
    const file = JSON.parse(text) as Partial<BackupFile>
    if (file.cathode !== 'backup' || (!file.account && !file.sealed)) return null
    return { locked: !!file.sealed, name: typeof file.name === 'string' ? file.name : '' }
  } catch {
    return null
  }
}

/** Become the person in a backup. The page starts again after, as them. */
export async function restoreBackup(text: string, password = ''): Promise<string> {
  const file = JSON.parse(text) as BackupFile
  let account = file.account
  if (file.sealed) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(file.sealed.iv) as BufferSource },
        await passwordKey(password, unb64(file.sealed.salt)),
        unb64(file.sealed.box) as BufferSource,
      )
      account = JSON.parse(new TextDecoder().decode(plain)) as Bundle
    } catch {
      throw new Error('That is not the password this backup was saved with.')
    }
  }
  if (!account || typeof account.k !== 'string') throw new Error('That file is not a Cathode backup.')
  return adopt(account)
}
