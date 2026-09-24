/**
 * The HTTP API, version 1, and the older paths it replaced.
 *
 *   GET  /api/v1/health                   what this is, and its cluster
 *   GET  /api/v1/ice                      TURN credentials
 *   GET  /api/v1/spaces/:room/events      sealed lines after a point
 *   POST /api/v1/spaces/:room/events      keep sealed lines
 *   POST /api/v1/spaces/:room/files       keep a sealed file, named by its hash
 *   GET  /api/v1/spaces/:room/files/:id   send one back
 *   WS   /api/v1/spaces/:room/socket      see sockets.mjs
 *   PUT  /api/v1/links/:id                leave a sealed device link, for ten minutes
 *   GET  /api/v1/links/:id                take it, once
 *   GET  /api/v1/people/:id               a sealed record of somebody's spaces
 *   PUT  /api/v1/people/:id               replace it
 *   GET  /api/v1/preview?url=             a link card
 *   GET  /api/v1/gifs?q=                  GIF search
 *   GET  /api/v1/openapi.json             all of the above, described
 *   GET  /api/v1/cluster/{lines,rooms,people,files}   between servers only
 *   WS   /api/v1/socket                 every space a device is in, on one connection
 */

import { HAS_TURN, MAX_FILE_BYTES, PREVIEWS, TURN_ONLY, VERSION, originAllowed } from './config.mjs'
import { clusterHealth, clusterUrls, fromPeer, linesFor, peopleFor, roomsFor } from './cluster.mjs'
import { FILE_ID, filesFor, keep, send } from './files.mjs'
import { ApiError, allow, fail, readJson, reply } from './http.mjs'
import { LINK_ID, MAX_LINK, putLink, takeLink } from './links.mjs'
import { openapi } from './openapi.mjs'
import { gifs, hasGifs, preview } from './preview.mjs'
import {
  append,
  MAX_LINE,
  MAX_PAGE_LINES,
  MAX_PERSON,
  mayWrite,
  person,
  PERSON,
  putPerson,
  ROOM,
  since,
} from './store.mjs'
import { iceServers } from './turn.mjs'

const int = (value, fallback = 0) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function roomOf(value) {
  if (!ROOM.test(value ?? '')) throw new ApiError(400, 'bad_room', 'That is not a space id.')
  return value
}

function personOf(value) {
  if (!PERSON.test(value ?? '')) throw new ApiError(400, 'bad_person', 'That is not a person id.')
  return value
}

function limited(req) {
  if (!allow(req)) throw new ApiError(429, 'slow_down', 'Too many requests. Try again in a moment.')
}

function health() {
  return {
    ok: true,
    // What a page checks for to know it has found a Cathode server.
    service: 'cathode-server',
    name: 'cathode',
    version: VERSION,
    api: 1,
    database: 'postgres',
    turn: HAS_TURN,
    relayOnly: HAS_TURN && TURN_ONLY,
    previews: PREVIEWS,
    gifs: hasGifs(),
    files: { max: MAX_FILE_BYTES },
    cluster: clusterUrls(),
    peers: clusterHealth().peers,
  }
}

async function readEvents(url, room) {
  const after = int(url.searchParams.get('after') ?? url.searchParams.get('from'))
  const page = await since(room, after, int(url.searchParams.get('limit')), MAX_PAGE_LINES)
  return { at: page.at, events: page.lines, more: page.more }
}

async function writeEvents(req, room) {
  limited(req)
  if (!(await mayWrite(room, req.headers['x-cathode-write']))) {
    throw new ApiError(403, 'wrong_token', 'That is not the write token this space was claimed with.')
  }
  const body = await readJson(req)
  const list = Array.isArray(body) ? body : body?.events
  if (!Array.isArray(list)) throw new ApiError(400, 'bad_body', 'Expected a list of sealed lines.')
  /*
   * Every line has to be a string of a sane size and nothing else is checked,
   * because nothing else can be: this cannot read them. The devices check
   * every signature on the way back in, which is the check that matters.
   */
  const clean = list.filter((e) => typeof e === 'string' && e.length > 0 && e.length <= MAX_LINE)
  const fresh = await append(room, clean)
  return { added: clean.length, fresh: fresh.length, at: fresh.length ? fresh[fresh.length - 1].seq : undefined }
}

async function writeFile(req, room) {
  limited(req)
  if (!(await mayWrite(room, req.headers['x-cathode-write']))) {
    throw new ApiError(403, 'wrong_token', 'That is not the write token this space was claimed with.')
  }
  return keep(room, req)
}

