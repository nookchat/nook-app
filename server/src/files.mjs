/**
 * Files: pictures, videos and anything else somebody attaches.
 *
 * A file arrives sealed. The device that sent it made a key of its own for
 * it, encrypted it, and put the key in the message that carries it, which is
 * sealed with the space's key in turn. So this holds bytes it cannot read,
 * the same as everything else here.
 *
 * A file is named by the SHA-256 of its bytes, worked out here as it arrives.
 * The name is then a promise about the contents: a server in the cluster that
 * sends a file on can be checked against it, and the same upload twice is
 * kept once. The bytes go on disk, one file each, under FILES; the database
 * says which space holds which, how big, and in what order they came, for
 * the other servers of the cluster to follow.
 *
 * A space may hold MAX_ROOM_FILE_BYTES in files, and one file may be
 * MAX_FILE_BYTES. Past either an upload is refused, and says why.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CLUSTER_SECRET, FILES, MAX_FILE_BYTES, MAX_ROOM_FILE_BYTES, PEERS, PUBLIC_URL } from './config.mjs'
import { pool } from './db.mjs'
import { ApiError, corsHeaders } from './http.mjs'

export const FILE_ID = /^[0-9a-f]{64}$/

const pathOf = (room, id) => join(FILES, room, id)

async function has(room, id) {
  try {
    await stat(pathOf(room, id))
    return true
  } catch {
    return false
  }
}

/**
 * How much a space holds in files, as a number. Postgres sums a bigint into a
 * numeric, which arrives as text, and text added to a size is the two written
 * side by side: one file in, and the space looked full for ever after.
 */
async function heldBy(room) {
  const { rows } = await pool.query('select coalesce(sum(size), 0)::bigint as bytes from files where room = $1', [room])
  return Number(rows[0].bytes) || 0
}

/**
 * Keep what arrives on `source` as a file of `room`. `expected`, when given,
 * is the id it must turn out to have, for a file another server sends on.
 */
export async function keep(room, source, expected = '') {
  const declared = Number(source.headers?.['content-length'] ?? 0) || 0
  if (declared > MAX_FILE_BYTES) throw tooBig()
  if (declared && (await heldBy(room)) + declared > MAX_ROOM_FILE_BYTES) throw spaceFull()

  const temp = join(FILES, 'incoming', randomBytes(12).toString('hex'))
  await mkdir(join(FILES, 'incoming'), { recursive: true })
  const hash = createHash('sha256')
  let size = 0
  const counted = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length
      if (size > MAX_FILE_BYTES) return done(tooBig())
      hash.update(chunk)
      done(null, chunk)
    },
  })
  try {
    await pipeline(source, counted, createWriteStream(temp))
  } catch (err) {
    await rm(temp, { force: true })
    throw err instanceof ApiError ? err : new ApiError(400, 'upload_failed', 'The upload did not arrive whole.')
  }

  const id = hash.digest('hex')
  if (size === 0) {
    await rm(temp, { force: true })
    throw new ApiError(400, 'empty', 'That file is empty.')
  }
  if (expected && id !== expected) {
    await rm(temp, { force: true })
    throw new Error(`a file sent on as ${expected.slice(0, 12)} was really ${id.slice(0, 12)}`)
  }
  if (await has(room, id)) {
    await rm(temp, { force: true })
    return { id, size }
  }
  if ((await heldBy(room)) + size > MAX_ROOM_FILE_BYTES) {
    await rm(temp, { force: true })
    throw spaceFull()
  }
  await mkdir(join(FILES, room), { recursive: true })
  await rename(temp, pathOf(room, id))
  await pool.query('insert into files (room, id, size) values ($1, $2, $3) on conflict do nothing', [room, id, size])
  return { id, size }
}

/** Send a file back, fetching it from another server of the cluster first if this one has not got it yet. */
export async function send(req, res, room, id) {
  if (!(await has(room, id)) && !(await fromPeers(room, id))) {
    throw new ApiError(404, 'not_found', 'There is no such file here.')
  }
  const path = pathOf(room, id)
  const { size } = await stat(path)
  res.writeHead(200, {
    ...corsHeaders(req),
    'content-type': 'application/octet-stream',
    'content-length': size,
    // Named by its contents, so it never changes, and sealed, so a cache that keeps it learns nothing.
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  })
  await pipeline(createReadStream(path), res).catch(() => undefined)
}

/** Ask each other server for a file, and keep the first whole copy. */
async function fromPeers(room, id) {
  for (const peer of PEERS) {
    try {
      if (await fetchFrom(peer, room, id)) return true
    } catch {
      // That one does not have it, or is down. The next may.
    }
  }
  return false
}

async function fetchFrom(peer, room, id) {
  const res = await fetch(`${peer}/api/v1/spaces/${room}/files/${id}`, {
    headers: { authorization: `Bearer ${CLUSTER_SECRET}`, 'x-cathode-peer': PUBLIC_URL },
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok || !res.body) return false
  const { Readable } = await import('node:stream')
  const body = Readable.fromWeb(res.body)
  body.headers = { 'content-length': res.headers.get('content-length') ?? '0' }
  await keep(room, body, id)
  return true
}

/** Files kept after a point in this server's own order, for another server to follow. */
export async function filesFor(after) {
  const { rows } = await pool.query(
    'select room, id, size, change from files where change > $1 order by change limit 200',
    [after],
  )
  return { files: rows, at: rows.length ? rows[rows.length - 1].change : after }
}

/** Fetch every file a peer has that this server has not, in the peer's order. */
export async function pullFiles(peer, after, remember) {
  for (;;) {
    const res = await fetch(`${peer}/api/v1/cluster/files?after=${after}`, {
      headers: { authorization: `Bearer ${CLUSTER_SECRET}`, 'x-cathode-peer': PUBLIC_URL },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`${peer} said ${res.status}`)
    const page = await res.json()
    for (const file of page.files) {
      // Stopped at the first that will not come, so it is tried again next time rather than skipped.
      if (!(await has(file.room, file.id)) && !(await fetchFrom(peer, file.room, file.id))) return after
      after = file.change
      await remember(after)
    }
    if (page.files.length === 0) return after
  }
}

function tooBig() {
  return new ApiError(413, 'too_large', `A file may be at most ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB on this server.`)
}

function spaceFull() {
  return new ApiError(507, 'space_full', 'This space has used all the room this server gives it for files.')
}
