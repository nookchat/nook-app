/**
 * The archive as a relay.
 *
 * The server side is bare WebSocket, written by hand, so what the RFC says a
 * server must do is checked here against real client sockets: frames reach
 * everybody else in the room and nobody outside it, the sender never hears
 * its own echo, and a frame past the cap takes the connection with it.
 *
 *   node test/relay-check.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8791
const ROOM_A = 'a'.repeat(32)
const ROOM_B = 'b'.repeat(32)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const server = spawn(process.execPath, ['server/server.mjs'], {
  env: { ...process.env, PORT: String(PORT), CATHODE_DATA: mkdtempSync(join(tmpdir(), 'cathode-relay-')) },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((ok) => server.stdout.once('data', ok))

/** A socket that is open, with its post box. */
function join_(room) {
  return new Promise((ok, no) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/relay/${room}`)
    const heard = []
    ws.onmessage = (ev) => heard.push(String(ev.data))
    ws.onopen = () => ok({ ws, heard })
    ws.onerror = () => no(new Error('refused'))
  })
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))

try {
  const one = await join_(ROOM_A)
  const two = await join_(ROOM_A)
  const three = await join_(ROOM_B)

  one.ws.send('hello from one')
  await wait(400)
  check('a frame reaches the other socket in the room', two.heard.includes('hello from one'))
  check('and never the sender itself', !one.heard.includes('hello from one'))
  check('and nobody in another room', three.heard.length === 0)

  two.ws.send('and back')
  await wait(400)
  check('the room carries both directions', one.heard.includes('and back'))

  // The door: a path that is not a room is not a relay.
  const refused = await join_('not-a-room').then(() => false).catch(() => true)
  check('a path that is not a room is refused', refused)

  // The cap: a frame past it takes the connection with it, and the room
  // carries on for everybody else.
  const big = await join_(ROOM_A)
  big.ws.send('x'.repeat(129 * 1024))
  const closed = await new Promise((ok) => {
    big.ws.onclose = () => ok(true)
    setTimeout(() => ok(false), 3000)
  })
  check('a frame past the cap closes the connection', closed)
  one.ws.send('still here')
  await wait(400)
  check('and the room carries on without it', two.heard.includes('still here'))

  one.ws.close()
  two.ws.close()
  three.ws.close()
} catch (err) {
  console.error('\nThe run stopped early:', err.message)
  process.exitCode = 1
} finally {
  server.kill()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
