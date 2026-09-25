import { spawn } from 'node:child_process'
import { startServer } from './pg.mjs'

const server = await startServer(8787)
console.log(`server on ${server.url}, database ${server.database}`)

const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], {
  env: { ...process.env, VITE_NOOK_SERVER: server.url },
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
