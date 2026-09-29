import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { check, finish, poll, stoppedEarly, wait } from './harness.mjs'
import { startServer } from './pg.mjs'

// The server holds who is here: each live session and its last sealed state. A page that
// goes must never be left behind in it, and a page can ask it for the list at any time.
const until = (test, ms = 10_000) => poll(test, ms, 100)

const PORT = 8807
const BASE = `http://localhost:${PORT}`
const { child: server } = await startServer(PORT)

function socket(room) {
  const got = []
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/v1/spaces/${room}/socket`)
  ws.onmessage = (e) => got.push(JSON.parse(e.data))
  return new Promise((ok) => (ws.onopen = () => ok({ ws, got })))
}

function masked(opcode, text) {
  const payload = Buffer.from(text)
  const mask = randomBytes(4)
  const head = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length]) : null
  if (!head) throw new Error('keep the test frames short')
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))
  return Buffer.concat([head, mask, body])
}

/** A socket that says its state and closes in one write, as a page does when it reloads. */
function sayAndGo(room, message) {
  return new Promise((done, fail) => {
    const raw = connect(PORT, 'localhost')
    raw.on('error', fail)
    raw.on('connect', () => {
      raw.write(
        `GET /api/v1/spaces/${room}/socket HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    let upgraded = false
    raw.on('data', (chunk) => {
      if (upgraded || !String(chunk).startsWith('HTTP/1.1 101')) return
      upgraded = true
      raw.write(Buffer.concat([masked(1, JSON.stringify(message)), masked(8, '')]))
    })
    raw.on('close', () => done())
  })
}

const room = () => randomBytes(16).toString('hex')
const sigs = (got) => got.filter((m) => m.t === 'sig').map((m) => m.d)
const here = (got) => got.filter((m) => m.t === 'here').at(-1)

try {
  // 1. A state said at the very moment the socket closes.
  const r1 = room()
  const watcher = await socket(r1)
  watcher.ws.send(JSON.stringify({ t: 'hello', from: 0 }))
  await until(() => watcher.got.some((m) => m.t === 'live'))
  await sayAndGo(r1, { t: 'state', id: 'aaaa', d: 'sealed-ghost-state' })
  await wait(500)

  const late = await socket(r1)
  late.ws.send(JSON.stringify({ t: 'hello', from: 0 }))
  await until(() => late.got.some((m) => m.t === 'live'))
  check('a state said as the socket closed is not handed to anybody who comes later', !sigs(late.got).includes('sealed-ghost-state'), sigs(late.got).join(' '))
  const list = here(late.got)
  check('the list sent with the hello is there', !!list, JSON.stringify(list))
  check('and it does not have the gone session', list && !list.ids.includes('aaaa'), JSON.stringify(list?.ids))
  const leftOrNever =
    !sigs(watcher.got).includes('sealed-ghost-state') || watcher.got.some((m) => m.t === 'left' && m.id === 'aaaa')
  check('anybody who heard it also hears that it left', leftOrNever)
  watcher.ws.close()
  late.ws.close()

  // 2. The list of who is here, asked for.
  const r2 = room()
  const ada = await socket(r2)
  ada.ws.send(JSON.stringify({ t: 'hello', from: 0 }))
  ada.ws.send(JSON.stringify({ t: 'state', id: 'ada1', d: 'sealed-ada' }))
  const bob = await socket(r2)
  bob.ws.send(JSON.stringify({ t: 'hello', from: 0 }))
  bob.ws.send(JSON.stringify({ t: 'state', id: 'b0b1', d: 'sealed-bob' }))
  await until(() => sigs(ada.got).includes('sealed-bob'))
  ada.ws.send(JSON.stringify({ t: 'who' }))
  await until(() => here(ada.got)?.ids.length === 2)
  const both = here(ada.got)
  check('asked who is here, the server names every live session', both?.ids.sort().join() === 'ada1,b0b1', JSON.stringify(both))
  check('and says how long it has been up', typeof both?.up === 'number' && both.up > 0, String(both?.up))

  bob.ws.close()
  await until(() => ada.got.some((m) => m.t === 'left' && m.id === 'b0b1'))
  ada.ws.send(JSON.stringify({ t: 'who' }))
  await until(() => here(ada.got)?.ids.length === 1)
  check('one who has gone is off the list', here(ada.got)?.ids.join() === 'ada1', JSON.stringify(here(ada.got)))

  // 3. One session on two sockets, as after a reconnect the server has not noticed yet.
  const old = await socket(r2)
  old.ws.send(JSON.stringify({ t: 'state', id: 'cafe', d: 'sealed-cara' }))
  await until(() => sigs(ada.got).includes('sealed-cara'))
  const fresh = await socket(r2)
  fresh.ws.send(JSON.stringify({ t: 'state', id: 'cafe', d: 'sealed-cara-2' }))
  await until(() => sigs(ada.got).includes('sealed-cara-2'))
  old.ws.close()
  await wait(700)
  check(
    'the old socket closing does not say a session left that is still here on a new one',
    !ada.got.some((m) => m.t === 'left' && m.id === 'cafe'),
  )
  ada.ws.send(JSON.stringify({ t: 'who' }))
  await wait(300)
  check('and the list still has it, once', here(ada.got)?.ids.filter((id) => id === 'cafe').length === 1, JSON.stringify(here(ada.got)))
  fresh.ws.close()
  check('it leaves when the last of its sockets goes', await until(() => ada.got.some((m) => m.t === 'left' && m.id === 'cafe')))
  ada.ws.close()
} catch (err) {
  stoppedEarly(err)
} finally {
  server.kill()
  finish()
}
