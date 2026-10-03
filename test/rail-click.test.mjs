import { answer, APP_URL, check, finish, launch, makeSpace, stoppedEarly } from './harness.mjs'

// A side bar is drawn anew on every change: somebody typing, arriving, or talking. One drawn
// between the press and the release used to take the click with it, and it took a second one.
const browser = await launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(APP_URL)
  await makeSpace(page, 'Clicks')
  await page.waitForSelector('[aria-label="Write a message"]')
  await page.click('.rail-left button[title="Make a text channel"]')
  await answer(page, 'random')
  await page.click('.rail-left .rail-item:has-text("general")')
  await page.waitForTimeout(500)

  // Pressed on random, then the list is drawn again, then released.
  const row = await page.locator('.rail-left .rail-item:has-text("random")').boundingBox()
  await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2)
  await page.mouse.down()
  await page.evaluate(() => window.dispatchEvent(new Event('nook:playing')))
  await page.waitForTimeout(150)
  await page.mouse.up()
  const opened = await page
    .waitForFunction(() => document.querySelector('.channel-name')?.textContent.includes('random'), null, { timeout: 3000 })
    .then(() => true, () => false)
  check('one click opens a channel, even when the list is drawn again during it', opened)

  // And once the click is in, the list catches up.
  const lit = await page.waitForFunction(() => document.querySelector('.rail-left .rail-item.on')?.textContent.includes('random'), null, { timeout: 3000 }).then(() => true, () => false)
  check('and the list shows it open after', lit)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
