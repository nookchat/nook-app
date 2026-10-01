import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { check, finish, poll, stoppedEarly, wait } from './harness.mjs'
import { startServer } from './pg.mjs'

// What anybody on the internet can send a server, with no token and no space of their own,
// must not stop it: a file that is nowhere, a socket that never reads, a pong nobody asked
// for, a pile of sockets, and a read of a room full of big lines.

const SECRET = 'a-cluster-secret-for-limits'
const A = 'http://localhost:8851'
const B = 'http://localhost:8852'
const cluster = (self, peer) => ({ NOOK_PUBLIC_URL: self, NOOK_PEERS: peer, NOOK_CLUSTER_SECRET: SECRET })
const a = await startServer(8851, { ...cluster(A, B), NOOK_MAX_IP_SOCKETS: '12', NOOK_PUSH_LOCAL: '1' })
const b = await startServer(8852, { ...cluster(B, A), NOOK_PUSH_LOCAL: '1' })
const room = 'd'.repeat(32)

/** A WebSocket by hand, so a check can stop reading, or send what a browser never would. */
function rawSocket(base, path = `/api/v1/spaces/${room}/socket`) {
  const { hostname, port } = new URL(base)
  return new Promise((done) => {
    const socket = connect(Number(port), hostname)
    const key = randomBytes(16).toString('base64')
    let head = ''
    const out = { socket, closed: false, status: 0, frames: [] }
    socket.on('close', () => (out.closed = true))
    socket.on('error', () => (out.closed = true))
    const onHead = (chunk) => {
      head += chunk.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      socket.off('data', onHead)
      out.status = Number(head.split(' ')[1])
      done(out)
    }
    socket.on('data', onHead)
    socket.on('connect', () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    )
  })
}

function frame(opcode, payload) {
  const body = Buffer.from(payload)
  const len = body.length
  const head = len < 126 ? 2 : len < 65_536 ? 4 : 10
  const out = Buffer.alloc(head + 4 + len)
  out[0] = 0x80 | opcode
  if (head === 2) out[1] = 0x80 | len
  else if (head === 4) {
    out[1] = 0x80 | 126
    out.writeUInt16BE(len, 2)
  } else {
    out[1] = 0x80 | 127
    out.writeBigUInt64BE(BigInt(len), 2)
  }
  const mask = randomBytes(4)
  mask.copy(out, head)
  for (let i = 0; i < len; i++) out[head + 4 + i] = body[i] ^ mask[i & 3]
  return out
}
const text = (message) => frame(1, JSON.stringify(message))

