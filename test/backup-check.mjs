/**
 * The day a browser forgets everything, and the preferences that follow you.
 *
 *   a backup     Ana saves her account as a file; a browser with nothing in
 *                it restores it at its first screen and is Ana, with her
 *                space and what was said in it
 *   a password   a backup saved with one will not open with another
 *   a note       Settings says when this device last saved one
 *   a drop       the file dropped on the first screen restores it too
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
  await page.click('button:text-is("Save a backup")')
  if (password) {
    await page.click('button:has-text("Add a password")')
    await page.fill('input[aria-label="Password for the backup"]', password)
  }
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Save backup file")')])
  const path = await download.path()
  const noted = await page.waitForFunction(() => document.body.textContent.includes('You saved one on'), null, { timeout: 5000 }).then(() => true, () => false)
  await page.click('button[aria-label="Close settings"]')
  return { path, name: download.suggestedFilename(), text: readFileSync(path, 'utf8'), noted }
}

async function restore(page, path, password = '') {
  await page.goto(APP_URL)
  await page.click('button:has-text("I have an account")')
  await page.click('button:has-text("Use a backup file")')
  await page.setInputFiles('input[aria-label="Backup file"]', path)
  if (password !== null && password !== '') {
    await page.waitForSelector('input[aria-label="The backup’s password"]:visible')
    await page.fill('input[aria-label="The backup’s password"]', password)
    await page.click('button:text-is("Restore")')
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
  await ana.click('.welcome-step:not(.hidden) button.primary')
  await ana.fill('input[aria-label="Your name"]', 'Ana')
  await ana.keyboard.press('Enter')
  await ana.fill('input[aria-label="Space name"]', 'kept')
  await ana.click('button:has-text("New space")')
  await ana.waitForSelector(BOX)
  await ana.click(BOX)
  await ana.keyboard.type(SAID)
  await ana.keyboard.press('Enter')
  await wait(1500)

  // A picture, set in settings: it goes to the server, not into the browser.
  const { writeFileSync } = await import('node:fs')
  const shot = new URL('../test-output/backup-face.png', import.meta.url).pathname
  writeFileSync(shot, await ana.screenshot({ clip: { x: 0, y: 0, width: 120, height: 120 } }))
  await ana.evaluate(() => document.querySelector('button[aria-label="Settings"]').click())
  await ana.setInputFiles('input[aria-label="Choose a picture"]', shot)
  await ana.waitForSelector('.profile-face img', { timeout: 10_000 })
  await ana.click('button[aria-label="Close settings"]')
  await wait(3000)
  const inBrowser = await ana.evaluate(() => localStorage.getItem('cathode.avatar.v1'))
  check('your picture is not kept in the browser', inBrowser === null, String(inBrowser).slice(0, 30))

  const plain = await backUp(ana)
  const file = JSON.parse(plain.text)
  check('and the backup does not carry it: it is on the server', !plain.text.includes('data:image'), `${plain.text.length} bytes`)
  check('and Settings says a backup was saved', plain.noted)
  check('a backup is one file, named for its owner, that says what it is', plain.name === 'nook-Ana.json' && file.cathode === 'backup' && /private/.test(file.keep), plain.name)

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
  await two.evaluate(() => document.querySelector('button[aria-label="Settings"]').click())
  const face = await two.waitForSelector('.profile-face img', { timeout: 15_000 }).then(() => true, () => false)
  check('and the same picture, from the server', face)
  await two.click('button[aria-label="Close settings"]')

  // ---- dropped on the first screen ----
  const dropped = await fresh()
  await dropped.goto(APP_URL)
  await dropped.waitForSelector('.welcome')
  await dropped.evaluate((text) => {
    const carried = new DataTransfer()
    carried.items.add(new File([text], 'nook-Ana.json', { type: 'application/json' }))
    document.querySelector('.welcome').dispatchEvent(new DragEvent('drop', { dataTransfer: carried, bubbles: true, cancelable: true }))
  }, plain.text)
  await wait(2500)
  check('a backup dropped anywhere on the first screen restores it', (await listed(dropped)).includes('kept'))

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
  await three.click('button:text-is("Restore")')
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
