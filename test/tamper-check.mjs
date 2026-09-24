/**
 * A server that cannot read, and cannot lie.
 *
 * Somebody says something in a space on a real server with a real database.
 * The database is read: the words are not in it. A stranger who knows the
 * space's id tries to write, and is refused. Then every line in the database
 * is altered by hand, and somebody who opens the space afterwards is shown
 * none of it: every event is signed, and a changed one fails its check.
 *
 *   node test/tamper-check.mjs
 */

import { chromium } from 'playwright-core'
import { nameEveryone } from './named.mjs'
import { sql, startServer } from './pg.mjs'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 8791
const SERVER = `http://localhost:${PORT}`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const started = await startServer(PORT)
const db = (text, params) => sql(started.database, text, params)
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1' })
nameEveryone(browser)
const BOX = '[aria-label="Write a message"]'
const SAID = 'said while nobody was listening'

async function person(name) {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL)
  await page.evaluate(
    ({ n, server }) => {
      localStorage.setItem('cathode.name.v1', n)
      localStorage.setItem('cathode.server.v1', server)
      localStorage.setItem('cathode.servers.v1', JSON.stringify([server]))
    },
    { n: name, server: SERVER },
  )
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'sealed')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  await alice.click(BOX)
  await alice.keyboard.type(SAID)
  await alice.keyboard.press('Enter')
  await wait(1500)
  const link = alice.url()

  const rows = await db('select room, body from lines')
  const room = rows[0]?.room
  check('the server kept it', rows.length > 0, `${rows.length} lines`)
  check('and cannot read it', rows.every((r) => !r.body.includes(SAID) && !r.body.includes('Alice')))

  const bare = await fetch(`${SERVER}/api/v1/spaces/${room}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: ['junk'] }),
  })
  check('a write without the token is refused', bare.status === 403, `${bare.status}`)
  const wrong = await fetch(`${SERVER}/api/v1/spaces/${room}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cathode-write': 'f'.repeat(64) },
    body: JSON.stringify({ events: ['junk'] }),
  })
  check("and one with a stranger's token is refused too", wrong.status === 403, `${wrong.status}`)
  const junk = Number((await db(`select count(*) as n from lines where body = 'junk'`))[0].n)
  check('and neither left a mark', junk === 0)

  await alice.context().close()
  // Every line, not one, so nothing gets through for any other reason.
  await db(
    `update lines set body = substr(body, 1, 30) ||
       (case when substr(body, 31, 1) = 'A' then 'B' else 'A' end) || substr(body, 32)`,
  )

  const carol = await person('Carol')
  await carol.goto(link)
  await wait(4000)
  const fooled = await carol.evaluate(
    (said) => ({
      said: (document.querySelector('.chat-log')?.textContent ?? '').includes(said),
      lines: document.querySelectorAll('.chat-text').length,
    }),
    SAID,
  )
  check('an altered history shows nothing', !fooled.said && fooled.lines === 0, `${fooled.lines} lines shown`)
} catch (err) {
  console.error('\nThe run stopped early:', err.message)
  process.exitCode = 1
} finally {
  await browser.close()
  started.child.kill()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
process.exit()
