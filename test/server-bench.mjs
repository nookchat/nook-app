import { randomBytes } from 'node:crypto'
import { startServer } from './pg.mjs'

const LINES = Number(process.argv[2] ?? 50_000)
const PORT = 8795
const BASE = `http://localhost:${PORT}`
const ROOM = randomBytes(16).toString('hex')
const TOKEN = 'bench-token'

const { child: server } = await startServer(PORT)

const line = () => randomBytes(750).toString('base64url')
const post = (lines) =>
  fetch(`${BASE}/api/v1/spaces/${ROOM}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nook-write': TOKEN },
    body: JSON.stringify(lines),
  })

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
async function time(label, runs, work) {
  const took = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    await work()
    took.push(performance.now() - start)
  }
  console.log(`${label.padEnd(34)} ${median(took).toFixed(1).padStart(8)} ms`)
}

try {
  for (let i = 0; i < LINES; i += 2000) await post(Array.from({ length: Math.min(2000, LINES - i) }, line))
  console.log(`room holds ${LINES} lines, about ${((LINES * 1000) / 1e6).toFixed(0)} MB`)

  await time('catch up on the last 10 lines', 10, async () => {
    const res = await fetch(`${BASE}/api/v1/spaces/${ROOM}/events?after=${LINES - 10}`)
    await res.json()
  })
  await time('read everything, page by page', 3, async () => {
    let from = 0
    for (;;) {
      const res = await fetch(`${BASE}/api/v1/spaces/${ROOM}/events?after=${from}&limit=5000`, {
        headers: { 'accept-encoding': 'identity' },
      })
      const page = await res.json()
      from = page.at
      if (!page.more) break
    }
  })
  await time('append one message', 20, async () => {
    await (await post([line()])).json()
  })

  // Each socket says hello from past the end, so neither is sent the history first.
  const a = new WebSocket(`ws://localhost:${PORT}/api/v1/socket`)
  const b = new WebSocket(`ws://localhost:${PORT}/api/v1/socket`)
  await Promise.all([a, b].map((ws) => new Promise((ok) => (ws.onopen = ok))))
  const live = (ws) =>
    new Promise((ok) => {
      ws.onmessage = (ev) => JSON.parse(ev.data).t === 'live' && ok()
      ws.send(JSON.stringify({ t: 'hello', room: ROOM, from: Number.MAX_SAFE_INTEGER }))
    })
  await Promise.all([live(a), live(b)])
  const frame = line()
  await time('a signal between two sockets', 200, () => new Promise((ok) => {
    b.onmessage = (ev) => JSON.parse(ev.data).t === 'sig' && ok()
    a.send(JSON.stringify({ t: 'sig', room: ROOM, d: frame }))
  }))
  a.close()
  b.close()
} finally {
  server.kill()
}
