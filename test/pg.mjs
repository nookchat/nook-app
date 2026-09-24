/**
 * A Postgres for the tests: one container, a fresh database per run.
 *
 * Uses CATHODE_TEST_PG when it is set (a postgres:// URL to a server the tests
 * may create databases on), and otherwise starts a postgres:17-alpine
 * container called cathode-test-db on port 55432, or reuses it.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const CONTAINER = 'cathode-test-db'
const BASE = process.env.CATHODE_TEST_PG ?? 'postgres://cathode:cathode@localhost:55432'

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function running() {
  try {
    return docker('inspect', '-f', '{{.State.Running}}', CONTAINER) === 'true'
  } catch {
    return false
  }
}

async function ensure() {
  if (process.env.CATHODE_TEST_PG) return
  if (!running()) {
    try {
      docker('rm', '-f', CONTAINER)
    } catch {
      /* nothing to remove */
    }
    docker(
      'run', '-d', '--name', CONTAINER,
      '-e', 'POSTGRES_USER=cathode', '-e', 'POSTGRES_PASSWORD=cathode', '-e', 'POSTGRES_DB=cathode',
      '-p', '55432:5432', 'postgres:17-alpine',
    )
  }
  for (let i = 0; i < 60; i++) {
    try {
      // Over TCP: the socket inside the container answers during first-start setup, before the restart.
      docker('exec', CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-U', 'cathode')
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error('Postgres did not start')
}

/** A new, empty database, and its URL. */
export async function freshDatabase(label = 'test') {
  await ensure()
  const name = `${label}_${randomBytes(4).toString('hex')}`
  const { default: pg } = await import('../server/node_modules/pg/lib/index.js')
  const admin = new pg.Client({ connectionString: `${BASE}/cathode` })
  await admin.connect()
  await admin.query(`create database ${name}`)
  await admin.end()
  return `${BASE}/${name}`
}

/** Start a server on a port, with its own database, and wait until it answers. */
export async function startServer(port, env = {}) {
  const { spawn } = await import('node:child_process')
  const database = env.DATABASE_URL ?? (await freshDatabase(`p${port}`))
  const child = spawn(process.execPath, ['server/server.mjs'], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: database, CATHODE_DATA: '/nonexistent', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (b) => process.env.LOUD && console.log(`  [${port}]`, String(b).trim()))
  child.stderr.on('data', (b) => console.log(`  [${port} error]`, String(b).trim()))
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/api/v1/health`)
      if (res.ok) return { child, database, url: `http://localhost:${port}` }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  child.kill()
  throw new Error(`the server on ${port} did not start`)
}

/** One query against a test database, for a test that looks at what a server kept. */
export async function sql(database, text, params = []) {
  const { default: pg } = await import('../server/node_modules/pg/lib/index.js')
  const client = new pg.Client({ connectionString: database })
  await client.connect()
  try {
    return (await client.query(text, params)).rows
  } finally {
    await client.end()
  }
}
