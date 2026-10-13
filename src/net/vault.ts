import { serverTag, serverUrl } from '../backend'
import { fromBase64, toBase64, toHex } from '../bytes'
import { CROCKFORD_BASE32 } from '../room'
import { adoptBundle, bundleOfThisDevice, receiveServer, type Bundle } from './link'

/**
 * A vault is this account, sealed on a server under a key that only a passkey or a recovery key
 * can make. The server holds the sealed string and cannot open it. A new device that has the
 * passkey, or is given the recovery key, finds the vault, opens it, and becomes the account.
 */
const enc = new TextEncoder()
const RECORDS_KEY = 'nook.vaults.v1'
const RECOVERY_LENGTH = 20
const RECOVERY_GROUP = 5
const RECOVERY_ROUNDS = 200_000
const RECOVERY_SALT = 'nook recovery key v1'

export type VaultKind = 'passkey' | 'recovery'

/** What this device remembers of a vault it made: enough to show it and to remove it, never to open it. */
export interface VaultRecord {
  kind: VaultKind
  id: string
  /** Only removes the vault. It opens nothing. */
  token: string
  server: string
  at: string
  label: string
}

export interface VaultKeys {
  key: CryptoKey
  token: string
}

/** Where a new vault is kept: the server this device makes spaces on. */
export function vaultServer(): string {
  return receiveServer()
}

async function hkdf(seed: Uint8Array, info: string, bytes: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', seed as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) as BufferSource },
    base,
    bytes * 8,
  )
  return new Uint8Array(bits)
}

/** The key that seals the account and the token that claims the vault, from one secret. */
export async function keysFrom(seed: Uint8Array): Promise<VaultKeys> {
  const key = await crypto.subtle.importKey('raw', (await hkdf(seed, 'nook vault key', 32)) as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
  return { key, token: toHex(await hkdf(seed, 'nook vault token', 32)) }
}

export async function sha256Id(...parts: Uint8Array[]): Promise<string> {
  const all = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', all as BufferSource))).slice(0, 32)
}

async function seal(account: Bundle, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const box = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(JSON.stringify(account)) as BufferSource),
  )
  return `${toBase64(iv)}.${toBase64(box)}`
}

async function open(blob: string, key: CryptoKey): Promise<Bundle> {
  const [iv, box] = blob.split('.')
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(box))
    const account = JSON.parse(new TextDecoder().decode(plain)) as Bundle
    if (typeof account?.k === 'string') return account
  } catch {
    /* falls through */
  }
  throw new Error('That key does not open this account.')
}

const address = (server: string, id: string): string => `${server}/api/v1/vaults/${id}`

/** Keeps this account in a vault, and remembers it here. */
export async function keepVault(kind: VaultKind, id: string, keys: VaultKeys, server: string, label: string): Promise<VaultRecord> {
  if (!server) throw new Error('Add a server first: the account is kept there, sealed.')
  const res = await fetch(address(server, id), {
    method: 'PUT',
    mode: 'cors',
    headers: { 'content-type': 'application/json', 'x-nook-write': keys.token },
    body: JSON.stringify({ blob: await seal(bundleOfThisDevice(), keys.key) }),
  }).catch(() => null)
  if (!res) throw new Error(`${serverTag(server)} could not be reached.`)
  if (!res.ok) throw new Error(`${serverTag(server)} would not keep it (${res.status}).`)
  const record: VaultRecord = { kind, id, token: keys.token, server, at: new Date().toISOString(), label }
  saveRecords([...records().filter((each) => each.id !== id), record])
  return record
}

/** Finds a vault and opens it. */
export async function openVault(id: string, keys: VaultKeys, server: string): Promise<Bundle> {
  const res = await fetch(address(server, id), { mode: 'cors' }).catch(() => null)
  if (!res) throw new Error(`${serverTag(server)} could not be reached. Check the server.`)
  if (res.status === 404) throw new Error(`${serverTag(server)} has no account kept under that key.`)
  if (!res.ok) throw new Error(`${serverTag(server)} said no (${res.status}).`)
  const { blob } = (await res.json()) as { blob?: string }
  return open(blob ?? '', keys.key)
}

/** Takes a vault off its server and forgets it here. A server that is gone leaves nothing to remove. */
export async function dropVault(record: VaultRecord): Promise<void> {
  const res = await fetch(address(record.server, record.id), {
    method: 'DELETE',
    mode: 'cors',
    headers: { 'x-nook-write': record.token },
  }).catch(() => null)
  if (res && !res.ok && res.status !== 404 && res.status !== 403) throw new Error(`${serverTag(record.server)} said no (${res.status}).`)
  saveRecords(records().filter((each) => each.id !== record.id))
}

export function records(kind?: VaultKind): VaultRecord[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECORDS_KEY) ?? '[]') as VaultRecord[]
    return Array.isArray(list) ? list.filter((each) => !kind || each.kind === kind) : []
  } catch {
    return []
  }
}

function saveRecords(list: VaultRecord[]): void {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(list))
  } catch {}
}

/** A recovery key: 100 random bits, in four groups of five. Too strong to guess, so it needs no password. */
export function newRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_LENGTH))
  const chars = Array.from(bytes, (b) => CROCKFORD_BASE32[b & 31])
  return (chars.join('').match(new RegExp(`.{1,${RECOVERY_GROUP}}`, 'g')) ?? []).join('-')
}

/** The key as it is typed or pasted, in its plain form, or null. A server may follow an @. */
export function readRecoveryKey(raw: string, fallbackServer = ''): { key: string; server: string } | null {
  const [keyPart, serverPart] = raw.trim().split('@')
  const key = (keyPart ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (key.length !== RECOVERY_LENGTH || ![...key].every((ch) => CROCKFORD_BASE32.includes(ch))) return null
  const server = serverUrl(serverPart ?? fallbackServer)
  return server ? { key, server } : null
}

export function formatRecoveryKey(key: string): string {
  return (key.match(new RegExp(`.{1,${RECOVERY_GROUP}}`, 'g')) ?? []).join('-')
}

async function recoveryParts(key: string): Promise<{ id: string; keys: VaultKeys }> {
  const base = await crypto.subtle.importKey('raw', enc.encode(key) as BufferSource, 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(RECOVERY_SALT) as BufferSource, iterations: RECOVERY_ROUNDS },
      base,
      384,
    ),
  )
  return { id: toHex(bits.slice(0, 16)), keys: await keysFrom(bits.slice(16, 48)) }
}

/** Makes a recovery key and keeps this account under it. Any older recovery key stops working. */
export async function makeRecoveryKey(): Promise<{ key: string; server: string; record: VaultRecord }> {
  const server = vaultServer()
  const key = newRecoveryKey()
  const { id, keys } = await recoveryParts(key.replace(/-/g, ''))
  const record = await keepVault('recovery', id, keys, server, 'Recovery key')
  for (const old of records('recovery')) if (old.id !== id) await dropVault(old).catch(() => undefined)
  return { key, server, record }
}

/** Opens the account a recovery key was made for. */
export async function signInWithRecoveryKey(raw: string, server = ''): Promise<Bundle> {
  const read = readRecoveryKey(raw, server)
  if (!read) throw new Error('That is not a recovery key. It is four groups of five letters and numbers.')
  const { id, keys } = await recoveryParts(read.key)
  return openVault(id, keys, read.server)
}

export { adoptBundle }
