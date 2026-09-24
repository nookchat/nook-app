/**
 * The database: Postgres, and the schema it holds.
 *
 * What is in it is ciphertext and the bookkeeping around it. A line of a
 * space is sealed on the device that wrote it with a key this server never
 * sees, so a stolen database is a pile of noise with timestamps on it.
 *
 *   rooms     one row per space: the hash of its write token, and its size
 *   lines     every sealed event, in the order this server received them
 *   people    one sealed record per person: their list of spaces
 *   peers     how far this server has read from each other server
 *
 * Migrations run on start, in order, each once, each in a transaction.
 */

import pg from 'pg'
import { DATABASE_URL } from './config.mjs'

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 12 })

// Postgres bigints arrive as strings; every one here fits a double.
pg.types.setTypeParser(20, (value) => Number(value))

const MIGRATIONS = [
  `
  create table rooms (
    room        text primary key,
    token_hash  bytea,
    bytes       bigint not null default 0,
    created_at  timestamptz not null default now()
  );
  create sequence rooms_change_seq;
  alter table rooms add column change bigint not null default nextval('rooms_change_seq');

  create table lines (
    seq     bigserial primary key,
    room    text not null references rooms (room) on delete cascade,
    hash    bytea not null,
    body    text not null,
    origin  text not null default '',
    at      timestamptz not null default now(),
    unique (room, hash)
  );
  create index lines_room_seq on lines (room, seq);

  create sequence people_change_seq;
  create table people (
    id          text primary key,
    token_hash  bytea not null,
    blob        text,
    updated     bigint not null default 0,
    change      bigint not null default nextval('people_change_seq')
  );
  create index people_change on people (change);

  create table peers (
    peer          text primary key,
    lines_after   bigint not null default 0,
    rooms_after   bigint not null default 0,
    people_after  bigint not null default 0,
    seen          timestamptz
  );
  `,
]

/** Bring the schema up to date. Safe to run on every start, from one process. */
export async function migrate() {
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock(7417)')
    await client.query(
      'create table if not exists schema_version (version int primary key, applied_at timestamptz not null default now())',
    )
    const { rows } = await client.query('select coalesce(max(version), 0) as v from schema_version')
    for (let v = rows[0].v; v < MIGRATIONS.length; v++) {
      await client.query('begin')
      try {
        await client.query(MIGRATIONS[v])
        await client.query('insert into schema_version (version) values ($1)', [v + 1])
        await client.query('commit')
        console.log(`[cathode] database schema at version ${v + 1}`)
      } catch (err) {
        await client.query('rollback')
        throw err
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(7417)').catch(() => undefined)
    client.release()
  }
}

/** Wait for the database, for a container that starts before it is ready. */
export async function ready(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await pool.query('select 1')
      return
    } catch (err) {
      if (i === tries - 1) throw err
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}
