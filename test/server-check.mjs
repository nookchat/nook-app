/**
 * A space that runs on a server.
 *
 * The browsers here have no public relay and no WebRTC at all: the relay
 * names do not resolve, and RTCPeerConnection is taken away before the page
 * loads. If two people still find each
 * other and talk, and somebody who turns up after they have both gone still
 * reads what they said, then the server carried all of it, which is the point.
 *
 *   node test/server-check.mjs
 */

import { chromium } from 'playwright-core'
import { startServer } from './pg.mjs'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const PORT = 8793
const SERVER = `localhost:${PORT}`
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const { child: server } = await startServer(PORT, {
  // A TURN address nobody has to answer: this checks it is handed out.
  CATHODE_TURN_URLS: 'turn:turn.invalid:3478',
  CATHODE_TURN_SECRET: 'test-secret',
})

const DARK = ['broker.emqx.io', 'broker.hivemq.com', 'nos.lol', 'relay.snort.social', 'nostr.mom']
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: [`--host-resolver-rules=${DARK.map((h) => `MAP ${h} ~NOTFOUND`).join(', ')}`],
})

const BOX = '[aria-label="Write a message"]'
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))

/** Every socket and request a page opens, so the test can say where it went. */
const sockets = []
const requests = []

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  // No WebRTC. A data channel cannot be what carries anything here.
  await context.addInitScript(() => {
    const gone = function () {
      throw new Error('no WebRTC in this test')
    }
    window.RTCPeerConnection = gone
    window.webkitRTCPeerConnection = gone
  })
  const page = await context.newPage()
  page.on('websocket', (ws) => sockets.push(ws.url()))
  page.on('request', (req) => requests.push(req.url()))
  await page.goto(APP_URL)
  // This test's own server, as the one new spaces go to.
  await page.evaluate(
    ({ n, server }) => {
      localStorage.setItem('cathode.name.v1', n)
      localStorage.setItem('cathode.server.v1', server)
      localStorage.setItem('cathode.servers.v1', JSON.stringify([server]))
    },
    { n: name, server: `http://${SERVER}` },
  )
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const sees = (page, text, timeout = 20_000) =>
  page
    .waitForFunction(
      (t) => [...document.querySelectorAll('.chat-text')].some((n) => n.textContent.includes(t)),
      text,
      { timeout },
    )
    .then(() => true)
    .catch(() => false)

