import { answer, APP_URL, check, finish, HOME, launch, makeSpace, poll, stoppedEarly } from './harness.mjs'

// A reload, an update or a restart of the desktop app opens the screen you were on.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'
const channelShown = (page) => page.evaluate(() => document.querySelector('.space-head .channel-name')?.textContent ?? '')

try {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL)
  await page.evaluate(() => localStorage.setItem('nook.name.v1', 'Alice'))
  await page.reload()
  await makeSpace(page, 'Back Again')
  await page.waitForSelector(BOX)
  await page.click('.rail-left button[title="Make a text channel"]')
  await answer(page, 'design')
  await poll(async () => (await channelShown(page)) === 'design', 10_000)

  await page.reload()
  await page.waitForSelector(BOX)
  const afterReload = await poll(async () => (await channelShown(page)) === 'design', 15_000)
  check('a reload comes back to the channel, not general', afterReload, await channelShown(page))

  // The desktop app opens its home address after a restart, with no space in it.
  await page.goto(APP_URL)
  await page.waitForSelector(BOX, { timeout: 15_000 })
  const afterRestart = await poll(async () => (await channelShown(page)) === 'design', 15_000)
  check('a restart comes back to the space and the channel', afterRestart, await channelShown(page))

  await page.click('.space-title-button')
  await page.click('.menu-item:has-text("Home")').catch(() => page.click('button[aria-label="Home"]'))
  await page.waitForSelector(HOME, { timeout: 10_000 })
  await page.goto(APP_URL)
  await page.waitForTimeout(3000)
  check('and home, if that is where you were', await page.evaluate(() => !!document.querySelector('button.new-space')))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
