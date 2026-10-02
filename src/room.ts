import { serverTag, serverUrl } from './backend'
import { toHex } from './bytes'
import { confirmedEndpoints, hint } from './net/cluster'

const enc = new TextEncoder()

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 12
const GROUP_SIZE = 4
// A 60-bit code is too weak alone against offline grinding, so it is stretched.
const PBKDF2_ROUNDS = 250_000
const MAX_LINK_SERVERS = 5
const LOCKED_SUFFIX = '.P'
const SERVER_SEPARATOR = '@'
/** Before the servers: the pass of an invite made after a ban. */
const PASS_SEPARATOR = '~'
const PASS_LENGTH = 16

/** Passes read from links, by the space's code, until the space takes them. */
const passes = new Map<string, string>()

export function newPass(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PASS_LENGTH))
  return Array.from(bytes, (b) => CROCKFORD_BASE32[b & 31]).join('')
}

/** The pass a link to this space brought, once. */
export function takePass(secret: string): string {
  const pass = passes.get(secret) ?? ''
  passes.delete(secret)
  return pass
}

export interface Room {
  secret: string
  id: string
  key: CryptoKey
  /** Proof for the server that a writer holds the code: the room id is public. */
  write: string
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  // 256 is a multiple of 32, so masking a uniform byte stays unbiased.
  return Array.from(bytes, (b) => CROCKFORD_BASE32[b & 31]).join('')
}

export function formatSecret(secret: string): string {
  return (secret.match(new RegExp(`.{1,${GROUP_SIZE}}`, 'g')) ?? []).join('-')
}

export function parseSecret(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (cleaned.length !== CODE_LENGTH) return null
  for (const ch of cleaned) if (!CROCKFORD_BASE32.includes(ch)) return null
  return cleaned
}

export function newPeerId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(6)))
}

// Each value is a hash of the stretched bytes under its own label, so the public id reveals nothing.
async function labelled(stretched: Uint8Array, label: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(stretched, enc.encode(label)) as BufferSource))
}

export async function deriveRoom(secret: string, password = ''): Promise<Room> {
  const canonical = parseSecret(secret)
  if (!canonical) throw new Error('That is not a valid room code.')
  const salted = password ? `${canonical}|${password}` : canonical

  const material = await crypto.subtle.importKey(
    'raw',
    enc.encode(salted) as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const stretched = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: enc.encode('nook-space-v3'),
        iterations: PBKDF2_ROUNDS,
      },
      material,
      256,
    ),
  )

  const [idBytes, keyBytes, writeBytes] = await Promise.all([
    labelled(stretched, 'topic'),
    labelled(stretched, 'signal'),
    labelled(stretched, 'archive'),
  ])
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )

  return { secret: canonical, id: toHex(idBytes).slice(0, 32), key, write: toHex(writeBytes) }
}

/** The home site. Every link people share points here, whichever of its addresses the page came from. */
const HOME = 'https://nookchat.app'
/** The home site, with or without www, and the address it had before. */
const HOME_HOST = /^(www\.)?(nookchat\.app|cathode\.video)$/i

/** Where a link people share starts: the home site, or this page when it is a copy of Nook served elsewhere. */
export function shareBase(): string {
  const { origin, host, pathname } = window.location
  return `${HOME_HOST.test(host) ? HOME : origin}${pathname}`
}

export function roomLink(secret: string, locked = false, server = '', pass = ''): string {
  return `${shareBase()}#${linkTail(secret, locked, server, pass)}`
}

function unescapeServerTag(tag: string): string {
  try {
    return decodeURIComponent(tag)
  } catch {
    return ''
  }
}

function linkTail(secret: string, locked: boolean, server: string, pass = ''): string {
  const tags = server ? endpointsInOrder(server).map(serverTag).filter(Boolean) : []
  const servers = tags.length ? `${SERVER_SEPARATOR}${tags.join(',')}` : ''
  return `${formatSecret(secret)}${locked ? LOCKED_SUFFIX : ''}${pass ? `${PASS_SEPARATOR}${pass}` : ''}${servers}`
}

function endpointsInOrder(server: string): string[] {
  return confirmedEndpoints(server).slice(0, MAX_LINK_SERVERS)
}

export interface LinkInfo {
  secret: string
  locked: boolean
  /** Undefined, not empty, when the link names no server: the device may know one. */
  server?: string
}

export function parseLink(raw: string): LinkInfo | null {
  const trimmed = raw.trim()
  const at = trimmed.indexOf(SERVER_SEPARATOR)
  const head = at >= 0 ? trimmed.slice(0, at) : trimmed
  const tilde = head.indexOf(PASS_SEPARATOR)
  const code = tilde >= 0 ? head.slice(0, tilde) : head
  const pass = tilde >= 0 ? head.slice(tilde + 1).toUpperCase() : ''
  const named = at >= 0 ? unescapeServerTag(trimmed.slice(at + 1)).split(',').map(serverUrl) : []
  const server = at >= 0 ? named[0] : undefined
  if (at >= 0 && !server) return null
  const locked = code.toUpperCase().endsWith(LOCKED_SUFFIX)
  const secret = parseSecret(locked ? code.slice(0, -LOCKED_SUFFIX.length) : code)
  if (!secret) return null
  if (server && named.length > 1) hint(server, named.slice(1).filter(Boolean))
  if (pass.length === PASS_LENGTH && [...pass].every((ch) => CROCKFORD_BASE32.includes(ch))) passes.set(secret, pass)
  return server ? { secret, locked, server } : { secret, locked }
}

export function readLink(): LinkInfo | null {
  const frag = window.location.hash.replace(/^#/, '')
  return frag ? parseLink(frag) : null
}

export function setLinkSecret(secret: string, locked = false, server = ''): void {
  history.replaceState(null, '', `#${linkTail(secret, locked, server)}`)
}

export function clearLink(): void {
  history.replaceState(null, '', window.location.pathname)
}
