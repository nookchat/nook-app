/**
 * An optional archive for a Cathode space.
 *
 * Cathode needs no server. Every device keeps the whole history and hands it to
 * whoever turns up, so a space survives as long as one person who was in it
 * opens it again. What that cannot do is catch you up on something said while
 * every single person was offline, because there was nobody there to remember
 * it. That is the one hole, and this fills it.
 *
 * It is deliberately stupid. It appends opaque blobs to a file and hands them
 * back in order. It cannot read them: the client seals every event with the
 * key derived from the space code, which this never sees and cannot derive,
 * because the code lives in the fragment of a URL and is never sent anywhere.
 * A stolen disk is a pile of ciphertext.
 *
 * It also cannot lie usefully. Every event inside is signed by whoever wrote
 * it and is checked on arrival exactly like an event from a person, so an
 * archive that changes a message produces one that fails its signature and is
 * dropped. The worst it can do is forget, or refuse, and either of those puts
 * you back to where you started, which is a working space with no archive.
 *
 * No dependencies, no database, no build.
 *
 *   node server/server.mjs
 *   docker compose -f server/docker-compose.yml up -d
 */

import { createServer } from 'node:http'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

const PORT = Number(process.env.PORT ?? 8787)
const DATA = resolve(process.env.CATHODE_DATA ?? './data')

/** A room id is 32 hex characters and nothing else is a room id. */
const ROOM = /^[0-9a-f]{32}$/

/** One line of ciphertext. Generous for a message, mean for a nuisance. */
const MAX_LINE = 64 * 1024
/** How much one request may add at once. */
const MAX_BODY = 4 * 1024 * 1024
/** How much one space may keep. Past this the oldest go. */
const MAX_ROOM_BYTES = Number(process.env.CATHODE_MAX_ROOM_BYTES ?? 256 * 1024 * 1024)

await mkdir(DATA, { recursive: true })

const file = (room) => join(DATA, `${room}.jsonl`)
const tokenFile = (room) => join(DATA, `${room}.token`)

/**
 * Only somebody holding the space code may write.
 *
 * The room id is the relay topic, which any relay operator or wildcard
 * subscriber can see, and junk fails no check this side because nothing here
 * can be checked. It would still count against the room's cap, and the trim
 * would then eat the oldest half of the real history to make room for it. So
 * every write carries a token derived from the code, the first write claims
 * the room with it, and every write after that has to match.
 *
 * The disk keeps a hash of the token rather than the token, so the file is
 * not the credential. Claiming is first come: an attacker who learns a room
 * id before anybody legitimate writes could claim it, and the space would
 * simply have no archive here, which is where it started.
 */
async function mayWrite(room, token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) return false
  const hash = createHash('sha256').update(token).digest()
  try {
    // wx: claim only if unclaimed, atomically, so two first writes cannot race.
    await writeFile(tokenFile(room), hash.toString('hex') + '\n', { flag: 'wx' })
    return true
  } catch (err) {
    if (err?.code !== 'EEXIST') return false
  }
  try {
    const held = Buffer.from((await readFile(tokenFile(room), 'utf8')).trim(), 'hex')
    return held.length === hash.length && timingSafeEqual(held, hash)
  } catch {
    return false
  }
}

function send(res, code, body, type = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(code, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    /*
     * Anybody may talk to it, because the thing that decides who may read a
     * space is the key, not the origin. An archive that only answered one
     * website would be an archive that only worked for one deployment.
     */
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-cathode-write',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Read a request body, refusing anything oversized before it is in memory. */
function readBody(req) {
  return new Promise((done, fail) => {
    let size = 0
    const parts = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        fail(new Error('too much'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(parts).toString('utf8')))
    req.on('error', fail)
  })
}

/**
 * Hand back the lines after a given point.
 *
 * The cursor is a line count rather than a time, because time is the one thing
 * two machines never agree on and a count is the same number everywhere.
 */
async function since(room, from) {
  const path = file(room)
  try {
    await stat(path)
  } catch {
    return { at: 0, events: [] }
  }
  const out = []
  let n = 0
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) {
    n += 1
    if (n <= from) continue
    if (line) out.push(line)
  }
  return { at: n, events: out }
}

/** Drop the oldest half when a space has kept too much. */
async function trim(room) {
  const path = file(room)
  let size = 0
  try {
    size = (await stat(path)).size
  } catch {
    return
  }
  if (size <= MAX_ROOM_BYTES) return

  const kept = []
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) if (line) kept.push(line)
  const half = kept.slice(Math.floor(kept.length / 2))

  // Written beside and renamed over, so a crash in the middle costs the trim
  // rather than the room: rewriting in place left a truncated history behind.
  const fresh = `${path}.trim`
  await writeFile(fresh, half.join('\n') + (half.length ? '\n' : ''))
  await rename(fresh, path)
  console.log(`[cathode] trimmed ${room} to ${half.length} events`)
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '')

  const url = new URL(req.url ?? '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)

  if (parts[0] === 'health') return send(res, 200, { ok: true, service: 'cathode-archive' })

  if (parts[0] !== 'events' || !parts[1]) return send(res, 404, { error: 'no such thing' })
  const room = parts[1]
  if (!ROOM.test(room)) return send(res, 400, { error: 'that is not a room' })

  if (req.method === 'GET') {
    const from = Math.max(0, Number(url.searchParams.get('from') ?? 0) || 0)
    const page = await since(room, from)
    return send(res, 200, page)
  }

  if (req.method === 'POST') {
    if (!(await mayWrite(room, req.headers['x-cathode-write']))) {
      return send(res, 403, { error: 'that is not the write token this room was claimed with' })
    }

    let body
    try {
      body = await readBody(req)
    } catch {
      return send(res, 413, { error: 'too much at once' })
    }

    let events
    try {
      events = JSON.parse(body)
    } catch {
      return send(res, 400, { error: 'that is not json' })
    }
    if (!Array.isArray(events)) return send(res, 400, { error: 'expected a list' })

    /*
     * Every line has to be a string of a sane size and nothing else is
     * checked, because nothing else can be: this cannot read them. The client
     * verifies every signature on the way back in, which is the check that
     * matters and the only one that could catch a lie.
     */
    const clean = events.filter((e) => typeof e === 'string' && e.length > 0 && e.length <= MAX_LINE)
    if (clean.length === 0) return send(res, 200, { added: 0 })

    await appendFile(file(room), clean.join('\n') + '\n')
    await trim(room)
    return send(res, 200, { added: clean.length })
  }

  return send(res, 405, { error: 'not that way' })
})

server.listen(PORT, () => {
  console.log(`[cathode] archive on :${PORT}, keeping ciphertext in ${DATA}`)
})
