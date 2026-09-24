/**
 * The Cathode server: an archive, a relay, and a way through strict networks.
 *
 * A space runs one of two ways. Peer to peer, it needs no server, and this is
 * an optional archive beside it. On a server, this is the backend: every
 * handshake, every chat line and every event goes through the relay below,
 * the history lives here, and the TURN credentials it hands out let the
 * picture and the sound through a network that blocks peer to peer. Both
 * ways, what it carries and keeps is sealed, and it cannot read any of it.
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
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { join, resolve } from 'node:path'


const PORT = Number(process.env.PORT ?? 8787)
const DATA = resolve(process.env.CATHODE_DATA ?? './data')

/** A room id is 32 hex characters and nothing else is a room id. */
const ROOM = /^[0-9a-f]{32}$/

/**
 * One line of ciphertext. Generous for a message, mean for a nuisance.
 *
 * A line is four thirds of the event it seals, and change: b64url of iv plus
 * AES-GCM over the envelope. The client caps an event body (MAX_BODY, in
 * store/log.ts) so a full-size message seals to under 64 KiB; this sits at
 * double that so the two numbers never touch. Raise that one, raise this one.
 */
const MAX_LINE = 128 * 1024
/** How much one request may add at once. */
const MAX_BODY = 4 * 1024 * 1024
/** How much one space may keep. Past this the oldest go. */
const MAX_ROOM_BYTES = Number(process.env.CATHODE_MAX_ROOM_BYTES ?? 256 * 1024 * 1024)

/**
 * Which pages may use this server. A comma separated list of origins, such as
 * https://cathode.example.org, or * for any page at all.
 *
 * Nothing here needs it for secrecy, because the key decides who can read a
 * space. It decides whose bandwidth this is: a server that answers every
 * website is a free relay for all of them.
 */
const ORIGINS = (process.env.CATHODE_ORIGINS ?? '*')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean)
const ANY_ORIGIN = ORIGINS.length === 0 || ORIGINS.includes('*')

/** True when a request from this origin may use the server. */
function originAllowed(origin) {
  if (ANY_ORIGIN) return true
  return typeof origin === 'string' && ORIGINS.includes(origin)
}

/*
 * TURN, for the picture and the sound.
 *
 * Peer to peer media fails on about one network in eight, and the only fix is
 * a relay that carries it. The relay is coturn, next to this in the compose
 * file; this hands out short lived credentials for it, made the way coturn's
 * use-auth-secret expects, so the shared secret never leaves this machine.
 * CATHODE_TURN_ONLY sends every call through it, which hides each person's
 * address from everybody else at the cost of this machine's bandwidth.
 */
