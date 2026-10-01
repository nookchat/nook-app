import { APP_URL, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

// The desktop app says when you look at its window. Put away in the tray, the page can still read
// as visible, as it does on Windows: what decides a notification is what the app says. While you
// are away, what would notify you counts up on the app's icon, and the channel on screen is not
// read; back at the window, the count goes to none and the channel is read.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'

async function person(name, desktop) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.grantPermissions(['notifications'], { origin: new URL(APP_URL).origin })
  if (desktop) {
    await context.addInitScript(() => {
      window.__shown = []
      window.__badges = []
      const Real = Notification
      window.Notification = class extends Real {
        constructor(title, options) {
          super(title, options)
          window.__shown.push(`${title}: ${options?.body ?? ''}`)
        }
      }
      Object.defineProperty(window.Notification, 'permission', { get: () => Real.permission })
      let looking = true
      const told = []
      window.__look = (now) => {
        looking = now
        for (const fn of told) fn(now)
      }
      window.nookDesktop = {
        platform: 'win32',
        looking: () => looking,
        onLooking: (fn) => {
          told.push(fn)
          return () => undefined
        },
        setBadge: (count) => window.__badges.push(count),
      }
    })
  }
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const badge = (page) => page.evaluate(() => window.__badges.at(-1) ?? 0)
const shown = (page) => page.evaluate(() => window.__shown.length)
const readMark = (page) => page.evaluate(async () => {
  const { spaces } = await import('/src/space/registry.ts')
  return spaces.all()[0].note?.read?.general ?? 0
})

try {
  const alice = await person('Alice', false)
  await alice.fill('input[aria-label="Space name"]', 'away')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const bob = await person('Bob', true)
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await alice.fill(BOX, 'hello first')
  await alice.press(BOX, 'Enter')
  await bob.waitForSelector('text=hello first')

  // Bob puts the window in the tray. The page itself still says it is visible and in front.
  await bob.bringToFront()
  await bob.evaluate(() => window.__look(false))
  check('the page alone would say Bob is looking', await bob.evaluate(() => !document.hidden))
  const before = await readMark(bob)

  await alice.fill(BOX, '@Bob are you there')
  await alice.press(BOX, 'Enter')
  check('a mention while away shows a notification', await poll(async () => (await shown(bob)) === 1, 10_000), String(await shown(bob)))
  check('and counts one on the icon', await poll(async () => (await badge(bob)) === 1, 3000), String(await badge(bob)))

  await alice.fill(BOX, '@Bob hello?')
  await alice.press(BOX, 'Enter')
  check('a second one counts two', await poll(async () => (await badge(bob)) === 2, 10_000), String(await badge(bob)))
  check('the channel on screen is not read while away', (await readMark(bob)) === before)

  await bob.evaluate(() => window.__look(true))
  check('back at the window, the count goes to none', await poll(async () => (await badge(bob)) === 0, 3000), String(await badge(bob)))
  check('and the channel is read', await poll(async () => (await readMark(bob)) > before, 5000))

  await alice.fill(BOX, '@Bob while you look')
  await alice.press(BOX, 'Enter')
  await bob.waitForSelector('text=while you look')
  await bob.waitForTimeout(800)
  check('while looking, a mention shows no notification and counts nothing', (await shown(bob)) === 2 && (await badge(bob)) === 0, `${await shown(bob)} ${await badge(bob)}`)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}
finish()
