import { APP_URL, check, finish, HOME, launch, makeSpace, poll, stoppedEarly, wait } from './harness.mjs'

// A text channel marked Media only: a message needs a picture, a video or a file, what was said
// before stays, whoever keeps the channels still writes words, and the mark comes off.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'
const DRAWING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="red"/></svg>'

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector(HOME)
  return page
}

async function say(page, text) {
  await page.fill(BOX, text)
  await page.press(BOX, 'Enter')
}

const lines = (page, text) => page.locator(`.chat-log .chat-line:has-text("${text}")`).count()

try {
  const alice = await person('Alice')
  await makeSpace(alice, 'Memes Only')
  await alice.waitForSelector(BOX)

  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await wait(1500)
  await say(bob, 'said before the mark')
  await alice.waitForSelector('.chat-line:has-text("said before the mark")')

  await alice.click('.rail-left .rail-row:has-text("general")', { button: 'right' })
  await alice.click('.menu-item:has-text("Media only")')
  const marked = await poll(() => bob.evaluate(() => document.querySelector('[aria-label="Write a message"]')?.placeholder.includes('picture')), 15_000)
  check('a channel marked Media only asks for a picture in the box', marked)
  check('what was said before stays', (await lines(bob, 'said before the mark')) === 1)

  await say(bob, 'only words here')
  const warned = await poll(() => bob.$$eval('.toast', (els) => els.some((t) => t.textContent.includes('Only pictures'))), 5000)
  check('words alone are not sent, and it says why', warned)
  check('and they stay in the box', (await bob.inputValue(BOX)) === 'only words here')

  // A device that skips the box's check: every device keeps its words out of sight anyway.
  await bob.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    await spaces.all()[0].chat.say('words past the box', 'general')
  })
  await wait(2500)
  check('words sent around the box show for nobody', (await lines(alice, 'words past the box')) + (await lines(bob, 'words past the box')) === 0)

  await say(bob, DRAWING)
  const drawn = await poll(async () => (await alice.locator('.chat-log .chat-image-wrap').count()) === 1, 15_000)
  check('a picture goes', drawn)

  await say(alice, 'the rules, from the owner')
  const rules = await poll(async () => (await lines(bob, 'the rules, from the owner')) === 1, 15_000)
  check('whoever keeps the channels still writes words', rules)

  await alice.click('.rail-left .rail-row:has-text("general")', { button: 'right' })
  await alice.click('.menu-item:has-text("Allow words again")')
  const open = await poll(() => bob.evaluate(() => document.querySelector('[aria-label="Write a message"]')?.placeholder === 'Say something'), 15_000)
  check('the mark comes off', open)
  await bob.fill(BOX, '')
  await say(bob, 'words are back')
  const back = await poll(async () => (await lines(alice, 'words are back')) === 1, 15_000)
  check('and words go again', back)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