try {
  // 1. A file that no server has. Each server once asked the other, which asked back, for ever.
  const started = Date.now()
  const missing = await fetch(`${A}/api/v1/spaces/${room}/files/${'e'.repeat(64)}`, { signal: AbortSignal.timeout(20_000) }).catch(
    (err) => ({ status: String(err) }),
  )
  const took = Date.now() - started
  check('a file that is on no server of the cluster is a quick 404', missing.status === 404 && took < 5_000, `${missing.status} in ${took} ms`)

  // 2. A socket that stops reading, while others send its room a lot, and that sends pongs nobody
  // asked for, to look alive. Only a pong with the bytes of the server's ping counts.
  const slow = await rawSocket(A)
  slow.socket.write(text({ t: 'hello', from: 0 }))
  await wait(300)
  slow.socket.pause()
  const pongs = setInterval(() => !slow.closed && slow.socket.write(frame(10, '')), 1000)
  const senders = []
  for (let i = 0; i < 4; i++) senders.push(await rawSocket(A))
  const big = 'x'.repeat(500 * 1024)
  for (let round = 0; round < 16; round++) {
    for (const s of senders) s.socket.write(text({ t: 'sig', d: big }))
    await wait(50)
  }
  const dropped = await poll(() => slow.closed, 35_000, 500)
  clearInterval(pongs)
  check('a socket that reads nothing is dropped, whatever pongs it sends', dropped)

  // 3. A page that reads answers each ping, and stays.
  const reader = await rawSocket(A)
  let readerBytes = Buffer.alloc(0)
  reader.socket.on('data', (chunk) => {
    readerBytes = Buffer.concat([readerBytes, chunk])
    // Answer each ping with its own bytes, as a browser does.
    for (;;) {
      if (readerBytes.length < 2) return
      const len = readerBytes[1] & 0x7f
      const at = len === 126 ? 4 : len === 127 ? 10 : 2
      const size = len === 126 ? readerBytes.readUInt16BE(2) : len === 127 ? Number(readerBytes.readBigUInt64BE(2)) : len
      if (readerBytes.length < at + size) return
      if ((readerBytes[0] & 0x0f) === 9) reader.socket.write(frame(10, readerBytes.subarray(at, at + size)))
      readerBytes = readerBytes.subarray(at + size)
    }
  })
  await wait(25_000)
  check('a socket that answers its pings stays open', !reader.closed)

  // 4. One address opens only so many sockets.
  for (const s of [slow, reader, ...senders]) s.socket.destroy()
  await wait(1500)
  const many = []
  for (let i = 0; i < 14; i++) many.push(await rawSocket(A))
  const open = many.filter((s) => s.status === 101).length
  const refused = many.filter((s) => s.status === 429).length
  check('one address gets only so many sockets', open === 12 && refused === 2, `${open} open, ${refused} refused`)
  for (const s of many) s.socket.destroy()

  // 5. A room of big lines is read a page of a few megabytes at a time, however many are asked for.
  const token = randomBytes(16).toString('hex')
  const own = createHash('sha256').update(token).digest('hex').slice(0, 32)
  const line = (i) => `${String(i).padStart(4, '0')}${'y'.repeat(120 * 1024)}`
  for (let i = 0; i < 64; i += 8) {
    const res = await fetch(`${B}/api/v1/spaces/${own}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nook-write': token },
      body: JSON.stringify({ events: Array.from({ length: 8 }, (_, j) => line(i + j)) }),
    })
    if (!res.ok) throw new Error(`a write was refused: ${res.status}`)
  }
  let after = 0
  const pages = []
  for (let i = 0; i < 10; i++) {
    const page = await (await fetch(`${B}/api/v1/spaces/${own}/events?after=${after}&limit=5000`)).json()
    pages.push(page)
    after = page.at
    if (!page.more) break
  }
  const sizes = pages.map((p) => p.events.reduce((n, e) => n + e.length, 0))
  const all = pages.flatMap((p) => p.events)
  check('a page stays near four megabytes', sizes.every((n) => n <= 4 * 1024 * 1024 + 128 * 1024), sizes.join(', '))
  check('and every line still comes, in order, once', all.length === 64 && all.every((e, i) => e.startsWith(String(i).padStart(4, '0'))), `${all.length} lines`)

  // 6. A push for a device that took its pushes through another server goes through the space's
  // own server, which hands it on: the other server sees the space's server, not who wrote.
  const pushed = []
  const service = createServer((req, res) => {
    let size = 0
    req.on('data', (c) => (size += c.length))
    req.on('end', () => {
      pushed.push({ path: req.url, size, vapid: String(req.headers.authorization ?? '').startsWith('vapid ') })
      res.writeHead(201)
      res.end()
    })
  }).listen(8859)
  const relayed = await fetch(`${A}/api/v1/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ via: B, endpoint: 'http://localhost:8859/device-1', body: Buffer.alloc(120, 7).toString('base64url'), ttl: 60 }),
  })
  const answer = await relayed.json()
  await poll(() => pushed.length > 0, 5_000)
  check('a push handed on reaches the push service, signed', relayed.ok && answer.ok === true && pushed[0]?.path === '/device-1' && pushed[0].vapid, JSON.stringify({ answer, pushed }))
  const health = await (await fetch(`${A}/api/v1/health`)).json()
  check('a server says it hands pushes on', health.pushRelay === true)
  const inward = await fetch(`${A}/api/v1/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ via: 'https://10.0.0.1', endpoint: 'http://localhost:8859/device-1', body: Buffer.alloc(120, 7).toString('base64url') }),
  })
  check('a push is never handed to a private address', inward.status === 400, String(inward.status))
  service.close()
} catch (err) {
  stoppedEarly(err)
} finally {
  a.child.kill()
  b.child.kill()
  finish()
}
