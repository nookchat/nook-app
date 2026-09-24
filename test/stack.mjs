/**
 * The whole thing, for the browser tests: Postgres, a Nook server on 8787,
 * and the page served by Vite with that server built in.
 *
 *   node test/stack.mjs           starts all three and waits
 *
 * The browser tests expect it to be running, the way they expected Vite
 * before. Tests that need a server of their own (a cluster, a server that
 * dies) still start one beside it.
 */

import { spawn } from 'node:child_process'
import { startServer } from './pg.mjs'

const server = await startServer(8787)
console.log(`server on ${server.url}, database ${server.database}`)

const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], {
  env: { ...process.env, VITE_CATHODE_SERVER: server.url },
  stdio: ['ignore', 'pipe', 'inherit'],
})
vite.stdout.on('data', (b) => {
  const text = String(b)
  if (/ready in|Local:/.test(text)) console.log('page on http://localhost:5173/')
  if (process.env.LOUD) process.stdout.write(text)
})

const stop = () => {
  vite.kill()
  server.child.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
