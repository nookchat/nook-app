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
import { lookup } from 'node:dns/promises'
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

  if (parts[0] === 'health') return send(res, 200, { ok: true, service: 'cathode-archive' })

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
