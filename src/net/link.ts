import { serverTag, serverUrl } from '../backend'
import { fromBase64, toBase64 } from '../bytes'
import { formatSecret, newSecret, parseSecret } from '../room'
import { loadIdentity, saveDisplayName, secretForLinking, takeIdentity } from '../store/identity'
import { adoptServers, knownServers, newSpaceServer, ownServers } from '../store/server-spaces'
import { saveAvatar } from '../ui/avatar'
import { knownClusters, learn } from './cluster'

// A 60 bit code, stretched, readable once for ten minutes from a rate limited server.
const LINK_ROUNDS = 200_000
const BACKUP_ROUNDS = 600_000
const LINK_TTL_MS = 10 * 60 * 1000
const SALT = 'nook device link v1'
const enc = new TextEncoder()

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
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT) as BufferSource, iterations: LINK_ROUNDS },
      base,
      384,
    ),
  )
  const id = [...bits.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const key = await crypto.subtle.importKey('raw', bits.slice(16, 48) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { id, key }
}

export interface Offer {
  code: string
  server: string
  link: string
  until: number
}

function bundleOfThisDevice(): Bundle {
  const secret = secretForLinking()
  if (!secret) throw new Error('This browser will not let your key be read back, so it cannot be copied from here.')
  return {
    k: secret,
    n: loadIdentity().name,
    servers: knownServers(),
    own: ownServers(),
    pick: newSpaceServer(),
    clusters: knownClusters(),
  }
}

function adopt(bundle: Bundle): string {
  if (!takeIdentity(bundle.k)) throw new Error('This browser will not keep a key.')
  if (bundle.n) saveDisplayName(bundle.n)
  // An old link or backup may still carry the picture.
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
    body: JSON.stringify({ blob: `${toBase64(iv)}.${toBase64(box)}` }),
  })
  if (!res.ok) throw new Error('Your server would not keep the link. Try again in a moment.')
  const { until } = (await res.json()) as { until?: number }
  const { origin, pathname } = window.location
  return {
    code: formatSecret(code),
    server,
    link: `${origin}${pathname}#link=${code}@${serverTag(server)}`,
    until: until ?? Date.now() + LINK_TTL_MS,
  }
}

/** Reads a link, a pasted link, or `code@server`. */
export function readOffer(raw: string, server = ''): { code: string; server: string } | null {
  const text = raw.trim()
  const tail = text.includes('link=') ? text.slice(text.indexOf('link=') + 5) : text
  const [codePart, serverPart] = tail.split('@')
  const code = parseSecret(codePart ?? '')
  const where = serverUrl(serverPart ?? server)
  return code && where ? { code, server: where } : null
}

export function linkInAddress(): { code: string; server: string } | null {
  const hash = window.location.hash.slice(1)
  return hash.startsWith('link=') ? readOffer(hash) : null
}

export async function takeOffer(offer: { code: string; server: string }): Promise<string> {
  const { id, key } = await derive(offer.code)
  const res = await fetch(`${offer.server}/api/v1/links/${id}`, { mode: 'cors' }).catch(() => null)
  if (!res) throw new Error(`${serverTag(offer.server)} could not be reached. Check the server under the code.`)
  if (res.status === 404) throw new Error('That code has been used, or has run out. Make a new one on the other device.')
  if (!res.ok) throw new Error(`${serverTag(offer.server)} said no (${res.status}).`)
  const { blob } = (await res.json()) as { blob?: string }
  const [iv, box] = (blob ?? '').split('.')
  let bundle: Bundle
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(box))
    bundle = JSON.parse(new TextDecoder().decode(plain)) as Bundle
  } catch {
    throw new Error('That link would not open. Make a new one on the other device.')
  }
  return adopt(bundle)
}

interface BackupFile {
  nook: 'backup'
  version: 1
  keep: string
  saved: string
  name: string
  account?: Bundle
  sealed?: { salt: string; iv: string; box: string }
}

const KEEP =
  'This file is your Nook account. Anybody who has it can be you, so keep it somewhere private. ' +
  'To use it, open Nook, choose "I have an account", then "Use a backup file".'

async function passwordKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password) as BufferSource, 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: BACKUP_ROUNDS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function backupFile(password = ''): Promise<{ name: string; blob: Blob }> {
  const account = bundleOfThisDevice()
  const file: BackupFile = { nook: 'backup', version: 1, keep: KEEP, saved: new Date().toISOString(), name: account.n }
  if (password) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const key = await passwordKey(password, salt)
    const box = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(JSON.stringify(account)) as BufferSource),
    )
    file.sealed = { salt: toBase64(salt), iv: toBase64(iv), box: toBase64(box) }
  } else {
    file.account = account
  }
  const safe = (account.n || 'account').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-') || 'account'
  return { name: `nook-${safe}.json`, blob: new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }) }
}

export function readBackup(text: string): { locked: boolean; name: string } | null {
  try {
    const file = JSON.parse(text) as Partial<BackupFile>
    if (file.nook !== 'backup' || (!file.account && !file.sealed)) return null
    return { locked: !!file.sealed, name: typeof file.name === 'string' ? file.name : '' }
  } catch {
    return null
  }
}

export async function restoreBackup(text: string, password = ''): Promise<string> {
  const file = JSON.parse(text) as BackupFile
  let account = file.account
  if (file.sealed) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(file.sealed.iv) },
        await passwordKey(password, fromBase64(file.sealed.salt)),
        fromBase64(file.sealed.box),
      )
      account = JSON.parse(new TextDecoder().decode(plain)) as Bundle
    } catch {
      throw new Error('That is not the password this backup was saved with.')
    }
  }
  if (!account || typeof account.k !== 'string') throw new Error('That file is not a Nook backup.')
  return adopt(account)
}
