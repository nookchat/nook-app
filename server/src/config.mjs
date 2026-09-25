import { join, resolve } from 'node:path'

const env = process.env

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((v) => v.trim().replace(/\/+$/, ''))
    .filter(Boolean)

export const PORT = Number(env.PORT ?? 8787)

export const DATABASE_URL = env.DATABASE_URL ?? 'postgres://nook:nook@localhost:5432/nook'

export const DATA = resolve(env.NOOK_DATA ?? './data')
export const FILES = resolve(env.NOOK_FILES ?? join(DATA, 'files'))

export const MAX_FILE_BYTES = Number(env.NOOK_MAX_FILE_BYTES ?? 100 * 1024 * 1024)
export const MAX_ROOM_FILE_BYTES = Number(env.NOOK_MAX_ROOM_FILE_BYTES ?? 5 * 1024 * 1024 * 1024)
export const MAX_ROOM_BYTES = Number(env.NOOK_MAX_ROOM_BYTES ?? 256 * 1024 * 1024)

export const ORIGINS = list(env.NOOK_ORIGINS ?? '*')
export const ANY_ORIGIN = ORIGINS.length === 0 || ORIGINS.includes('*')

export function originAllowed(origin) {
  if (ANY_ORIGIN) return true
  return typeof origin === 'string' && ORIGINS.includes(origin)
}

const DOMAIN = String(env.NOOK_DOMAIN ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')

const TURN_URLS_SET = list(env.NOOK_TURN_URLS)
export const TURN_URLS = TURN_URLS_SET.length
  ? TURN_URLS_SET
  : DOMAIN && env.NOOK_TURN_SECRET
    ? [`turn:${DOMAIN}:3478?transport=udp`, `turn:${DOMAIN}:3478?transport=tcp`]
    : []
export const TURN_SECRET = env.NOOK_TURN_SECRET ?? ''
export const TURN_TTL_S = Number(env.NOOK_TURN_TTL ?? 24 * 60 * 60)
export const TURN_ONLY = env.NOOK_TURN_ONLY !== '0'
export const HAS_TURN = TURN_URLS.length > 0 && TURN_SECRET !== ''

export const KLIPY_KEY = env.NOOK_KLIPY_KEY ?? ''
export const TENOR_KEY = env.NOOK_TENOR_KEY ?? ''
export const GIPHY_KEY = env.NOOK_GIPHY_KEY ?? ''

export const PREVIEWS = env.NOOK_PREVIEWS !== '0'
// Tests only: lets link cards fetch from localhost.
export const PREVIEW_LOCAL = env.NOOK_PREVIEW_LOCAL === '1'

export const PUBLIC_URL = list(env.NOOK_PUBLIC_URL)[0] ?? (DOMAIN ? `https://${DOMAIN}` : '')
export const PEERS = list(env.NOOK_PEERS).filter((p) => p !== PUBLIC_URL)
export const CLUSTER_SECRET = env.NOOK_CLUSTER_SECRET ?? ''
export const CLUSTERED = PEERS.length > 0 && CLUSTER_SECRET.length >= 16
export const PEER_HEADERS = { authorization: `Bearer ${CLUSTER_SECRET}`, 'x-nook-peer': PUBLIC_URL }

export const MAX_ROOM_SOCKETS = Number(env.NOOK_MAX_ROOM_SOCKETS ?? 200)

export const RATE_PER_S = Number(env.NOOK_RATE ?? 30)
export const RATE_BURST = Number(env.NOOK_RATE_BURST ?? 120)

export const VERSION = '1.5.0'
