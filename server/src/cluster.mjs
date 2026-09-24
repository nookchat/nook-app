/**
 * The cluster: several servers keeping every space between them.
 *
 * Each server pulls from every other, all the time, over plain HTTPS:
 *
 *   rooms    which spaces exist, and the hash of each one's write token
 *   lines    every sealed line, after the last one it read from that server
 *   people   every sealed record of whose spaces are whose
 *   files    every sealed file, fetched from whichever server has it
 *
 * Lines are pulled by long polling: a request waits on the other server until
 * something new arrives, so a line written on one server reaches the rest in
 * about the time it takes to cross the network. A line two servers both hold
 * is the same line and is kept once, so it does not matter how many ways it
 * arrives. A server that was down asks for everything after where it stopped
 * when it comes back, and catches up.
 *
 * What the servers trust each other with is ciphertext. Every line is sealed
 * on the device that wrote it with a key made from the space code, which no
 * server holds, and every event inside is signed and checked by the devices
 * on the way back in. A server in the cluster can refuse, forget or flood;
 * it cannot read and it cannot forge.
 *
 * Requests between servers carry CATHODE_CLUSTER_SECRET, which every server
 * in the cluster shares, and name the asker, so a line is not sent back to
 * the server it came from.
 */

import { timingSafeEqual } from 'node:crypto'
import { CLUSTER_SECRET, CLUSTERED, PEERS, PUBLIC_URL } from './config.mjs'
import { pool } from './db.mjs'
import { pullFiles } from './files.mjs'
import { append, kept, takeClaim, takePerson } from './store.mjs'

/** Lines one pull may take. */
const PULL_LINES = 500
/** How long a pull may wait on the other server for something new. */
const WAIT_S = 20
/** How often rooms and people are pulled, beside the lines. */
const SIDE_MS = 2000

/** What each peer is doing, for the health check. */
const state = new Map(PEERS.map((peer) => [peer, { up: false, seen: 0, error: '' }]))

export function clusterHealth() {
  return {
    self: PUBLIC_URL,
    peers: [...state].map(([peer, s]) => ({ url: peer, up: s.up, seen: s.seen || null })),
  }
}

/** Every server a page may use for a space here: this one first. */
export function clusterUrls() {
  return [PUBLIC_URL, ...PEERS].filter(Boolean)
}

/** True when a request carries the cluster's secret. */
export function fromPeer(req) {
  if (!CLUSTERED) return false
  const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
  const held = Buffer.from(CLUSTER_SECRET)
  return given.length === held.length && timingSafeEqual(given, held)
}

// ---- what this server hands the others ----

/** Lines after a number, not from the asker. Waits a while for some when there are none. */
export async function linesFor(asker, after, limit, wait) {
  const take = Math.max(1, Math.min(limit || PULL_LINES, PULL_LINES))
  /*
   * The newest number is read before the lines, so it can only be lower than
   * anything the read saw. Lines are kept one at a time, so every line at or
   * below it was already there to be read, and a page that ends short of it
   * ended there only because what came after was the asker's own.
   */
  const read = async () => {
    const { rows: top } = await pool.query('select coalesce(max(seq), 0) as at from lines')
    // Each line with its space's claim, so a follower never holds a space
    // without the token that owns it, not even for a moment.
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

// ---- what this server takes from the others ----

async function ask(peer, path, signal) {
  const res = await fetch(`${peer}${path}`, {
    headers: { authorization: `Bearer ${CLUSTER_SECRET}`, 'x-cathode-peer': PUBLIC_URL },
    signal,
  })
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

async function pullRooms(peer, at) {
  let after = at.rooms_after
  for (;;) {
    const page = await ask(peer, `/api/v1/cluster/rooms?after=${after}`, AbortSignal.timeout(15_000))
    for (const r of page.rooms) await takeClaim(r.room, Buffer.from(r.token_hash, 'hex'))
    if (page.at === after) break
    after = page.at
    await remember(peer, 'rooms_after', after)
  }
  at.rooms_after = after
}

async function pullPeople(peer, at) {
  let after = at.people_after
  for (;;) {
    const page = await ask(peer, `/api/v1/cluster/people?after=${after}`, AbortSignal.timeout(15_000))
    for (const p of page.people) await takePerson(p.id, Buffer.from(p.token_hash, 'hex'), p.blob, p.updated)
    if (page.at === after) break
    after = page.at
    await remember(peer, 'people_after', after)
  }
  at.people_after = after
}

async function pullLines(peer, at) {
  const page = await ask(
    peer,
    `/api/v1/cluster/lines?after=${at.lines_after}&limit=${PULL_LINES}&wait=${WAIT_S}`,
    AbortSignal.timeout((WAIT_S + 15) * 1000),
  )
  // In order, a space at a time, keeping the order each space's lines came in.
  const byRoom = new Map()
  const claims = new Map()
  for (const row of page.lines) {
    const list = byRoom.get(row.room) ?? []
    list.push(row.body)
    byRoom.set(row.room, list)
    if (row.token_hash) claims.set(row.room, row.token_hash)
  }
  // The claim first: a space is never here without the token that owns it.
  for (const [room, hash] of claims) await takeClaim(room, Buffer.from(hash, 'hex'))
  for (const [room, bodies] of byRoom) await append(room, bodies, peer)
  if (page.at !== at.lines_after) {
    at.lines_after = page.at
    await remember(peer, 'lines_after', page.at)
  }
  return page.more
}

/** Lines, as fast as they come: a long poll, over and over. */
async function followLines(peer) {
  const s = state.get(peer)
  let wait = 1000
  for (;;) {
    try {
      await pullLines(peer, await cursor(peer))
      if (!s.up) console.log(`[cathode] cluster: ${peer} is up`)
      s.up = true
      s.seen = Date.now()
      s.error = ''
      wait = 1000
    } catch (err) {
      if (s.up) console.log(`[cathode] cluster: ${peer} is down (${err.message})`)
      s.up = false
      s.error = String(err.message ?? err)
      await new Promise((r) => setTimeout(r, wait))
      wait = Math.min(wait * 2, 30_000)
    }
  }
}

/** Claims and records, every couple of seconds, beside the lines. */
async function followSide(peer) {
  for (;;) {
    try {
      const at = await cursor(peer)
      await pullRooms(peer, at)
      await pullPeople(peer, at)
      // After the rooms, so a file never arrives for a space this server has not heard of.
      at.files_after = await pullFiles(peer, at.files_after, (after) => remember(peer, 'files_after', after))
    } catch {
      // The lines loop says whether the peer is up; this just tries again.
    }
    await new Promise((r) => setTimeout(r, SIDE_MS))
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
  }
}
