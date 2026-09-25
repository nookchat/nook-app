import { createHash, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { MAX_ROOM_BYTES } from './config.mjs'
import { pool } from './db.mjs'

export const ROOM = /^[0-9a-f]{32}$/
export const PERSON = /^[0-9a-f]{64}$/

// Double the client's sealed event cap (MAX_BODY in src/store/log.ts).
export const MAX_LINE = 128 * 1024
export const MAX_PERSON = 512 * 1024
const PAGE_LINES = 1000
const PAGE_BYTES = 4 * 1024 * 1024
export const MAX_PAGE_LINES = 5000

const WRITE_LOCK = 7418

export const kept = new EventEmitter()
kept.setMaxListeners(0)

const sha256 = (text) => createHash('sha256').update(text).digest()

const queues = new Map()

function exclusive(key, work) {
  const before = queues.get(key) ?? Promise.resolve()
  const run = before.then(work, work)
  const settled = run.catch(() => undefined)
  queues.set(key, settled)
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return run
}

const claimedHashes = new Map()

const sameHash = (a, b) => a.length === b.length && timingSafeEqual(a, b)

export async function mayWrite(room, token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) return false
  const hash = sha256(token)
  let held = claimedHashes.get(room)
  if (!held) {
    const { rows } = await pool.query(
      `insert into rooms (room, token_hash) values ($1, $2)
       on conflict (room) do update set token_hash = coalesce(rooms.token_hash, excluded.token_hash)
       returning token_hash`,
      [room, hash],
    )
    held = rows[0].token_hash
    claimedHashes.set(room, held)
  }
  return sameHash(held, hash)
}

export function append(room, lines, origin = '', writer = null) {
  return exclusive(room, async () => {
    if (lines.length === 0) return []
    const hashes = lines.map(sha256)
    const client = await pool.connect()
    let fresh
    try {
      await client.query('begin')
      // One writer across every room and process, so seq order is commit order.
      await client.query(`select pg_advisory_xact_lock(${WRITE_LOCK})`)
      await client.query('insert into rooms (room) values ($1) on conflict do nothing', [room])
      const { rows } = await client.query(
        `insert into lines (room, hash, body, origin)
         select $1, h, b, $4 from unnest($2::bytea[], $3::text[]) with ordinality as t (h, b, n)
         order by n
         on conflict (room, hash) do nothing
         returning seq, body`,
        [room, hashes, lines, origin],
      )
      fresh = rows.sort((a, b) => a.seq - b.seq)
      let added = 0
      for (const row of fresh) added += Buffer.byteLength(row.body)
      const { rows: size } = await client.query(
        'update rooms set bytes = bytes + $2 where room = $1 returning bytes',
        [room, added],
      )
      if (size[0].bytes > MAX_ROOM_BYTES) await trimOldestHalf(client, room)
      await client.query('commit')
    } catch (err) {
      await client.query('rollback').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
    if (fresh.length) kept.emit('lines', room, fresh, writer)
    return fresh
  })
}

async function trimOldestHalf(client, room) {
  const { rows } = await client.query(
    `select seq from lines where room = $1 order by seq
     offset (select count(*) / 2 from lines where room = $1) limit 1`,
    [room],
  )
  if (!rows.length) return
  await client.query('delete from lines where room = $1 and seq < $2', [room, rows[0].seq])
  await client.query(
    `update rooms set bytes = (select coalesce(sum(octet_length(body)), 0) from lines where room = $1)
     where room = $1`,
    [room],
  )
  console.log(`[cathode] trimmed ${room}: the oldest half went`)
}

export async function since(room, after, limit = PAGE_LINES, most = PAGE_LINES) {
  const take = Math.max(1, Math.min(limit || PAGE_LINES, most))
  const { rows } = await pool.query(
    'select seq, body from lines where room = $1 and seq > $2 order by seq limit $3',
    [room, after, take + 1],
  )
  let more = rows.length > take
  const count = more ? take : rows.length
  const lines = []
  let at = after
  let bytes = 0
  for (let i = 0; i < count; i++) {
    const { seq, body } = rows[i]
    bytes += body.length
    if (bytes > PAGE_BYTES && i > 0) {
      more = true
      break
    }
    lines.push(body)
    at = seq
  }
  return { at, lines, more }
}

export async function newest(room) {
  const { rows } = await pool.query('select coalesce(max(seq), 0) as at from lines where room = $1', [room])
  return rows[0].at
}

export async function person(id) {
  const { rows } = await pool.query('select blob, updated from people where id = $1', [id])
  return rows[0] ? { blob: rows[0].blob, updated: rows[0].updated } : { blob: null, updated: 0 }
}

// The newest `updated` wins, so two servers that each took a write agree on one.
export function putPerson(id, token, blob) {
  const updated = Date.now()
  return exclusive(`person:${id}`, async () => {
    const hash = sha256(token)
    const { rows } = await pool.query('select token_hash, updated from people where id = $1', [id])
    if (rows[0]) {
      if (!sameHash(rows[0].token_hash, hash)) return false
      if (updated <= rows[0].updated) return true
      await pool.query(
        `update people set blob = $2, updated = $3, change = nextval('people_change_seq') where id = $1`,
        [id, blob, updated],
      )
      return true
    }
    await pool.query(
      'insert into people (id, token_hash, blob, updated) values ($1, $2, $3, $4) on conflict do nothing',
      [id, hash, blob, updated],
    )
    return true
  })
}

export function takePerson(id, tokenHash, blob, updated) {
  return exclusive(`person:${id}`, async () => {
    await pool.query(
      `insert into people (id, token_hash, blob, updated) values ($1, $2, $3, $4)
       on conflict (id) do update set blob = excluded.blob, updated = excluded.updated,
         change = nextval('people_change_seq')
       where people.updated < excluded.updated and people.token_hash = excluded.token_hash`,
      [id, tokenHash, blob, updated],
    )
  })
}

export async function takeClaim(room, tokenHash) {
  await pool.query(
    `insert into rooms (room, token_hash) values ($1, $2)
     on conflict (room) do update set token_hash = coalesce(rooms.token_hash, excluded.token_hash)`,
    [room, tokenHash],
  )
  claimedHashes.delete(room)
}
