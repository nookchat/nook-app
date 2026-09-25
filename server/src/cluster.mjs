import { timingSafeEqual } from 'node:crypto'
import { CLUSTER_SECRET, CLUSTERED, PEER_HEADERS, PEERS, PUBLIC_URL } from './config.mjs'
import { pool } from './db.mjs'
import { pullFiles } from './files.mjs'
import { fromPeerLive, peerGone } from './sockets.mjs'
import { append, kept, takeClaim, takePerson } from './store.mjs'

const PULL_LINES = 500
const WAIT_S = 20
const SIDE_MS = 2000

const peerState = new Map(PEERS.map((peer) => [peer, { up: false, seen: 0 }]))

export function peerHealth() {
  return [...peerState].map(([peer, s]) => ({ url: peer, up: s.up, seen: s.seen || null }))
}

export function clusterUrls() {
  return [PUBLIC_URL, ...PEERS].filter(Boolean)
}

export function fromPeer(req) {
  if (!CLUSTERED) return false
  const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
  const held = Buffer.from(CLUSTER_SECRET)
  return given.length === held.length && timingSafeEqual(given, held)
}

export async function linesFor(asker, after, limit, wait) {
  const take = Math.max(1, Math.min(limit || PULL_LINES, PULL_LINES))
  // The top is read first, so every line at or below it is visible to the read after.
  const read = async () => {
    const { rows: top } = await pool.query('select coalesce(max(seq), 0) as at from lines')
    // Each line carries its space's claim, so a follower never holds a space without its token.
    const { rows } = await pool.query(
      `select l.seq, l.room, l.body, encode(r.token_hash, 'hex') as token_hash
       from lines l join rooms r on r.room = l.room
       where l.seq > $1 and l.origin <> $2 order by l.seq limit $3`,
      [after, asker, take + 1],
    )
    return { rows, top: top[0].at }
  }
  let { rows, top } = await read()
  if (rows.length === 0 && wait > 0 && top <= after) {
    await new Promise((done) => {
      const timer = setTimeout(finish, Math.min(wait, 25) * 1000)
      function finish() {
        clearTimeout(timer)
        kept.off('lines', finish)
        done()
      }
      kept.on('lines', finish)
    })
    ;({ rows, top } = await read())
  }
  const more = rows.length > take
  const page = more ? rows.slice(0, take) : rows
  const last = page.length ? page[page.length - 1].seq : after
  return { lines: page, at: more ? last : Math.max(last, top, after), more }
}

export async function roomsFor(after) {
  const { rows } = await pool.query(
    `select room, encode(token_hash, 'hex') as token_hash, change from rooms
     where change > $1 and token_hash is not null order by change limit 2000`,
    [after],
  )
  return { rooms: rows, at: rows.length ? rows[rows.length - 1].change : after }
}

export async function peopleFor(after) {
  const { rows } = await pool.query(
    `select id, encode(token_hash, 'hex') as token_hash, blob, updated, change from people
     where change > $1 order by change limit 500`,
    [after],
  )
  return { people: rows, at: rows.length ? rows[rows.length - 1].change : after }
}

async function ask(peer, path, signal) {
  const res = await fetch(`${peer}${path}`, { headers: PEER_HEADERS, signal })
  if (!res.ok) throw new Error(`${peer} said ${res.status}`)
  return res.json()
}

async function cursor(peer) {
  await pool.query('insert into peers (peer) values ($1) on conflict do nothing', [peer])
  const { rows } = await pool.query(
    'select lines_after, rooms_after, people_after, files_after from peers where peer = $1',
    [peer],
  )
  return rows[0]
}

async function remember(peer, field, value) {
  await pool.query(`update peers set ${field} = $2, seen = now() where peer = $1`, [peer, value])
}

async function pullChanges(peer, at, kind, field, take) {
  let after = at[field]
  for (;;) {
    const page = await ask(peer, `/api/v1/cluster/${kind}?after=${after}`, AbortSignal.timeout(15_000))
    for (const row of page[kind]) await take(row)
    if (page.at === after) break
    after = page.at
    await remember(peer, field, after)
  }
  at[field] = after
}

