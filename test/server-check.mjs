/**
 * A space that runs on a server.
 *
 * The browsers here have no public relay and no WebRTC at all: the relay
 * names do not resolve, and RTCPeerConnection is taken away before the page
 * loads. Peer to peer has nothing to stand on. If two people still find each
 * other and talk, and somebody who turns up after they have both gone still
 * reads what they said, then the server carried all of it, which is the point.
 *
 *   node test/server-check.mjs
 */

import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const server = spawn(process.execPath, ['server/server.mjs'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    CATHODE_DATA: mkdtempSync(join(tmpdir(), 'cathode-server-')),
    // A TURN address nobody has to answer: this checks it is handed out.
    CATHODE_TURN_URLS: 'turn:turn.invalid:3478',
    CATHODE_TURN_SECRET: 'test-secret',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((ok) => server.stdout.once('data', ok))

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
  await page.evaluate((n) => localStorage.setItem('cathode.name.v1', n), name)
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
  const health = await (await fetch(`http://${SERVER}/health`)).json()
  check('the server says it has TURN', health.turn === true, JSON.stringify(health))

  const alice = await person('Alice')

  // A server nobody runs is refused before a space is made on it.
  await alice.click('button:has-text("Server")')
  await alice.fill('input[aria-label="Server address"]', 'localhost:1')
  await alice.fill('input[aria-label="Space name"]', 'on the box')
  await alice.click('button:has-text("New space")')
  await wait(1500)
  check(
    'a server that does not answer is refused',
    (await alice.$('.space-name')) === null,
  )

  await alice.fill('input[aria-label="Server address"]', SERVER)
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

  const people = await alice
    .waitForFunction(() => document.querySelector('.status-bar')?.textContent?.includes('2 here'), null, {
      timeout: 15_000,
    })
    .then(() => true)
    .catch(() => false)
  check('both are here, to each other', people)

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
    requests.some((u) => u.startsWith(`http://${SERVER}/ice`)),
  )
  const elsewhere = sockets.filter((u) => !u.startsWith(`ws://${SERVER}/relay/`) && !u.includes(':5173'))
  check('no socket went anywhere but the server', elsewhere.length === 0, elsewhere.join(' '))

  // The same page still makes a peer to peer space when asked to.
  const dave = await person('Dave')
  await dave.click('button:has-text("Peer to peer")')
  await dave.fill('input[aria-label="Space name"]', 'no box')
  await dave.click('button:has-text("New space")')
  await dave.waitForSelector('.space-name')
  check('peer to peer is still one click away', !dave.url().includes('@'), dave.url())
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
