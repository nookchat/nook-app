import { APP_URL, FAKE_MEDIA, check, finish, launch, stoppedEarly } from './harness.mjs'

// Headless Chrome will not bring a peer connection up without them, and two browsers here must reach each other.
const browser = await launch({ args: FAKE_MEDIA })

const BOX = '[aria-label="Write a message"]'
const REACT = '.chat-row button[aria-label="React to this message"]'

// The action bar is faded until hovered, so a test asks for it the way a keyboard does.
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
  await page.fill(BOX, text)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
}

const reactionsOn = (page) =>
  page.$$eval('.chat-react:not(.add)', (els) => els.map((e) => e.textContent.trim()))

try {
  const bare = await browser.newContext()
  const probe = await bare.newPage()
  await probe.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  const graphemes = await probe.evaluate(async () => {
    const { oneEmoji } = await import('/src/store/log.ts')
    return {
      plain: oneEmoji('🔥'),
      variation: oneEmoji('❤️'),
      flag: oneEmoji('🇬🇧'),
      tone: oneEmoji('👍🏽'),
      family: oneEmoji('👨‍👩‍👧‍👦'),
      firstOnly: oneEmoji('🔥🔥🔥'),
      trailing: oneEmoji('🔥 and some words'),
      empty: oneEmoji(''),
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

  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(APP_URL)
  await makeSpace(page, 'emoji')

  await page.fill(BOX, 'hello world')
  // Caret between the two words, so an insert at the end would be visible.
  await page.$eval(BOX, (el) => el.setSelectionRange(5, 5))
  await page.click('button[aria-label="Emoji"]')
  await page.waitForSelector('.emoji-pop')
  check('the picker opens from the compose box', true)

  await page.fill('.emoji-search', 'fire')
  await page.waitForTimeout(200)
  const hits = await page.$$eval('.emoji-cell', (els) => els.map((e) => e.textContent))
  check('searching finds by the word people would type', hits[0] === '🔥', hits.slice(0, 4).join(''))

  await page.click('.emoji-cell')
  const typed = await page.inputValue(BOX)
  check('picking one drops it where the caret was', typed === 'hello🔥 world', typed)

  const caret = await page.$eval(BOX, (el) => el.selectionStart)
  check('and the caret lands after it', caret === 7, `${caret}`)

  await page.click('.emoji-cell')
  const twice = await page.inputValue(BOX)
  check('it stays open for a second one', twice === 'hello🔥🔥 world', twice)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  check('escape closes it', (await page.$('.emoji-pop')) === null)

  await page.fill(BOX, '')
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

  await pressAction(page, REACT)
  await page.click('.emoji-pop.quick .chat-react')
  await page.waitForTimeout(700)
  check('the same one again takes it back', (await reactionsOn(page)).length === 0)

  await pressAction(page, REACT)
  await page.click('.emoji-pop.quick button[aria-label="All emoji"]')
  await page.waitForSelector('.emoji-pop:not(.quick)')
  await page.fill('.emoji-search', 'thumbs up')
  await page.waitForTimeout(200)
  await page.click('.emoji-cell')
  await page.waitForTimeout(700)
  await page.keyboard.press('Escape')
  check('the whole set is one click further on', (await reactionsOn(page)).join() === '👍 1', (await reactionsOn(page)).join())

  // The second cell, because the first is the one already on the message and would take it back.
  await page.click('.chat-react.add')
  await page.waitForSelector('.emoji-pop.quick')
  await page.locator('.emoji-pop.quick .chat-react').nth(1).click()
  await page.waitForTimeout(700)
  const two = await reactionsOn(page)
  check('a different one sits beside the first', two.length === 2, two.join(' '))

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

  await page.fill(BOX, '')
  await page.click(BOX)
  await page.keyboard.type('so :lau')
  const offered = await page.waitForSelector('.emoji-option', { timeout: 5000 }).then(() => page.$$eval('.emoji-option', (els) => els.map((e) => e.dataset.emoji)), () => [])
  check('typing :lau offers the emoji it could be', offered.includes('😆'), offered.join(' '))
  await page.keyboard.press('Tab')
  const took = await page.inputValue(BOX)
  check('and Tab takes the first', took === 'so 😆', took)
  await page.keyboard.type(' and :fire:')
  const swapped = await page.inputValue(BOX)
  check('a finished :name: turns into its emoji as it is typed', swapped === 'so 😆 and 🔥', swapped)
  await page.fill(BOX, 'party :tada: but not `:tada:`')
  await page.keyboard.press('Enter')
  const sent = await page
    .waitForFunction(() => [...document.querySelectorAll('.chat-text')].map((e) => e.textContent).find((t) => t.startsWith('party')), null, { timeout: 10_000 })
    .then((h) => h.jsonValue(), () => '')
  check('one left as typed goes as its emoji, and code stays code', sent === 'party 🎉 but not :tada:', sent)

  const toggles = async (button, pop) => {
    await page.click(button)
    const opened = !!(await page.waitForSelector(pop, { timeout: 5000 }).catch(() => null))
    await page.click(button)
    await page.waitForTimeout(300)
    return opened && (await page.$(pop)) === null
  }
  check('the emoji button opens the picker, and closes it on the next press', await toggles('button[aria-label="Emoji"]', '.emoji-pop'))
  check('and so does the GIF button', await toggles('button[aria-label="Find a GIF"]', '.gif-pop'))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
