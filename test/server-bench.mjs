/**
 * How fast the server answers, with a big room in it.
 *
 * Fills one room with LINES lines of ciphertext-sized junk, then times what a
 * client does: catching up on the last few lines, reading the whole history,
 * appending a batch, and a message crossing the relay between two sockets.
 *
 *   node test/server-bench.mjs [lines]
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const LINES = Number(process.argv[2] ?? 50_000)
const PORT = 8795
const BASE = `http://localhost:${PORT}`
const ROOM = randomBytes(16).toString('hex')
const TOKEN = 'bench-token'

const server = spawn(process.execPath, ['server/server.mjs'], {
  env: { ...process.env, PORT: String(PORT), CATHODE_DATA: mkdtempSync(join(tmpdir(), 'cathode-bench-')) },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((ok) => server.stdout.once('data', ok))

const line = () => randomBytes(750).toString('base64url')
const post = (lines) =>
  fetch(`${BASE}/events/${ROOM}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cathode-write': TOKEN },
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
    const res = await fetch(`${BASE}/events/${ROOM}?from=${LINES - 10}`)
    await res.json()
  })
  for (const [label, limit, enc] of [['read everything, page by page', 5000, 'identity']]) {
    await time(label, 3, async () => {
      let from = 0
      for (;;) {
        const res = await fetch(`${BASE}/events/${ROOM}?from=${from}&limit=${limit}`, {
          headers: { 'accept-encoding': enc },
        })
        const page = await res.json()
        from = page.at
        if (!page.more) break
      }
    })
  }
  await time('append one message', 20, async () => {
    await (await post([line()])).json()
  })

  // Two sockets in one relay room, a frame from one to the other.
  const a = new WebSocket(`ws://localhost:${PORT}/relay/${ROOM}`)
  const b = new WebSocket(`ws://localhost:${PORT}/relay/${ROOM}`)
  await Promise.all([a, b].map((ws) => new Promise((ok) => (ws.onopen = ok))))
  const frame = line()
  await time('a frame across the relay', 200, () => new Promise((ok) => {
    b.onmessage = () => ok()
    a.send(frame)
  }))
  a.close()
  b.close()
} finally {
  server.kill()
}
