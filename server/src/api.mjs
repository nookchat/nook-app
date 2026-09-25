import { clusterUrls, fromPeer, linesFor, peerHealth, peopleFor, roomsFor } from './cluster.mjs'
import { HAS_TURN, MAX_FILE_BYTES, PREVIEWS, TURN_ONLY, VERSION, originAllowed } from './config.mjs'
import { FILE_ID, filesFor, keep, send } from './files.mjs'
import { gifService, gifs, hasGifs } from './gifs.mjs'
import { ApiError, allow, fail, readJson, reply } from './http.mjs'
import { LINK_ID, MAX_LINK, putLink, takeLink } from './links.mjs'
import { liveFor } from './live.mjs'
import { openapi } from './openapi.mjs'
import { preview } from './preview.mjs'
import { localStates } from './sockets.mjs'
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

const int = (value) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 0 ? n : 0
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
    // Pages check this to know they found a Nook server.
    service: 'cathode-server',
    name: 'cathode',
    version: VERSION,
    api: 1,
    database: 'postgres',
    turn: HAS_TURN,
    relayOnly: HAS_TURN && TURN_ONLY,
    previews: PREVIEWS,
    gifs: hasGifs(),
    gifService: gifService(),
    files: { max: MAX_FILE_BYTES },
    cluster: clusterUrls(),
    peers: peerHealth(),
  }
}

async function readEvents(url, room) {
  const after = int(url.searchParams.get('after') ?? url.searchParams.get('from'))
  const page = await since(room, after, int(url.searchParams.get('limit')), MAX_PAGE_LINES)
  return { at: page.at, events: page.lines, more: page.more }
}

async function mustWrite(req, room) {
  limited(req)
  if (!(await mayWrite(room, req.headers['x-cathode-write']))) {
    throw new ApiError(403, 'wrong_token', 'That is not the write token this space was claimed with.')
  }
}

async function writeEvents(req, room) {
  await mustWrite(req, room)
  const body = await readJson(req)
  const list = Array.isArray(body) ? body : body?.events
  if (!Array.isArray(list)) throw new ApiError(400, 'bad_body', 'Expected a list of sealed lines.')
  const clean = list.filter((e) => typeof e === 'string' && e.length > 0 && e.length <= MAX_LINE)
  const fresh = await append(room, clean)
  return { added: clean.length, fresh: fresh.length, at: fresh.length ? fresh[fresh.length - 1].seq : undefined }
}

async function writeFile(req, room) {
  await mustWrite(req, room)
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
  const found = await gifs(url.searchParams.get('q') ?? '')
  if (!found) throw new ApiError(502, 'upstream', `${gifService()} did not answer.`)
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
        if (b === 'live') {
          const wait = Math.min(25, int(url.searchParams.get('wait')))
          return reply(res, 200, await liveFor(after, String(url.searchParams.get('boot') ?? ''), wait, localStates))
        }
      }
    }
    throw new ApiError(404, 'not_found', 'There is nothing at that address.')
  } catch (err) {
    return fail(res, err)
  }
}
