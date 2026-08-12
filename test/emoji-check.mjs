/**
 * The emoji picker, and what a reaction is made of.
 *
 * Two halves. The picker: does it open where it was asked to, does searching
 * find things, does picking put the emoji where the caret was, and does it
 * remember what you use. And the rule underneath: a reaction is one character
 * to a reader and often several to a computer, so the thing that comes out has
 * to be the thing that went in, on every device, without asking the browser.
 *
 *   node test/emoji-check.mjs
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  // Headless Chrome will not bring a peer connection up without them, and the
  // last check here needs two browsers to actually reach each other.
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})

const REACT = '.chat-row button[aria-label="React to this message"]'

/** The action bar is faded until hovered, so a test asks for it the way a keyboard does. */
async function pressAction(page, selector) {
  await page.$eval(selector, (el) => el.focus())
  await page.click(selector)
}

async function makeSpace(page, name) {
  await page.waitForSelector('input[aria-label="Space name"]')
  await page.fill('input[aria-label="Space name"]', name)
  await page.click('button:has-text("New space")')
  await page.waitForSelector('.space-name')
  await page.waitForTimeout(1200)
}

async function say(page, text) {
  await page.fill('[aria-label="Write a message"]', text)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
}

const reactionsOn = (page) =>
  page.$$eval('.chat-react:not(.add)', (els) => els.map((e) => e.textContent.trim()))

try {
  // ---- the rule underneath -------------------------------------------------
  const bare = await browser.newContext()
  const probe = await bare.newPage()
  await probe.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  const graphemes = await probe.evaluate(async () => {
    const { oneEmoji } = await import('/src/store/log.ts')
    return {
      plain: oneEmoji('🔥'),
      // A heart is a heart plus a request to draw it in colour.
      variation: oneEmoji('❤️'),
      // Two regional letters are one flag.
      flag: oneEmoji('🇬🇧'),
      // Skin tone rides along with the hand it belongs to.
      tone: oneEmoji('👍🏽'),
      // Four people and three joiners are one family.
      family: oneEmoji('👨‍👩‍👧‍👦'),
      // Only the first, whatever follows it.
      firstOnly: oneEmoji('🔥🔥🔥'),
      trailing: oneEmoji('🔥 and some words'),
      // Nothing sane comes out of nothing.
      empty: oneEmoji(''),
      // A pathological chain of joiners cannot grow without bound.
      capped: oneEmoji('👨' + '‍👩'.repeat(40)).length <= 32,
    }
  })
  check('one emoji is one emoji', graphemes.plain === '🔥' && graphemes.firstOnly === '🔥')
  check('a variation selector stays with its character', graphemes.variation === '❤️')
  check('a flag is not cut in half', graphemes.flag === '🇬🇧', graphemes.flag)
  check('a skin tone stays on the hand', graphemes.tone === '👍🏽', graphemes.tone)
  check('a family stays a family', graphemes.family === '👨‍👩‍👧‍👦', graphemes.family)
  check('words after an emoji are not part of it', graphemes.trailing === '🔥')
  check('nothing in, nothing out', graphemes.empty === '')
  check('a chain of joiners cannot grow for ever', graphemes.capped === true)
  await bare.close()

  // ---- the picker ----------------------------------------------------------
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(APP_URL)
  await makeSpace(page, 'emoji')

  await page.fill('[aria-label="Write a message"]', 'hello world')
  // Caret between the two words, so an insert at the end would be visible.
  await page.$eval('[aria-label="Write a message"]', (el) => el.setSelectionRange(5, 5))
  await page.click('button[aria-label="Emoji"]')
  await page.waitForSelector('.emoji-pop')
  check('the picker opens from the compose box', true)

  await page.fill('.emoji-search', 'fire')
  await page.waitForTimeout(200)
  const hits = await page.$$eval('.emoji-cell', (els) => els.map((e) => e.textContent))
  check('searching finds by the word people would type', hits[0] === '🔥', hits.slice(0, 4).join(''))

  await page.click('.emoji-cell')
  const typed = await page.inputValue('[aria-label="Write a message"]')
  check('picking one drops it where the caret was', typed === 'hello🔥 world', typed)

  const caret = await page.$eval('[aria-label="Write a message"]', (el) => el.selectionStart)
  check('and the caret lands after it', caret === 7, `${caret}`)

  // The picker stays open, so several can be picked in a row.
  await page.click('.emoji-cell')
  const twice = await page.inputValue('[aria-label="Write a message"]')
  check('it stays open for a second one', twice === 'hello🔥🔥 world', twice)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  check('escape closes it', (await page.$('.emoji-pop')) === null)

  // ---- reacting ------------------------------------------------------------
  await page.fill('[aria-label="Write a message"]', '')
  await say(page, 'react to this')

  await pressAction(page, REACT)
  await page.waitForSelector('.emoji-pop.quick')
  const quick = await page.$$eval('.emoji-pop.quick .chat-react', (els) =>
    els.map((e) => e.textContent),
  )
  check('the quick row leads with what was just used', quick[0] === '🔥', quick.join(''))

  await page.click('.emoji-pop.quick .chat-react')
  await page.waitForTimeout(700)
  check('one click reacts', (await reactionsOn(page)).join() === '🔥 1', (await reactionsOn(page)).join())

  // The same one again takes it back.
  await pressAction(page, REACT)
  await page.click('.emoji-pop.quick .chat-react')
  await page.waitForTimeout(700)
  check('the same one again takes it back', (await reactionsOn(page)).length === 0)

  // The whole set, from the message.
  await pressAction(page, REACT)
  await page.click('.emoji-pop.quick button[aria-label="All emoji"]')
  await page.waitForSelector('.emoji-pop:not(.quick)')
  await page.fill('.emoji-search', 'thumbs up')
  await page.waitForTimeout(200)
  await page.click('.emoji-cell')
  await page.waitForTimeout(700)
  await page.keyboard.press('Escape')
  check('the whole set is one click further on', (await reactionsOn(page)).join() === '👍 1', (await reactionsOn(page)).join())

  // A second one from the plus on the end of the row. The second cell, because
  // the first is the one already on the message and would take it back.
  await page.click('.chat-react.add')
  await page.waitForSelector('.emoji-pop.quick')
  await page.locator('.emoji-pop.quick .chat-react').nth(1).click()
  await page.waitForTimeout(700)
  const two = await reactionsOn(page)
  check('a different one sits beside the first', two.length === 2, two.join(' '))

  // ---- it is remembered, and it travels -----------------------------------
  await page.reload()
  await page.waitForSelector('.chat-line')
  await page.waitForTimeout(1500)
  const kept = await reactionsOn(page)
  check('reactions survive a reload', kept.length === 2, kept.join(' '))

  await page.click('button[aria-label="Emoji"]')
  await page.waitForSelector('.emoji-pop')
  const recentHead = await page.$eval('.emoji-head', (el) => el.textContent)
  check('the picker remembers what this person uses', recentHead === 'Recent', recentHead)
  await page.keyboard.press('Escape')

  const link = page.url()
  const other = await (await browser.newContext()).newPage()
  await other.goto(link)
  const arrived = await other
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.chat-react:not(.add)')].map((e) => e.textContent.trim())
          .length === 2,
      null,
      { timeout: 60_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('and everybody else sees them', arrived, (await reactionsOn(other)).join(' '))
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
}

await browser.close()

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