const TURN_URLS = (process.env.CATHODE_TURN_URLS ?? '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean)
const TURN_SECRET = process.env.CATHODE_TURN_SECRET ?? ''
const TURN_TTL_S = Number(process.env.CATHODE_TURN_TTL ?? 24 * 60 * 60)
const TURN_ONLY = process.env.CATHODE_TURN_ONLY === '1'
const HAS_TURN = TURN_URLS.length > 0 && TURN_SECRET !== ''

function iceServers() {
  if (!HAS_TURN) return { iceServers: [], relayOnly: false }
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:cathode`
  const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64')
  return { iceServers: [{ urls: TURN_URLS, username, credential }], relayOnly: TURN_ONLY }
}

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
/** The claimed hash per room, once read, so a write does not read the disk. */
const claims = new Map()

async function mayWrite(room, token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) return false
  const hash = createHash('sha256').update(token).digest()
  let held = claims.get(room)
  if (!held) {
    try {
      // wx: claim only if unclaimed, atomically, so two first writes cannot race.
      await writeFile(tokenFile(room), hash.toString('hex') + '\n', { flag: 'wx' })
      claims.set(room, hash)
      return true
    } catch (err) {
      if (err?.code !== 'EEXIST') return false
    }
    try {
      held = Buffer.from((await readFile(tokenFile(room), 'utf8')).trim(), 'hex')
    } catch {
      return false
    }
    claims.set(room, held)
  }
  return held.length === hash.length && timingSafeEqual(held, hash)
}

/*
 * No compression here. A page of history is base64 ciphertext, which gzip
 * shrinks by a quarter at best and at sixteen milliseconds a megabyte: slower
 * than sending it on any network this runs on. The Caddyfile beside this can
 * compress at the edge, with zstd, for anybody on a slow line.
 */
function send(res, code, body, type = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const origin = res.req?.headers.origin
  const payload = Buffer.from(text)
  res.writeHead(code, {
    'content-type': type,
    'content-length': payload.length,
    /*
     * By default anybody may talk to it, because the thing that decides who
     * may read a space is the key, not the origin. CATHODE_ORIGINS narrows it
     * to the pages you serve, which decides whose bandwidth this is.
     */
    'access-control-allow-origin': ANY_ORIGIN ? '*' : originAllowed(origin) ? origin : 'null',
    vary: 'origin',
    'access-control-allow-headers': 'content-type,x-cathode-write',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  })
  res.end(payload)
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

/*
 * Where every line starts, per room, kept in memory.
 *
 * Reading "everything after line N" used to read the file from the top and
 * count, every time, so catching up on the last ten lines of a busy room read
 * all of it. Now the file is read once, the first time anybody asks, and the
 * byte each line starts at is remembered. After that a read is one seek and
 * one read of exactly the bytes wanted, and an append adds to the list.
 *
 * About eight bytes per line: a room at its cap holds a few hundred thousand
 * lines, which is a couple of megabytes of numbers.
 */
const indexes = new Map()

/** One room at a time: an append and a trim must never interleave with a read. */
const queues = new Map()

function exclusive(room, work) {
  const before = queues.get(room) ?? Promise.resolve()
  const run = before.then(work, work)
  const settled = run.catch(() => undefined)
  queues.set(room, settled)
  void settled.then(() => {
    if (queues.get(room) === settled) queues.delete(room)
  })
  return run
}

/** Build the index by reading the file once, in chunks, counting newlines. */
async function indexOf(room) {
  const held = indexes.get(room)
  if (held) return held
  const starts = []
  let size = 0
  let lineOpen = false
  try {
    for await (const chunk of createReadStream(file(room), { highWaterMark: 1 << 20 })) {
      for (let i = 0; i < chunk.length; i++) {
        if (!lineOpen) {
          starts.push(size + i)
          lineOpen = true
        }
        if (chunk[i] === 10) lineOpen = false
      }
      size += chunk.length
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  const index = { starts, size }
  indexes.set(room, index)
  return index
}

/** The most one page of history may carry, in lines and in bytes. */
const PAGE_LINES = 5000
const PAGE_BYTES = 8 * 1024 * 1024

/**
 * Hand back the lines after a given point.
 *
 * The cursor is a line count rather than a time, because time is the one thing
 * two machines never agree on and a count is the same number everywhere.
 *
 * At most one page at a time. `more` says there is another, and a client from
 * before pages existed reads one page per visit and catches up over a few.
 */
function since(room, from, limit) {
  return exclusive(room, async () => {
    const { starts, size } = await indexOf(room)
    const total = starts.length
    if (from >= total) return { at: total, events: [], more: false }
    let end = Math.min(total, from + Math.min(limit || PAGE_LINES, PAGE_LINES))
    const first = starts[from]
    const endByte = (i) => (i < total ? starts[i] : size)
    // Never more than a page of bytes, but always at least one line.
    while (end > from + 1 && endByte(end) - first > PAGE_BYTES) end = from + Math.ceil((end - from) / 2)
    const length = endByte(end) - first
    const buffer = Buffer.alloc(length)
    const handle = await open(file(room), 'r')
    try {
      await handle.read(buffer, 0, length, first)
    } finally {
      await handle.close()
    }
    const events = buffer.toString('utf8').split('\n').filter(Boolean)
    return { at: end, events, more: end < total }
  })
}

/** Add lines to a room, and drop the oldest half if that made it too big. */
function append(room, lines) {
  return exclusive(room, async () => {
    const index = await indexOf(room)
    const text = lines.join('\n') + '\n'
    await appendFile(file(room), text)
    for (const line of lines) {
      index.starts.push(index.size)
      index.size += Buffer.byteLength(line) + 1
    }
    if (index.size > MAX_ROOM_BYTES) await trim(room, index)
  })
}

/** Drop the oldest half. Called inside the room's queue, with its index. */
async function trim(room, index) {
  const path = file(room)
  const buffer = await readFile(path)
  const keepFrom = index.starts[Math.floor(index.starts.length / 2)] ?? buffer.length
  const half = buffer.subarray(keepFrom)

  // Written beside and renamed over, so a crash in the middle costs the trim
  // rather than the room: rewriting in place left a truncated history behind.
  const fresh = `${path}.trim`
  await writeFile(fresh, half)
  await rename(fresh, path)
  // Every line moved, so the index is rebuilt from what is there now.
  indexes.delete(room)
  const rebuilt = await indexOf(room)
  console.log(`[cathode] trimmed ${room} to ${rebuilt.starts.length} events`)
}

/*
 * Link previews.
 *
 * A browser cannot read another site's page, so a chat message with a link in
 * it cannot grow a card by itself. Somebody has to go and look, and this is
 * the one machine the space already chose to trust with being awake. It
 * learns which links get previewed, which is less than the ciphertext it
 * already holds; a space that dislikes even that runs no archive.
 *
 * It fetches with care, because "go and look at any URL" is an invitation:
 * only http and https, never an address that resolves into this machine's own
 * network, redirects walked by hand so they cannot smuggle one in, five
 * seconds and half a megabyte at most, and everything cached so a room of
 * thirty people costs a site one visit.
 */
const PREVIEW_TIMEOUT_MS = 5000
const PREVIEW_MAX_BYTES = 512 * 1024
const PREVIEW_CACHE_MS = 10 * 60 * 1000
const PREVIEW_CACHE_MAX = 500
const previews = new Map()

function privateAddress(ip) {
  let v4 = ip
  const low = ip.toLowerCase()
  if (low.includes(':')) {
    if (low.startsWith('::ffff:')) v4 = low.slice(7)
    else {
      return (
        low === '::1' ||
        low === '::' ||
        low.startsWith('fc') ||
        low.startsWith('fd') ||
        low.startsWith('fe80')
      )
    }
  }
  const [a, b] = v4.split('.').map(Number)
  return (
    !Number.isFinite(a) ||
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

async function hostAllowed(host) {
  // For tests, which have nowhere to stand but localhost.
  if (process.env.CATHODE_PREVIEW_LOCAL === '1') return true
  try {
    const addresses = await lookup(host, { all: true })
    return addresses.length > 0 && addresses.every((a) => !privateAddress(a.address))
  } catch {
    return false
  }
}

/** The first chunk of a page, or null for anything that is not a public html page. */
async function fetchPage(rawUrl) {
  let url = rawUrl
  for (let hop = 0; hop < 4; hop++) {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!(await hostAllowed(parsed.hostname))) return null

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PREVIEW_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': 'cathode-archive/preview', accept: 'text/html' },
      })
      if (res.status >= 300 && res.status < 400) {
        const to = res.headers.get('location')
        if (!to) return null
        url = new URL(to, url).href
        continue
      }
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) {
        return null
      }
      const reader = res.body.getReader()
      const chunks = []
      let read = 0
      while (read < PREVIEW_MAX_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        read += value.length
      }
      void reader.cancel().catch(() => undefined)
      return Buffer.concat(chunks).toString('utf8')
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

function unescapeHtml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
}

function metaOf(html, name) {
  const tag = html.match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i'),
  )?.[0]
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? ''
  return unescapeHtml(content).trim()
}

function previewOf(html, pageUrl) {
  const title = metaOf(html, 'og:title') || unescapeHtml(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim()
  const description = metaOf(html, 'og:description') || metaOf(html, 'description')
  let image = ''
  const rawImage = metaOf(html, 'og:image')
  if (rawImage) {
    try {
      const abs = new URL(rawImage, pageUrl)
      if (abs.protocol === 'http:' || abs.protocol === 'https:') image = abs.href
    } catch {
      /* a picture that is not an address is no picture */
    }
  }
  const out = {}
  if (title) out.title = title.slice(0, 160)
  if (description) out.description = description.slice(0, 300)
  if (image) out.image = image.slice(0, 2048)
  const site = metaOf(html, 'og:site_name')
  if (site) out.site = site.slice(0, 80)
  return out
}

/*
 * GIF search, for the /gif command.
 *
 * Every keyless way in is gone: Tenor v1 is discontinued and Giphy's old
 * public key is banned. So the archive holds the key, out of the page and
 * off every member's device, and the client asks here. Free keys come from
 * https://developers.google.com/tenor — set CATHODE_TENOR_KEY and restart.
 * Search terms reach Tenor, which is the deal being made and is why it is
 * off unless somebody turns it on.
 */
const TENOR_KEY = process.env.CATHODE_TENOR_KEY ?? ''
const gifCache = new Map()

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '')

  const url = new URL(req.url ?? '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)

  /*
   * The service name stays what it was when this was only an archive, because
   * every client in the wild checks for it before it trusts the address.
   */
  if (parts[0] === 'health') {
    return send(res, 200, {
      ok: true,
      service: 'cathode-archive',
      name: 'cathode',
      turn: HAS_TURN,
      relayOnly: HAS_TURN && TURN_ONLY,
    })
  }

  // A page this server does not serve gets nothing but the health check.
  if (!originAllowed(req.headers.origin) && req.headers.origin !== undefined) {
    return send(res, 403, { error: 'this server does not answer that page' })
  }

  if (parts[0] === 'ice' && req.method === 'GET') return send(res, 200, iceServers())

  if (parts[0] === 'gif' && req.method === 'GET') {
    if (!TENOR_KEY) return send(res, 404, { error: 'this archive has no GIF key' })
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80)
    if (!q) return send(res, 400, { error: 'say what to look for' })
    const held = gifCache.get(q.toLowerCase())
    if (held && Date.now() - held.at < PREVIEW_CACHE_MS) return send(res, 200, held.data)
    try {
      const upstream = await fetch(
        `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}` +
          `&key=${TENOR_KEY}&limit=24&media_filter=gif,tinygif&contentfilter=medium`,
        { signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS) },
      )
      if (!upstream.ok) return send(res, 502, { error: 'tenor said no' })
      const body = await upstream.json()
      const gifs = (Array.isArray(body.results) ? body.results : [])
        .map((g) => ({
          url: g?.media_formats?.gif?.url ?? '',
          preview: g?.media_formats?.tinygif?.url ?? g?.media_formats?.gif?.url ?? '',
        }))
        .filter((g) => g.url.startsWith('https://'))
      const data = { gifs }
      if (gifCache.size >= PREVIEW_CACHE_MAX) gifCache.delete(gifCache.keys().next().value)
      gifCache.set(q.toLowerCase(), { at: Date.now(), data })
      return send(res, 200, data)
    } catch {
      return send(res, 502, { error: 'tenor did not answer' })
    }
  }

  if (parts[0] === 'preview' && req.method === 'GET') {
    const wanted = url.searchParams.get('url') ?? ''
    if (!wanted || wanted.length > 2048) return send(res, 400, { error: 'that is not a link' })
    const held = previews.get(wanted)
    if (held && Date.now() - held.at < PREVIEW_CACHE_MS) return send(res, 200, held.data)
    const html = await fetchPage(wanted)
    // A page that answered nothing is cached as nothing, so a dead link does
    // not cost one fetch per person who scrolls past it.
    const data = html ? previewOf(html, wanted) : {}
    if (previews.size >= PREVIEW_CACHE_MAX) previews.delete(previews.keys().next().value)
    previews.set(wanted, { at: Date.now(), data })
    return send(res, 200, data)
  }

  if (parts[0] !== 'events' || !parts[1]) return send(res, 404, { error: 'no such thing' })
  const room = parts[1]
  if (!ROOM.test(room)) return send(res, 400, { error: 'that is not a room' })

  if (req.method === 'GET') {
    const from = Math.max(0, Math.floor(Number(url.searchParams.get('from') ?? 0)) || 0)
    const limit = Math.max(0, Math.floor(Number(url.searchParams.get('limit') ?? 0)) || 0)
    const page = await since(room, from, limit)
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

    await append(room, clean)
    return send(res, 200, { added: clean.length })
  }

  return send(res, 405, { error: 'not that way' })
})

/* =========================================================================
   The relay.

   The handshakes that start a space ride public MQTT brokers and Nostr
   relays: other people's machines, free, and occasionally all having a bad
   night at once. A space that already trusts this machine with its sealed
   history can lean on it to carry its sealed handshakes too, and then a bad
   night for the public relays is somebody else's bad night.

   It is as stupid as the rest of this file. A socket joins a room; every
   text frame it sends is handed, unread, to every other socket in the same
   room; nothing is stored, nothing is answered. The frames are sealed by
   the same envelope the public relays carry, and the room id in the path is
   the same topic they see, so this learns nothing they do not.

   WebSocket by hand, because the whole protocol this needs is forty lines
   and the file's first rule is no dependencies.
   ========================================================================= */

/**
 * The biggest frame. A handshake is a few kilobytes, but a space that runs on
 * this server sends its chat here too, and a batch of history is sized to
 * stay under this (see BATCH_BYTES in store/room-chat.ts).
 */
const MAX_FRAME = 512 * 1024
/** Sockets one room may hold. A space is people, not a botnet. */
const MAX_ROOM_SOCKETS = 64
/** Dead sockets are found by pinging this often. */
const PING_MS = 30_000

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** room id -> the sockets standing in it. */
const relayRooms = new Map()

function wsFrame(opcode, payload) {
  const len = payload.length
  let head
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len])
  } else if (len < 65_536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, payload])
}

function relayLeave(room, socket) {
  const standing = relayRooms.get(room)
  if (!standing) return
  standing.delete(socket)
  if (standing.size === 0) relayRooms.delete(room)
}

server.on('upgrade', (req, socket) => {
  const path = (req.url ?? '').split('?')[0]
  const m = /^\/relay\/([0-9a-f]{32})$/.exec(path)
  const key = req.headers['sec-websocket-key']
  if (!m || typeof key !== 'string' || !/websocket/i.test(String(req.headers.upgrade ?? ''))) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }
  if (!originAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  const room = m[1]
  const standing = relayRooms.get(room) ?? new Set()
  if (standing.size >= MAX_ROOM_SOCKETS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
    socket.destroy()
    return
  }

  const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.setNoDelay(true)
  standing.add(socket)
  relayRooms.set(room, standing)
  socket.cathodeAlive = true

  const goodbye = (code) => {
    try {
      const reason = Buffer.alloc(2)
      reason.writeUInt16BE(code, 0)
      socket.write(wsFrame(8, reason))
    } catch {
      /* it was already gone */
    }
    relayLeave(room, socket)
    socket.destroy()
  }

  /*
   * The frames, straight off the wire. A client frame is always masked, so
   * an unmasked one is not a browser and is shown the door, the way the RFC
   * says. Fragmented frames are refused too: a handshake fits in one frame,
   * and half a handshake is worth nothing.
   */
  let held = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    held = Buffer.concat([held, chunk])
    for (;;) {
      if (held.length < 2) return
      const fin = (held[0] & 0x80) !== 0
      const opcode = held[0] & 0x0f
      const masked = (held[1] & 0x80) !== 0
      let len = held[1] & 0x7f
      let at = 2
      if (len === 126) {
        if (held.length < at + 2) return
        len = held.readUInt16BE(at)
        at += 2
      } else if (len === 127) {
        if (held.length < at + 8) return
        const big = held.readBigUInt64BE(at)
        if (big > BigInt(MAX_FRAME)) return goodbye(1009)
        len = Number(big)
        at += 8
      }
      if (len > MAX_FRAME) return goodbye(1009)
      if (!masked) return goodbye(1002)
      if (held.length < at + 4 + len) return
      const mask = held.subarray(at, at + 4)
      const payload = held.subarray(at + 4, at + 4 + len)
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      held = held.subarray(at + 4 + len)

      if (opcode === 8) return goodbye(1000)
      if (opcode === 9) {
        socket.write(wsFrame(10, payload))
        continue
      }
      if (opcode === 10) {
        socket.cathodeAlive = true
        continue
      }
      if (opcode !== 1 || !fin) return goodbye(1003)

      const out = wsFrame(1, Buffer.from(payload))
      for (const other of relayRooms.get(room) ?? []) {
        if (other !== socket && !other.destroyed) other.write(out)
      }
    }
  })

  socket.on('close', () => relayLeave(room, socket))
  socket.on('error', () => {
    relayLeave(room, socket)
    socket.destroy()
  })
})

/* One heartbeat for every socket. A socket that never answers a ping is a
   phone off the hook, and holding it open keeps a seat warm in the room. */
setInterval(() => {
  for (const standing of relayRooms.values()) {
    for (const socket of standing) {
      if (!socket.cathodeAlive) {
        socket.destroy()
        continue
      }
      socket.cathodeAlive = false
      try {
        socket.write(wsFrame(9, Buffer.alloc(0)))
      } catch {
        socket.destroy()
      }
    }
  }
}, PING_MS).unref()

server.listen(PORT, () => {
  console.log(
    `[cathode] on :${PORT}, keeping ciphertext in ${DATA}, relaying on /relay, ` +
      `${HAS_TURN ? `TURN at ${TURN_URLS.join(' ')}${TURN_ONLY ? ' for every call' : ''}` : 'no TURN'}, ` +
      `${ANY_ORIGIN ? 'any page' : `pages from ${ORIGINS.join(' ')}`}`,
  )
})

/*
 * A container is stopped with SIGTERM, and node as the first process ignores
 * it, so docker waits ten seconds and kills it. Close on the signal instead:
 * every write lands with appendFile before it answers, so nothing is lost.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const standing of relayRooms.values()) for (const socket of standing) socket.destroy()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
