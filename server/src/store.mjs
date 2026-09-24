/**
 * The spaces, kept: every rule about what goes in and what comes out.
 *
 * A space is an ordered list of sealed lines. This server cannot read one,
 * so it checks the only things it can: that a writer holds the space's write
 * token, that a line is a string of a sane size, and that the same line is
 * not kept twice. Everything that matters, the signature on every event
 * inside, is checked by the devices on the way back in.
 *
 * Order is this server's own. Every line gets the next number in one
 * sequence, and a reader asks for "everything after number N". Two servers in
 * a cluster number the same lines differently, which is fine: a reader's
 * place is kept per server, and a line both have is the same line.
 *
 * Writes happen one at a time, so the numbers are handed out in the order
 * the lines are kept, and a reader who has seen number N has seen everything
 * below it.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { MAX_ROOM_BYTES } from './config.mjs'
import { pool } from './db.mjs'

export const ROOM = /^[0-9a-f]{32}$/
export const PERSON = /^[0-9a-f]{64}$/

/**
 * One line of ciphertext. The client caps an event so a full-size message
 * seals to under 64 KiB (MAX_BODY in store/log.ts); this sits at double that.
 */
export const MAX_LINE = 128 * 1024
/** The most one person's record may weigh. */
export const MAX_PERSON = 512 * 1024
/** A page of history: this many lines, or this many bytes, whichever first. */
export const PAGE_LINES = 1000
export const PAGE_BYTES = 4 * 1024 * 1024
/** The most a reader over HTTP may ask for in one page, where frames do not matter. */
export const MAX_PAGE_LINES = 5000

/** Told about every line kept, from a device or from another server. */
export const kept = new EventEmitter()
kept.setMaxListeners(0)

const sha256 = (text) => createHash('sha256').update(text).digest()

/** One piece of work per space at a time. */
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

/** The claimed hash per space, once read, so a write does not ask the database. */
const claims = new Map()

/**
 * May this token write to this space?
 *
 * The first write claims the space with its token, and every write after has
 * to carry the same one. What is kept is the hash of the token, so the
 * database is not the credential. A space that arrived from another server
 * before its claim did takes the first claim offered; the claim itself
 * arrives from that server a moment later and is the same one.
 */
export async function mayWrite(room, token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) return false
  const hash = sha256(token)
  let held = claims.get(room)
  if (!held) {
    const { rows } = await pool.query(
      `insert into rooms (room, token_hash) values ($1, $2)
       on conflict (room) do update set token_hash = coalesce(rooms.token_hash, excluded.token_hash)
       returning token_hash`,
      [room, hash],
    )
    held = rows[0].token_hash
    claims.set(room, held)
  }
  return held.length === hash.length && timingSafeEqual(held, hash)
}

/**
 * Keep lines, and say which were new.
 *
 * `origin` is the server they came from, or empty for a device. A line this
 * space already holds is dropped: a device that resends after a lost
 * acknowledgement, and a line that reaches this server from two others, both
 * cost nothing. Returns the new lines with their numbers, in order.
 */
export function append(room, lines, origin = '', writer = null) {
  return exclusive(room, async () => {
    if (lines.length === 0) return []
    const hashes = lines.map((l) => sha256(l))
    const client = await pool.connect()
    let fresh
    try {
      await client.query('begin')
      /*
       * One write at a time, across every space and every process on this
       * database, so a line's number is also the order it was kept in. A
       * reader that has seen number N, a device or another server, has then
       * seen every line below N, and "everything after N" misses nothing.
       */
      await client.query('select pg_advisory_xact_lock(7418)')
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
      const added = fresh.reduce((sum, r) => sum + Buffer.byteLength(r.body), 0)
      const { rows: size } = await client.query(
        'update rooms set bytes = bytes + $2 where room = $1 returning bytes',
        [room, added],
      )
      if (size[0].bytes > MAX_ROOM_BYTES) await trim(client, room)
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

/** Drop the oldest half of a space that has grown past its cap. Inside a transaction. */
async function trim(client, room) {
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

/**
 * The lines of a space after number `after`, one page of them.
 * `at` is where the page ends, which is where the next one starts.
 */
export async function since(room, after, limit = PAGE_LINES, most = PAGE_LINES) {
  const take = Math.max(1, Math.min(limit || PAGE_LINES, most))
  const { rows } = await pool.query(
    'select seq, body from lines where room = $1 and seq > $2 order by seq limit $3',
    [room, after, take + 1],
  )
  let more = rows.length > take
  const page = more ? rows.slice(0, take) : rows
  // Never more than a page of bytes, but always at least one line.
  let bytes = 0
  let cut = page.length
  for (let i = 0; i < page.length; i++) {
    bytes += page[i].body.length
    if (bytes > PAGE_BYTES && i > 0) {
      cut = i
      more = true
      break
    }
  }
  const out = page.slice(0, cut)
  return { at: out.length ? out[out.length - 1].seq : after, lines: out.map((r) => r.body), more }
}

/** The number of the newest line in a space, or 0. */
export async function newest(room) {
  const { rows } = await pool.query('select coalesce(max(seq), 0) as at from lines where room = $1', [room])
  return rows[0].at
}

// ---- people ----

export async function person(id) {
  const { rows } = await pool.query('select blob, updated from people where id = $1', [id])
  return rows[0] ? { blob: rows[0].blob, updated: rows[0].updated } : { blob: null, updated: 0 }
}

/**
 * Replace a person's record, if the token is theirs.
 *
 * The first write claims the record. A later record wins over an earlier one
 * by the time it was written, which is what lets two servers that each took
 * a write agree on one of them. The devices merge before they write, so the
 * one that loses was already folded into the one that wins, bar a race.
 */
export function putPerson(id, token, blob, updated = Date.now()) {
  return exclusive(`person:${id}`, async () => {
    const hash = sha256(token)
    const { rows } = await pool.query('select token_hash, updated from people where id = $1', [id])
    if (rows[0]) {
      const held = rows[0].token_hash
      if (held.length !== hash.length || !timingSafeEqual(held, hash)) return false
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

/** A record from another server, which already checked the token. */
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

/** A claim from another server. The first claim a space gets is the one it keeps. */
export async function takeClaim(room, tokenHash) {
  await pool.query(
    `insert into rooms (room, token_hash) values ($1, $2)
     on conflict (room) do update set token_hash = coalesce(rooms.token_hash, excluded.token_hash)`,
    [room, tokenHash],
  )
  claims.delete(room)
}
