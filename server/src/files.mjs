import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { FILES, MAX_FILE_BYTES, MAX_ROOM_FILE_BYTES, PEER_HEADERS, PEERS } from './config.mjs'
import { pool } from './db.mjs'
import { ApiError, corsHeaders } from './http.mjs'

export const FILE_ID = /^[0-9a-f]{64}$/

const INCOMING = join(FILES, 'incoming')

const pathOf = (room, id) => join(FILES, room, id)

async function sizeOf(room, id) {
  try {
    return (await stat(pathOf(room, id))).size
  } catch {
    return null
  }
}

const has = async (room, id) => (await sizeOf(room, id)) !== null

// sum(bigint) is a numeric, which pg returns as text, so cast it back to bigint.
async function heldBy(room) {
  const { rows } = await pool.query('select coalesce(sum(size), 0)::bigint as bytes from files where room = $1', [room])
  return Number(rows[0].bytes) || 0
}

export async function keep(room, source, expectedId = '') {
  const declared = Number(source.headers?.['content-length'] ?? 0) || 0
  if (declared > MAX_FILE_BYTES) throw tooBig()
  if (declared && (await heldBy(room)) + declared > MAX_ROOM_FILE_BYTES) throw spaceFull()

  const temp = join(INCOMING, randomBytes(12).toString('hex'))
  await mkdir(INCOMING, { recursive: true })
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
  if (expectedId && id !== expectedId) {
    await rm(temp, { force: true })
    throw new Error(`a file sent on as ${expectedId.slice(0, 12)} was really ${id.slice(0, 12)}`)
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

export async function send(req, res, room, id) {
  let size = await sizeOf(room, id)
  if (size === null && (await fromPeers(room, id))) size = await sizeOf(room, id)
  if (size === null) throw new ApiError(404, 'not_found', 'There is no such file here.')
  const headers = {
    ...corsHeaders(req),
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  }
  // One range, so a video can be read a piece at a time and jumped about in.
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim())
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (!Number.isSafeInteger(start) || start >= size || end < start) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 })
      res.end()
      return
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
    await pipeline(createReadStream(pathOf(room, id), { start, end }), res).catch(() => undefined)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': size })
  await pipeline(createReadStream(pathOf(room, id)), res).catch(() => undefined)
}

async function fromPeers(room, id) {
  for (const peer of PEERS) {
    try {
      if (await fetchFrom(peer, room, id)) return true
    } catch {
      /* that peer is down or lacks it; try the next */
    }
  }
  return false
}

async function fetchFrom(peer, room, id) {
  const res = await fetch(`${peer}/api/v1/spaces/${room}/files/${id}`, {
    headers: PEER_HEADERS,
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok || !res.body) return false
  const body = Readable.fromWeb(res.body)
  body.headers = { 'content-length': res.headers.get('content-length') ?? '0' }
  await keep(room, body, id)
  return true
}

export async function filesFor(after) {
  const { rows } = await pool.query(
    'select room, id, size, change from files where change > $1 order by change limit 200',
    [after],
  )
  return { files: rows, at: rows.length ? rows[rows.length - 1].change : after }
}

export async function pullFiles(peer, after, remember) {
  for (;;) {
    const res = await fetch(`${peer}/api/v1/cluster/files?after=${after}`, {
      headers: PEER_HEADERS,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`${peer} said ${res.status}`)
    const page = await res.json()
    for (const file of page.files) {
      // Stop at the first that will not come, so it is retried, not skipped.
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
