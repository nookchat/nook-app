/**
 * The day a browser forgets everything, and the preferences that follow you.
 *
 *   a backup     Ana saves her account as a file; a browser with nothing in
 *                it restores it at its first screen and is Ana, with her
 *                space and what was said in it
 *   a password   a backup saved with one will not open with another
 *   preferences  quick reactions and a volume set on one device are on the
 *                other after it reads its record, through the server
 *
 *   node test/backup-check.mjs
 */

import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BOX = '[aria-label="Write a message"]'
const SAID = 'said before the browser forgot'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1' })
const fresh = async () => (await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } })).newPage()

async function backUp(page, password = '') {
  await page.evaluate(() => document.querySelector('button[aria-label="Settings"]').click())
  await page.click('button:has-text("Download a backup")')
  if (password) await page.fill('input[aria-label="Password for the backup"]', password)
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Download backup")')])
  const path = await download.path()
  await page.click('button[aria-label="Close settings"]')
  return { path, name: download.suggestedFilename(), text: readFileSync(path, 'utf8') }
}

async function restore(page, path, password = '') {
  await page.goto(APP_URL)
  await page.waitForSelector('input[aria-label="Your name"]')
  await page.click('button:has-text("I already use Cathode")')
  await page.setInputFiles('input[aria-label="Backup file"]', path)
  if (password !== null && password !== '') {
    await page.waitForSelector('input[aria-label="The backup’s password"]:visible')
    await page.fill('input[aria-label="The backup’s password"]', password)
    await page.click('button:has-text("Restore")')
  }
}

const listed = (page) =>
  page
    .waitForFunction(() => {
      const rows = [...document.querySelectorAll('.space-row .space-row-name')].map((e) => e.textContent)
      return rows.length ? rows : null
    }, null, { timeout: 20_000 })
    .then((h) => h.jsonValue(), () => [])

try {
  // ---- Ana, with a space and something said in it ----
  const ana = await fresh()
  await ana.goto(APP_URL)
  await ana.fill('input[aria-label="Your name"]', 'Ana')
  await ana.keyboard.press('Enter')
  await ana.fill('input[aria-label="Space name"]', 'kept')
  await ana.click('button:has-text("New space")')
  await ana.waitForSelector(BOX)
  await ana.click(BOX)
  await ana.keyboard.type(SAID)
  await ana.keyboard.press('Enter')
  await wait(1500)

  const plain = await backUp(ana)
  const file = JSON.parse(plain.text)
  check('a backup is one file, named for its owner, that says what it is', plain.name === 'cathode-Ana.json' && file.cathode === 'backup' && /private/.test(file.keep), plain.name)

  // ---- a browser with nothing in it ----
  const two = await fresh()
  await restore(two, plain.path)
  await two.waitForURL((url) => !url.hash, { timeout: 15_000 }).catch(() => undefined)
  await wait(1500)
  const spaces = await listed(two)
  check('restoring it makes a new browser the same person, with the same spaces', spaces.includes('kept'), spaces.join(', '))
  await two.click('.space-row .rail-item')
  const read = await two
    .waitForFunction((said) => [...document.querySelectorAll('.chat-text')].some((t) => t.textContent.includes(said)), SAID, { timeout: 20_000 })
    .then(() => true, () => false)
  check('and the same messages', read)
  const name = await two.evaluate(() => document.querySelector('.me-name')?.textContent ?? '')
  check('and the same name', name === 'Ana', name)

  // ---- with a password ----
  const sealed = await backUp(ana, 'correct horse')
  check('a backup with a password does not have the account in it in the open', !sealed.text.includes(JSON.parse(plain.text).account.k))
  const three = await fresh()
  await restore(three, sealed.path, 'wrong horse')
  const refused = await three
    .waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('not the password')), null, { timeout: 15_000 })
    .then(() => true, () => false)
  check('and will not open with another password', refused)
  await three.fill('input[aria-label="The backup’s password"]', 'correct horse')
  await three.click('button:has-text("Restore")')
  await three.waitForURL((url) => !url.hash, { timeout: 15_000 }).catch(() => undefined)
  await wait(1500)
  check('but does with the right one', (await listed(three)).includes('kept'))

  // ---- preferences, through the server ----
  const bobKey = 'b'.repeat(64)
  await ana.evaluate((key) => {
    localStorage.setItem('cathode.quick.v1', JSON.stringify(['🦄', '🍕', '🎸']))
    localStorage.setItem('cathode.volume.v1', JSON.stringify({ level: { [key]: 0.25 }, muted: {} }))
  }, bobKey)
  // The record is saved a couple of seconds after a change, and read when a page opens.
  await wait(4000)
  await two.goto(APP_URL)
  await two.waitForSelector('input[aria-label="Space name"]')
  const carried = await two
    .waitForFunction(
      (key) => {
        const quick = localStorage.getItem('cathode.quick.v1') ?? ''
        const volume = JSON.parse(localStorage.getItem('cathode.volume.v1') ?? '{}')
        return quick.includes('🦄') && volume.level?.[key] === 0.25 ? quick : null
      },
      bobKey,
      { timeout: 15_000 },
    )
    .then((h) => h.jsonValue(), () => null)
  check('quick reactions and a volume set on one device are on the other', !!carried, carried ?? 'not carried')
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
