import { spawn } from 'node:child_process'
import { check, finish, launch, stoppedEarly } from './harness.mjs'
import { startServer } from './pg.mjs'

const PORT = 8796
const PAGE_PORT = 5181
const APP_URL = `http://localhost:${PAGE_PORT}/`
const SERVER = `localhost:${PORT}`

const server = await startServer(PORT)
const vite = spawn('npx', ['vite', '--port', String(PAGE_PORT), '--strictPort'], {
  env: { ...process.env, VITE_NOOK_SERVER: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((ready) => vite.stdout.on('data', (b) => /Local:/.test(String(b)) && ready()))

const browser = await launch()

async function person(name) {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Room code"]')
  return page
}

const has = (page, selector) => page.evaluate((s) => !!document.querySelector(s), selector)
const buttonNamed = (page, text) =>
  page.evaluate((t) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === t), text)

try {
  const alice = await person('Alice')
  check('a new visitor is asked for a server', await has(alice, 'input[aria-label="Your server"]'))
  check('and is not offered New space without one', !(await buttonNamed(alice, 'New space')))
  await alice.setViewportSize({ width: 1280, height: 800 })
  await alice.screenshot({ path: new URL('../test-output/own-server-home.png', import.meta.url).pathname })

  await alice.fill('input[aria-label="Your server"]', 'localhost:1')
  await alice.click('button:text-is("Add")')
  await alice.waitForTimeout(1500)
  check('an address with no server behind it is refused', await has(alice, 'input[aria-label="Your server"]'))

  await alice.fill('input[aria-label="Your server"]', SERVER)
  await alice.click('button:text-is("Add")')
  await alice.waitForSelector('input[aria-label="Space name"]', { timeout: 10_000 })
  check('adding a real server offers New space', await buttonNamed(alice, 'New space'))

  await alice.fill('input[aria-label="Space name"]', 'Paris')
  await alice.click('button:has-text("New space")')
  await alice.waitForFunction(() => document.querySelector('.space-name')?.textContent === 'Paris', null, {
    timeout: 15_000,
  })
  const link = alice.url()
  check('the space is made on her server', link.includes(`@${SERVER}`), link)

  await alice.reload()
  await alice.waitForFunction(() => document.querySelector('.space-name')?.textContent === 'Paris', null, {
    timeout: 15_000,
  })
  check('her server and her space are still there after a reload', true)

  const bob = await person('Bob')
  await bob.goto(link)
  const joined = await bob
    .waitForFunction(() => document.querySelector('.space-name')?.textContent === 'Paris', null, {
      timeout: 15_000,
    })
    .then(() => true, () => false)
  check('somebody with no server can join from an invite', joined)

  await bob.click('button[aria-label="Switch space"]')
  await bob.click('.menu.switcher .menu-item:has-text("Home")')
  await bob.waitForSelector('input[aria-label="Room code"]')
  check('her server is not where his own spaces go', await has(bob, 'input[aria-label="Your server"]'))
  check('and the space he joined is on his list', (await bob.$$('.space-row .rail-item')).length === 1)

  await bob.click('button[aria-label="Settings"]')
  await bob.waitForSelector('.server-row')
  const listed = await bob.evaluate(() => ({
    note: document.body.innerText.includes('You have no server yet'),
    invites: [...document.querySelectorAll('.eyebrow')].some((e) => e.textContent === 'From invites'),
    rows: [...document.querySelectorAll('.server-name')].map((e) => e.textContent),
  }))
  check(
    'settings shows her server under From invites, not as his',
    listed.note && listed.invites && listed.rows.length === 1,
    JSON.stringify(listed),
  )
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  vite.kill()
  server.child.kill()
}

finish()