const pullRooms = (peer, at) =>
  pullChanges(peer, at, 'rooms', 'rooms_after', (r) => takeClaim(r.room, Buffer.from(r.token_hash, 'hex')))

const pullPeople = (peer, at) =>
  pullChanges(peer, at, 'people', 'people_after', (p) =>
    takePerson(p.id, Buffer.from(p.token_hash, 'hex'), p.blob, p.updated),
  )

async function pullLines(peer, at) {
  const page = await ask(
    peer,
    `/api/v1/cluster/lines?after=${at.lines_after}&limit=${PULL_LINES}&wait=${WAIT_S}`,
    AbortSignal.timeout((WAIT_S + 15) * 1000),
  )
  const byRoom = new Map()
  const claims = new Map()
  for (const row of page.lines) {
    const list = byRoom.get(row.room)
    if (list) list.push(row.body)
    else byRoom.set(row.room, [row.body])
    if (row.token_hash) claims.set(row.room, row.token_hash)
  }
  // Claims first: a space is never here without the token that owns it.
  for (const [room, hash] of claims) await takeClaim(room, Buffer.from(hash, 'hex'))
  for (const [room, bodies] of byRoom) await append(room, bodies, peer)
  if (page.at !== at.lines_after) {
    at.lines_after = page.at
    await remember(peer, 'lines_after', page.at)
  }
}

async function followLines(peer) {
  const s = peerState.get(peer)
  let wait = 1000
  for (;;) {
    try {
      await pullLines(peer, await cursor(peer))
      if (!s.up) console.log(`[cathode] cluster: ${peer} is up`)
      s.up = true
      s.seen = Date.now()
      wait = 1000
    } catch (err) {
      if (s.up) console.log(`[cathode] cluster: ${peer} is down (${err.message})`)
      s.up = false
      await new Promise((r) => setTimeout(r, wait))
      wait = Math.min(wait * 2, 30_000)
    }
  }
}

async function followSide(peer) {
  for (;;) {
    try {
      const at = await cursor(peer)
      await pullRooms(peer, at)
      await pullPeople(peer, at)
      // After the rooms, so a file never arrives for a space this server has not heard of.
      at.files_after = await pullFiles(peer, at.files_after, (after) => remember(peer, 'files_after', after))
    } catch {
      /* followLines tracks whether the peer is up */
    }
    await new Promise((r) => setTimeout(r, SIDE_MS))
  }
}

async function followLive(peer) {
  let after = 0
  let boot = ''
  let wait = 1000
  let connected = false
  for (;;) {
    try {
      const page = await ask(
        peer,
        `/api/v1/cluster/live?after=${after}&boot=${boot}&wait=${WAIT_S}`,
        AbortSignal.timeout((WAIT_S + 15) * 1000),
      )
      // A reset is a snapshot that replaces everything held from that peer.
      if (page.reset) peerGone(peer)
      for (const event of page.events ?? []) fromPeerLive(peer, event)
      after = page.at
      boot = page.boot
      connected = true
      wait = 1000
    } catch {
      if (connected) peerGone(peer)
      connected = false
      after = 0
      boot = ''
      await new Promise((r) => setTimeout(r, wait))
      wait = Math.min(wait * 2, 15_000)
    }
  }
}

export function startCluster() {
  if (!CLUSTERED) {
    if (PEERS.length) console.log('[cathode] cluster: CATHODE_CLUSTER_SECRET must be at least 16 characters; not syncing')
    return
  }
  if (!PUBLIC_URL) console.log('[cathode] cluster: set CATHODE_PUBLIC_URL so the others know which server is asking')
  console.log(`[cathode] cluster: following ${PEERS.join(', ')}`)
  for (const peer of PEERS) {
    void followLines(peer)
    void followSide(peer)
    void followLive(peer)
  }
}
