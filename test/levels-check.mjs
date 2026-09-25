/**
 * Levels, the colour of names, and emoji said on their own.
 *
 *   emoji        a message of only emoji is drawn large, and so is a reply of
 *                one; a word beside it keeps it text
 *   text         what people write is a size up from the rest
 *   levels       Alice, the owner, makes a level with a colour and a power
 *                in Settings, and puts Bob on it from his menu
 *   colour       Bob's name is in that colour, for Alice and for Bob, in the
 *                conversation and in the list of people
 *   powers       Bob can pin now, and still cannot change the levels
 *
 *   node test/levels-check.mjs     with test/stack.mjs running
 */

import { chromium } from 'playwright-core'
import { nameEveryone } from './named.mjs'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BOX = '[aria-label="Write a message"]'
const TEAL = 'rgb(46, 196, 182)'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = nameEveryone(await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1' }))

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('cathode.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

async function say(page, text) {
  await page.click(BOX)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
}

/** The class and size of each message's text, newest last. */
const lines = (page) =>
  page.$$eval('.chat-line', (els) =>
    els.map((e) => {
      const text = e.querySelector('.chat-text')
      return {
        text: text?.textContent ?? '',
        jumbo: text?.classList.contains('jumbo') ?? false,
        size: text ? getComputedStyle(text).fontSize : '',
        reply: !!e.querySelector('.chat-reply'),
      }
    }),
  )

const openSettings = (page) => page.evaluate(() => document.querySelector('button[aria-label="Settings"]').click())

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'levels')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(1000)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForFunction(() => document.querySelector('.space-name')?.textContent === 'levels', null, { timeout: 60_000 })

  // ---- emoji and text ----
  await say(alice, '😀')
  await say(alice, 'hi 😀')
  const said = await lines(alice)
  check('a message of one emoji is drawn large', said[0]?.jumbo === true, JSON.stringify(said[0]))
  check('a word beside it keeps it text', said[1]?.jumbo === false, JSON.stringify(said[1]))
  check('what people write is 16 pixels', said[1]?.size === '16px', said[1]?.size)

  await bob.waitForFunction(() => document.querySelectorAll('.chat-line').length >= 2, null, { timeout: 20_000 })
  const first = bob.locator('.chat-row').first().locator('button[aria-label="Reply"]')
  await first.evaluate((el) => el.focus())
  await first.click()
  await say(bob, '👍')
  const replied = (await lines(bob)).at(-1)
  check('a reply of one emoji is drawn large too', replied?.reply === true && replied.jumbo === true, JSON.stringify(replied))

  // ---- a level, made in Settings ----
  await openSettings(alice)
  await alice.waitForSelector('.levels')
  const names = await alice.$$eval('.levels .level-name', (els) => els.map((e) => e.textContent))
  check('the owner sees the levels of the space', names.join(',') === 'Owner,Admin,Moderator,Member', names.join(','))
  await alice.click('.levels button:has-text("New level")')
  await alice.waitForSelector('.level.open input[aria-label="The name of the level"]')
  await alice.fill('.level.open input[aria-label="The name of the level"]', 'Helpers')
  await alice.click('.level.open button[aria-label="Colour #2ec4b6"]')
  await alice.check('.level.open input[aria-label="Pin messages"]')
  await alice.click('.level.open button:text-is("Save")')
  await alice.waitForFunction(() => [...document.querySelectorAll('.levels .level-name')].some((e) => e.textContent === 'Helpers'))
  const helpers = await alice.$eval('.levels .level-name:text-is("Helpers")', (e) => getComputedStyle(e).color).catch(() => '')
  check('a new level has its name and colour', helpers === TEAL, helpers)
  await alice.click('button[aria-label="Close settings"]')

  // ---- Bob, put on it from his menu ----
  await alice.waitForSelector('button[aria-label="Actions for Bob"]', { timeout: 20_000 })
  await alice.click('button[aria-label="Actions for Bob"]')
  await alice.waitForSelector('.menu')
  const offered = await alice.$$eval('.menu .menu-item', (els) => els.map((e) => e.textContent ?? ''))
  check('his menu offers the levels', offered.some((t) => t.includes('Helpers')) && offered.some((t) => t.includes('Moderator')), offered.join(' | ').slice(0, 120))
  await alice.click('.menu .menu-item:has-text("Helpers")')
  await alice.waitForTimeout(1500)

  const colourFor = (page) =>
    page.evaluate(() => {
      const name = [...document.querySelectorAll('.chat-name')].find((e) => e.textContent === 'Bob')
      const row = [...document.querySelectorAll('.rail-person .truncate')].find((e) => e.textContent?.startsWith('Bob'))
      return { chat: name ? getComputedStyle(name).color : '', rail: row ? getComputedStyle(row).color : '' }
    })
  const forAlice = await colourFor(alice)
  check('Alice sees his name in the colour of the level, in the conversation', forAlice.chat === TEAL, forAlice.chat)
  check('and in the list of people', forAlice.rail === TEAL, forAlice.rail)
  const bobSees = await bob
    .waitForFunction(
      (teal) => {
        const name = [...document.querySelectorAll('.chat-name')].find((e) => e.textContent === 'Bob')
        return name && getComputedStyle(name).color === teal
      },
      TEAL,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  check('and so does Bob', bobSees)

  // ---- what the level lets him do ----
  const pin = await bob.$('.chat-row button[aria-label="Pin"], .chat-row button[aria-label="Unpin"]')
  check('Bob can pin now', pin !== null)
  await openSettings(bob)
  await bob.waitForSelector('.settings')
  check('but he cannot change the levels', (await bob.$('.levels')) === null)
  await bob.click('button[aria-label="Close settings"]')
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
