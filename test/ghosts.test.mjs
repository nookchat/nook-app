import { randomBytes } from 'node:crypto'
import { check, finish, stoppedEarly, wait } from './harness.mjs'
import { startServer } from './pg.mjs'

// Nobody is listed as here who is not. A last announce that comes in just after a leave must not
// have the session back, on a socket that stays open. And a session that stops saying it is here
// goes off the list, whatever its socket does, so a newcomer never sees it.
const PORT = 8813
const STALE_MS = 3000
const { child: server } = await startServer(PORT, { NOOK_STATE_STALE_MS: String(STALE_MS) })

const room = randomBytes(16).toString('hex')

/** A raw socket to the server, and everything it hears. */
async function socket() {
  const ws = new WebSocket(`ws://localhost:${PORT}/api/v1/socket`)
  const heard = []
  ws.onmessage = (ev) => heard.push(JSON.parse(ev.data))
  await new Promise((ok, fail) => {
    ws.onopen = ok
    ws.onerror = fail
  })
  const say = (message) => ws.send(JSON.stringify({ room, ...message }))
  return { ws, heard, say }
}

/** What a newcomer hears when it comes in: the announces it is sent, and the list of who is here. */
async function newcomer() {
  const one = await socket()
  one.say({ t: 'hello', from: 0 })
  await wait(400)
  const here = one.heard.find((m) => m.t === 'here')?.ids ?? null
  const sigs = one.heard.filter((m) => m.t === 'sig').map((m) => m.d)
  one.ws.close()
  return { here, sigs }
}

try {
  // Ada stays; Bob leaves the space, and his last announce comes in after his leave.
  const ada = await socket()
  ada.say({ t: 'state', id: 'ada1', d: 'ada-announce' })
  ada.say({ t: 'hello', from: 0 })
  const bob = await socket()
  bob.say({ t: 'state', id: 'b0b1', d: 'bob-announce' })
  bob.say({ t: 'hello', from: 0 })
  await wait(300)
  const before = await newcomer()
  check('both are here at first', before.here?.includes('ada1') && before.here?.includes('b0b1'), JSON.stringify(before.here))

  bob.say({ t: 'leave' })
  bob.say({ t: 'state', id: 'b0b1', d: 'bob-late-announce' })
  bob.say({ t: 'sig', d: 'bob-late-signal' })
  await wait(300)
  check('Ada hears that Bob left', ada.heard.some((m) => m.t === 'left' && m.id === 'b0b1'))
  const after = await newcomer()
  check('an announce after a leave does not have him back', !after.here?.includes('b0b1'), JSON.stringify(after.here))
  check('and a newcomer is not sent it', !after.sigs.some((d) => d.startsWith('bob')), after.sigs.join(', '))
  check('Ada is still here', after.here?.includes('ada1'))
  check('nor does Ada hear his late signal', !ada.heard.some((m) => m.t === 'sig' && m.d === 'bob-late-signal'))

  // A hello brings him back in, as opening the space again does.
  bob.say({ t: 'hello', from: 0 })
  bob.say({ t: 'state', id: 'b0b2', d: 'bob-again' })
  await wait(300)
  check('a hello after the leave has him back', (await newcomer()).here?.includes('b0b2'))

  // Bob's socket stays open, but he stops saying he is here. Ada keeps saying so.
  const keep = setInterval(() => ada.say({ t: 'state', id: 'ada1', d: 'ada-announce' }), 800)
  await wait(STALE_MS + 11_000)
  clearInterval(keep)
  const later = await newcomer()
  check('a session silent too long goes off the list, though its socket is open', !later.here?.includes('b0b2'), JSON.stringify(later.here))
  check('and a newcomer is not sent its old announce', !later.sigs.includes('bob-again'), later.sigs.join(', '))
  check('the others are told it left', ada.heard.some((m) => m.t === 'left' && m.id === 'b0b2'))
  check('one that keeps saying so stays', later.here?.includes('ada1'))

  bob.say({ t: 'state', id: 'b0b2', d: 'bob-back' })
  await wait(300)
  check('its next announce has it back', (await newcomer()).here?.includes('b0b2'))
  ada.ws.close()
  bob.ws.close()
} catch (err) {
  stoppedEarly(err)
}

server.kill()
finish()
