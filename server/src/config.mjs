/**
 * Everything the server can be told, read once from the environment.
 *
 * See server/README.md for what each one means, and server/.env.example for
 * a filled in set.
 */

import { join, resolve } from 'node:path'

const env = process.env

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((v) => v.trim().replace(/\/+$/, ''))
    .filter(Boolean)

export const PORT = Number(env.PORT ?? 8787)

/** Where the spaces are kept. */
export const DATABASE_URL = env.DATABASE_URL ?? 'postgres://cathode:cathode@localhost:5432/cathode'

/** Where the old file store lived. Read once, into the database, if anything is there. */
export const DATA = resolve(env.CATHODE_DATA ?? './data')

/** Where uploaded files are kept, as ciphertext, one file on disk each. */
export const FILES = resolve(env.CATHODE_FILES ?? join(DATA, 'files'))

/** The largest one file may be, in bytes, after it is sealed. */
export const MAX_FILE_BYTES = Number(env.CATHODE_MAX_FILE_BYTES ?? 100 * 1024 * 1024)

/** How much in files one space may keep. Past this an upload is refused. */
export const MAX_ROOM_FILE_BYTES = Number(env.CATHODE_MAX_ROOM_FILE_BYTES ?? 5 * 1024 * 1024 * 1024)

/** How much ciphertext one space may keep. Past this the oldest half goes. */
export const MAX_ROOM_BYTES = Number(env.CATHODE_MAX_ROOM_BYTES ?? 256 * 1024 * 1024)

/** The pages that may use this server, or * for any. */
export const ORIGINS = list(env.CATHODE_ORIGINS ?? '*')
export const ANY_ORIGIN = ORIGINS.length === 0 || ORIGINS.includes('*')

export function originAllowed(origin) {
  if (ANY_ORIGIN) return true
  return typeof origin === 'string' && ORIGINS.includes(origin)
}

/** TURN, for calls and screen shares. See turn.mjs. */
export const TURN_URLS = list(env.CATHODE_TURN_URLS)
export const TURN_SECRET = env.CATHODE_TURN_SECRET ?? ''
export const TURN_TTL_S = Number(env.CATHODE_TURN_TTL ?? 24 * 60 * 60)
export const TURN_ONLY = env.CATHODE_TURN_ONLY !== '0'
export const HAS_TURN = TURN_URLS.length > 0 && TURN_SECRET !== ''

/** GIF search for /gif. Off until a key is given. */
export const TENOR_KEY = env.CATHODE_TENOR_KEY ?? ''

/** Link cards. On unless turned off: the server learns which links are previewed. */
export const PREVIEWS = env.CATHODE_PREVIEWS !== '0'

/** For tests, which have nowhere to stand but localhost. */
export const PREVIEW_LOCAL = env.CATHODE_PREVIEW_LOCAL === '1'

/*
 * The cluster.
 *
 * Several people each run one of these, and they keep each other's copies
 * of every space: each pulls from every other, so a space survives any one
 * of them going away. They trust each other with ciphertext and nothing else.
 */
/** This server's own public address, as the pages and the other servers reach it. */
export const PUBLIC_URL = list(env.CATHODE_PUBLIC_URL)[0] ?? ''
/** The other servers in the cluster. */
export const PEERS = list(env.CATHODE_PEERS).filter((p) => p !== PUBLIC_URL)
/** What proves a request comes from another server in the cluster. Same on all of them. */
export const CLUSTER_SECRET = env.CATHODE_CLUSTER_SECRET ?? ''
export const CLUSTERED = PEERS.length > 0 && CLUSTER_SECRET.length >= 16

/** Connections one space may hold. */
export const MAX_ROOM_SOCKETS = Number(env.CATHODE_MAX_ROOM_SOCKETS ?? 200)

/** Requests one address may make, per second, on average, and in a burst. */
export const RATE_PER_S = Number(env.CATHODE_RATE ?? 30)
export const RATE_BURST = Number(env.CATHODE_RATE_BURST ?? 120)

export const VERSION = '1.3.0'