async function writePerson(req, id) {
  limited(req)
  const body = await readJson(req, MAX_PERSON + 1024)
  const blob = body?.blob
  if (typeof blob !== 'string' || blob.length > MAX_PERSON) {
    throw new ApiError(413, 'too_large', 'A record is a sealed string of at most 512 KiB.')
  }
  const token = req.headers['x-cathode-write']
  if (typeof token !== 'string' || !token) throw new ApiError(403, 'wrong_token', 'A record needs its write token.')
  if (!(await putPerson(id, token, blob))) {
    throw new ApiError(403, 'wrong_token', 'That is not the write token this record was claimed with.')
  }
  return { ok: true }
}

async function linkCard(url) {
  if (!PREVIEWS) throw new ApiError(404, 'off', 'Link cards are turned off on this server.')
  const wanted = url.searchParams.get('url') ?? ''
  if (!wanted || wanted.length > 2048) throw new ApiError(400, 'bad_url', 'That is not a link.')
  return preview(wanted)
}

async function gifSearch(url) {
  if (!hasGifs()) throw new ApiError(404, 'off', 'This server has no GIF key.')
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80)
  if (!q) throw new ApiError(400, 'bad_query', 'Say what to look for.')
  const found = await gifs(q)
  if (!found) throw new ApiError(502, 'upstream', 'Tenor did not answer.')
  return found
}

function peerOnly(req) {
  if (!fromPeer(req)) throw new ApiError(401, 'not_a_peer', 'Only a server in this cluster may ask that.')
  return String(req.headers['x-cathode-peer'] ?? '')
}

export async function handle(req, res) {
  try {
    if (req.method === 'OPTIONS') return reply(res, 204, '')
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    const method = req.method ?? 'GET'

    // Only the health check answers a page this server does not serve.
    const cross = req.headers.origin !== undefined && !originAllowed(req.headers.origin)
    const isHealth = url.pathname === '/api/v1/health'
    if (cross && !isHealth) throw new ApiError(403, 'origin', 'This server does not answer that page.')

    if (parts[0] === 'api' && parts[1] === 'v1') {
      const [, , a, b, c] = parts
      if (a === 'health' && method === 'GET') return reply(res, 200, health())
      if (a === 'openapi.json' && method === 'GET') return reply(res, 200, openapi)
      if (a === 'ice' && method === 'GET') return reply(res, 200, iceServers())
      if (a === 'spaces' && c === 'events') {
        const room = roomOf(b)
        if (method === 'GET') return reply(res, 200, await readEvents(url, room))
        if (method === 'POST') return reply(res, 200, await writeEvents(req, room))
      }
      if (a === 'spaces' && c === 'files') {
        const room = roomOf(b)
        const id = parts[5]
        if (method === 'POST' && !id) return reply(res, 200, await writeFile(req, room))
        if (method === 'GET' && id) {
          if (!FILE_ID.test(id)) throw new ApiError(400, 'bad_file', 'That is not a file id.')
          return await send(req, res, room, id)
        }
      }
      if (a === 'links' && b && !c) {
        if (!LINK_ID.test(b)) throw new ApiError(400, 'bad_link', 'That is not a link id.')
        limited(req)
        if (method === 'PUT') return reply(res, 200, putLink(b, (await readJson(req, MAX_LINK + 1024))?.blob))
        if (method === 'GET') return reply(res, 200, takeLink(b))
      }
      if (a === 'people' && b && !c) {
        const id = personOf(b)
        if (method === 'GET') return reply(res, 200, await person(id))
        if (method === 'PUT' || method === 'POST') return reply(res, 200, await writePerson(req, id))
      }
      if (a === 'preview' && method === 'GET') {
        limited(req)
        return reply(res, 200, await linkCard(url))
      }
      if (a === 'gifs' && method === 'GET') {
        limited(req)
        return reply(res, 200, await gifSearch(url))
      }
      if (a === 'cluster' && method === 'GET') {
        const asker = peerOnly(req)
        const after = int(url.searchParams.get('after'))
        if (b === 'lines') {
          return reply(res, 200, await linesFor(asker, after, int(url.searchParams.get('limit')), int(url.searchParams.get('wait'))))
        }
        if (b === 'rooms') return reply(res, 200, await roomsFor(after))
        if (b === 'people') return reply(res, 200, await peopleFor(after))
        if (b === 'files') return reply(res, 200, await filesFor(after))
      }
      throw new ApiError(404, 'not_found', 'There is nothing at that address.')
    }

    throw new ApiError(404, 'not_found', 'There is nothing at that address.')
  } catch (err) {
    return fail(res, err)
  }
}
