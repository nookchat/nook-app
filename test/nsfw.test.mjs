import { APP_URL, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'

// A text channel marked NSFW: its pictures are blurred for everybody until each is clicked,
// and the mark comes off again.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'
const DRAWING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="red"/></svg>'

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

async function say(page, text) {
  await page.fill(BOX, text)
  await page.press(BOX, 'Enter')
}

const blurred = (page) =>
  page.evaluate(() => {
    const img = [...document.querySelectorAll('.chat-log .chat-image-wrap > .chat-image')].pop()
    return img ? getComputedStyle(img).filter.includes('blur') : null
  })

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'Careful Now')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)

  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await wait(1500)

  await alice.click('.rail-left .rail-row:has-text("general")', { button: 'right' })
  await alice.click('.menu-item:has-text("Mark as NSFW")')
  const marked = await poll(async () => (await bob.locator('.rail-left .rail-item:has-text("general") .nsfw-mark').count()) === 1, 15_000)
  check('a channel marked NSFW says so in the list, for everybody', marked)
  check('and in the channel head', (await bob.locator('.channel-name .nsfw-mark').count()) === 1)

  await say(alice, DRAWING)
  await bob.waitForSelector('.chat-log .chat-image-wrap', { timeout: 15_000 })
  check('a picture in it comes blurred', (await blurred(bob)) === true)
  check('for whoever sent it too', (await blurred(alice)) === true)

  await bob.locator('.chat-log .chat-image-wrap').last().click()
  check('a click shows it', (await blurred(bob)) === false)
  check('and opens nothing else', (await bob.locator('.lightbox, [class*="lightbox"]').count()) === 0)
  check('only for the one who clicked', (await blurred(alice)) === true)
  await say(alice, 'and some words')
  await bob.waitForSelector('.chat-line:has-text("and some words")')
  check('it stays shown while the conversation goes on', (await blurred(bob)) === false)

  await alice.click('.rail-left .rail-row:has-text("general")', { button: 'right' })
  await alice.click('.menu-item:has-text("Stop marking as NSFW")')
  const unmarked = await poll(async () => (await bob.locator('.nsfw-mark').count()) === 0, 15_000)
  check('the mark comes off', unmarked)
  check('and the pictures show straight away again', (await blurred(alice)) === false)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
