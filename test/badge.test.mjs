import { APP_URL, answer, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'

// The unread count goes on the tab's icon, and to the desktop app for its Dock or taskbar icon.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.addInitScript(() => {
    window.nookDesktop = { setBadge: (n, overlay) => ((window.badgeSeen = n), (window.overlaySeen = overlay)) }
  })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const favicon = (page) => page.$eval('link[rel~="icon"]', (l) => l.getAttribute('href'))
const badge = (page) => page.evaluate(() => window.badgeSeen ?? null)

async function say(page, text) {
  await page.click(BOX)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'badges')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  await alice.click('.rail-left button[title="Make a text channel"]')
  await answer(alice, 'elsewhere')
  await alice.click('.rail-left .rail-item:has-text("general")')

  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await bob.click('.rail-left .rail-item:has-text("elsewhere")')
  await wait(1500)
  check('nothing unread: the plain icon', !(await favicon(bob)).startsWith('data:'), await favicon(bob))
  check('and no count for the desktop app', (await badge(bob)) === 0, String(await badge(bob)))

  await say(alice, 'one')
  await say(alice, 'two')
  const two = await poll(async () => (await badge(bob)) === 2, 20_000)
  check('two unread messages: the desktop app is told 2', two, String(await badge(bob)))
  check('with a picture for the Windows taskbar', (await bob.evaluate(() => window.overlaySeen)).startsWith('data:image/png'))
  check('and the tab icon has the count on it', (await favicon(bob)).startsWith('data:image/png'))

  await bob.click('.rail-left .rail-item:has-text("general")')
  const cleared = await poll(async () => (await badge(bob)) === 0, 10_000)
  check('read: the count goes', cleared, String(await badge(bob)))
  check('and the tab icon is plain again', !(await favicon(bob)).startsWith('data:'), await favicon(bob))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
