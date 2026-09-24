/**
 * The same person, with the same spaces and messages, on a second device.
 *
 *   by the code   Ana makes a link; a new device, at its first screen, says
 *                 it already uses Cathode and types the code and its server
 *   once only     a third device opens the same link after, and is refused
 *   by the link   Ana makes another; the third device opens it, and is her
 *
 * Each new device ends up as Ana: her name, her ID, her space on its list,
 * and what was said in it, all read from the server.
 *
 *   node test/link-check.mjs
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BOX = '[aria-label="Write a message"]'
const SAID = 'said on the first device'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1' })
const fresh = async () => (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()

async function makeLink(page) {
  await page.click('button[aria-label="Settings"]')
  await page.click('button:has-text("Link another device")')
  const code = page.locator('.link-code')
  await code.waitFor({ timeout: 15_000 })
  const offer = { code: (await code.textContent()).trim(), link: await code.getAttribute('data-link') }
  await page.keyboard.press('Escape')
  await page.click('button:has-text("Back")')
  return offer
}

/** Who a page is, as its settings say, and what spaces it lists. */
async function whoIs(page) {
  await page.waitForSelector('input[aria-label="Space name"]', { timeout: 20_000 })
  const spaces = await page
    .waitForFunction(() => {
      const rows = [...document.querySelectorAll('.space-row .space-row-name')].map((e) => e.textContent)
      return rows.length ? rows : null
    }, null, { timeout: 20_000 })
    .then((h) => h.jsonValue())
    .catch(() => [])
  await page.click('button[aria-label="Settings"]')
  await page.waitForSelector('input[aria-label="Your name"]')
  const me = await page.evaluate(() => ({
    name: document.querySelector('input[aria-label="Your name"]')?.value ?? '',
    id: [...document.querySelectorAll('.share-code')].map((e) => e.textContent).find((t) => t?.startsWith('#')) ?? '',
  }))
  await page.click('button:has-text("Back")')
  return { ...me, spaces }
}

try {
  // ---- the device Ana already uses ----
  const ana = await fresh()
  await ana.goto(APP_URL)
  await ana.fill('input[aria-label="Your name"]', 'Ana')
  await ana.keyboard.press('Enter')
  await ana.fill('input[aria-label="Space name"]', 'linked')
  await ana.click('button:has-text("New space")')
  await ana.waitForSelector(BOX)
  await ana.click(BOX)
  await ana.keyboard.type(SAID)
  await ana.keyboard.press('Enter')
  await wait(1500)
  await ana.click('button[aria-label="Your spaces"]')
  const her = await whoIs(ana)

  const first = await makeLink(ana)
  check('a link comes as a code of three groups of four', /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(first.code), first.code)

  // ---- a new device, by typing the code ----
  const two = await fresh()
  await two.goto(APP_URL)
  await two.waitForSelector('input[aria-label="Your name"]')
  await two.click('button:has-text("I already use Cathode on another device")')
  await two.fill('input[aria-label="The link or code"]', first.code.toLowerCase())
  await two.fill('input[aria-label="The server"]', 'localhost:8787')
  await two.click('button:has-text("Link this device")')
  await two.waitForURL((url) => !url.hash, { timeout: 15_000 }).catch(() => undefined)
  await wait(1500)
  const asTwo = await whoIs(two)
  check('typing the code makes the new device the same person', asTwo.name === 'Ana' && asTwo.id === her.id, JSON.stringify(asTwo))
  check('with the same spaces', asTwo.spaces.includes('linked'), asTwo.spaces.join(', '))
  await two.click('.space-row .rail-item')
  const read = await two
    .waitForFunction((said) => [...document.querySelectorAll('.chat-text')].some((t) => t.textContent.includes(said)), SAID, { timeout: 20_000 })
    .then(() => true, () => false)
  check('and the same messages', read)

  // ---- the same link again: used ----
  const three = await fresh()
  await three.goto(first.link)
  const refused = await three
    .waitForFunction(() => document.querySelector('.welcome-text')?.textContent?.includes('used') ?? false, null, { timeout: 15_000 })
    .then(() => true, () => false)
  check('a code works once', refused)
  await three.click('button:has-text("Carry on without it")')
  await three.waitForSelector('input[aria-label="Your name"]', { timeout: 10_000 })

  // ---- a fresh link, opened ----
  const second = await makeLink(ana)
  await three.goto(second.link)
  await three.waitForURL((url) => !url.hash, { timeout: 20_000 }).catch(() => undefined)
  await wait(1500)
  const asThree = await whoIs(three)
  check('opening the link does it in one go', asThree.name === 'Ana' && asThree.id === her.id && asThree.spaces.includes('linked'), JSON.stringify(asThree))

  const nothing = await fetch('http://localhost:8787/api/v1/links/' + '0'.repeat(32))
  check('a link nobody left is not there', nothing.status === 404, String(nothing.status))
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
