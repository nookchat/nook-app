/**
 * A space that rides its own archive when every public relay is gone.
 *
 * The browsers here cannot reach a single public broker or Nostr relay: the
 * resolver is told those names do not exist. If two people still find each
 * other and talk, the only thing that carried them is the archive's own
 * relay, which is the point of it having one.
 *
 *   node test/self-relay-check.mjs
 */

import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const ARCHIVE_PORT = 8792
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
    PORT: String(ARCHIVE_PORT),
    CATHODE_DATA: mkdtempSync(join(tmpdir(), 'cathode-self-relay-')),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((ok) => server.stdout.once('data', ok))

/* Every public relay, gone. The names stop resolving, which is a fair
   portrait of the bad night this feature exists for. */
const DARK = ['broker.emqx.io', 'broker.hivemq.com', 'nos.lol', 'relay.snort.social', 'nostr.mom']
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [`--host-resolver-rules=${DARK.map((h) => `MAP ${h} ~NOTFOUND`).join(', ')}`],
})

const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate(
    ({ n, archive }) => {
      localStorage.setItem('cathode.name.v1', n)
      localStorage.setItem('cathode.archive.v1', archive)
    },
    { n: name, archive: `http://localhost:${ARCHIVE_PORT}` },
  )
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'dark night')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  await wait(1200)

  const standing = await alice.evaluate(() => document.querySelector('.status-bar')?.textContent ?? '')
  check('the archive relay is the one standing', /1 relay\b/.test(standing), standing)

  const bob = await person('Bob')
  await bob.goto(alice.url())
  const met = await bob
    .waitForFunction(
      () => document.querySelector('.space-name')?.textContent === 'dark night',
      null,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('two people find each other with every public relay dark', met)

  await alice.click(BOX)
  await alice.keyboard.type('carried by our own machine')
  await alice.keyboard.press('Enter')
  const heard = await bob
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.chat-text')].some((t) =>
          t.textContent.includes('carried by our own machine'),
        ),
      null,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('and a message crosses', heard)
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