async function say(page, text) {
  await page.click(BOX)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

try {
  const health = await (await fetch(`http://${SERVER}/api/v1/health`)).json()
  check('the server says it has TURN', health.turn === true, JSON.stringify(health))

  const alice = await person('Alice')

  await alice.fill('input[aria-label="Space name"]', 'on the box')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  const link = alice.url()
  check('the invite names the server', link.includes(`@${SERVER}`), link)

  const standing = await alice
    .waitForFunction(
      (s) => document.querySelector('.status-bar')?.textContent?.includes(`on ${s}`),
      SERVER,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('the status bar says it is on the server', standing)

  const bob = await person('Bob')
  await bob.goto(link)
  const met = await bob
    .waitForFunction(
      () => document.querySelector('.space-name')?.textContent === 'on the box',
      null,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('somebody opening the link finds the space with no WebRTC', met)

  await say(alice, 'carried by the server')
  check('a message crosses one way', await sees(bob, 'carried by the server'))
  await say(bob, 'and back again')
  check('and the other', await sees(alice, 'and back again'))

  // Listed rather than opened: opening a database makes it.
  const databases = await alice.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  check('nothing about the space is written down in the browser', databases.length === 0, databases.join(' '))

  const people = await alice
    .waitForFunction(() => document.querySelector('.status-bar')?.textContent?.includes('2 here'), null, {
      timeout: 15_000,
    })
    .then(() => true)
    .catch(() => false)
  check('both are here, to each other', people)

  // Doing nothing costs nothing: no polling, no pings, no presence on a timer.
  {
    await wait(3000)
    const sent = []
    const cdp = await alice.context().newCDPSession(alice)
    await cdp.send('Network.enable')
    cdp.on('Network.webSocketFrameSent', (e) => {
      if (!e.response.payloadData.startsWith('{"type":"ping"')) sent.push(e.response.payloadData.slice(0, 20))
    })
    const asked = []
    const onRequest = (r) => r.url().includes(SERVER) && asked.push(new URL(r.url()).pathname)
    alice.on('request', onRequest)
    await wait(12_000)
    alice.off('request', onRequest)
    await cdp.detach()
    /*
     * Nothing on a timer: no kind of frame and no request twice. A timer, even
     * a slow one, repeats inside twelve seconds; a connection that happened to
     * drop and come back under load says each thing once.
     */
    const kinds = [...sent.map((f) => f.slice(0, 12)), ...asked]
    const repeated = kinds.filter((k, i) => kinds.indexOf(k) !== i)
    check(
      'an open space sends the server nothing on a timer while nobody does anything',
      repeated.length === 0,
      `${sent.length} frames, ${asked.length} requests in 12 s${repeated.length ? `, repeated: ${repeated.join(' ')}` : ''}`,
    )
  }

  // Presence is held by the server, not repeated: somebody new sees who is
  // here at once, a tab put away says so, and a tab that closes is gone at
  // once for everybody, with nothing on a timer.
  const erin = await person('Erin')
  const erinAt = Date.now()
  await erin.goto(link)
  const erinSees = await erin
    .waitForFunction(() => document.querySelector('.status-bar')?.textContent?.includes('3 here'), null, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  check('somebody new sees who is already here at once', erinSees, `${Date.now() - erinAt} ms`)
  await bob.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const away = await alice
    .waitForFunction(
      () => [...document.querySelectorAll('.rail-person')].some((r) => r.textContent.includes('Bob') && r.querySelector('.dot.warn')),
      null,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false)
  check('a tab put away says so, straight away', away)
  const goneAt = Date.now()
  await erin.context().close()
  const gone = await alice
    .waitForFunction(() => document.querySelector('.status-bar')?.textContent?.includes('2 here'), null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  check('a tab that closes is gone for everybody at once', gone, `${Date.now() - goneAt} ms`)

  // Alice's key on a second device: the space is on her list there, from the server.
  const key = await alice.evaluate(() => ({
    id: localStorage.getItem('cathode.identity.v1'),
    servers: localStorage.getItem('cathode.servers.v1'),
  }))
  await wait(800)
  const second = await person('Alice')
  await second.evaluate((k) => {
    localStorage.setItem('cathode.identity.v1', k.id)
    localStorage.setItem('cathode.servers.v1', k.servers)
    localStorage.setItem('cathode.server.v1', JSON.parse(k.servers)[0])
  }, key)
  await second.reload()
  const listed = await second
    .waitForFunction(
      () => [...document.querySelectorAll('.space-row')].some((r) => r.textContent.includes('on the box')),
      null,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false)
  check(
    'a second device with the same key finds the space on the server',
    listed,
    listed ? '' : await second.evaluate(() => document.querySelector('.home-spaces')?.textContent ?? 'no list'),
  )
  if (listed) {
    await second.click('.space-row .rail-item')
    check('and opens it with the whole history', await sees(second, 'and back again'))
  }
  await second.context().close()

  // Somebody arrives after everybody has gone. Only the server can tell them.
  await alice.context().close()
  await bob.context().close()
  await wait(1500)
  const carol = await person('Carol')
  await carol.goto(link)
  check('somebody who comes later reads what was said', await sees(carol, 'carried by the server'))
  check('both sides of it', await sees(carol, 'and back again'))

  check(
    'the ICE servers came from the server',
    requests.some((u) => u.startsWith(`http://${SERVER}/api/v1/ice`)),
  )
  const elsewhere = sockets.filter((u) => u !== `ws://${SERVER}/api/v1/socket` && !u.includes(':5173'))
  check('everything went over the one socket to the server', elsewhere.length === 0, elsewhere.join(' '))
  check(
    'and nothing went over plain HTTP but the record of your spaces',
    !requests.some((u) => u.includes('/events/')),
  )

} catch (err) {
  console.error('\nThe run stopped early:', err.message)
  process.exitCode = 1
} finally {
  await browser.close()
  server.kill()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
