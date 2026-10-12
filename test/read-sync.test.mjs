import { APP_URL, answer, check, finish, launch, makeSpace, poll, stoppedEarly } from './harness.mjs'

// A channel read on one of your devices is read on the others too, with no reload.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'
const unread = (page, name) =>
  page.evaluate((n) => [...document.querySelectorAll('.rail-left .rail-item.unread')].some((e) => e.textContent?.includes(n)), name)

try {
  const one = await (await browser.newContext()).newPage()
  await one.goto(APP_URL)
  await one.evaluate(() => localStorage.setItem('nook.name.v1', 'Alice'))
  await one.reload()
  await makeSpace(one, 'two devices')
  await one.waitForSelector(BOX)
  await one.click('button[title="Make a text channel"]')
  await answer(one, 'news')
  await one.waitForSelector('.rail-left .rail-item:has-text("news")')
  await one.click('.rail-left .rail-item:has-text("general")')
  const link = one.url()
  // Saved to the server, so the second device has the space.
  await one.waitForTimeout(3000)

  // The same person on a second device: the same identity, kept in the browser.
  const two = await (await browser.newContext({ storageState: await one.context().storageState() })).newPage()
  await two.goto(link)
  await two.waitForSelector(BOX, { timeout: 30_000 })
  await two.click('.rail-left .rail-item:has-text("general")')

  const bob = await (await browser.newContext()).newPage()
  await bob.goto(APP_URL)
  await bob.evaluate(() => localStorage.setItem('nook.name.v1', 'Bob'))
  await bob.goto(link)
  await bob.waitForSelector(BOX, { timeout: 60_000 })
  await bob.click('.rail-left .rail-item:has-text("news")')
  await bob.click(BOX)
  await bob.keyboard.type('fresh news')
  await bob.keyboard.press('Enter')

  const both = await poll(async () => (await unread(one, 'news')) && (await unread(two, 'news')), 20_000)
  check('both devices show news as unread', both)

  await one.bringToFront()
  await one.click('.rail-left .rail-item:has-text("news")')
  await one.click('.rail-left .rail-item:has-text("general")')
  // The second device comes into view, as when you pick it up.
  await two.bringToFront()
  await two.evaluate(() => window.dispatchEvent(new Event('focus')))
  const read = await poll(async () => {
    await two.evaluate(() => window.dispatchEvent(new Event('focus')))
    return !(await unread(two, 'news'))
  }, 20_000, 1000)
  check('read on the first device, it is read on the second', read)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
