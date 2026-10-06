import { APP_URL, check, finish, HOME, launch, makeSpace, poll, stoppedEarly } from './harness.mjs'

// A start shows the messages this device kept, before the server answers, and says it is still updating.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'
const texts = (page) => page.$$eval('.chat-line .chat-text', (els) => els.map((e) => e.textContent ?? ''))

try {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL)
  await page.evaluate(() => localStorage.setItem('nook.name.v1', 'Alice'))
  await page.reload()
  await makeSpace(page, 'Kept Here')
  await page.waitForSelector(BOX)
  await page.click(BOX)
  await page.keyboard.type('remember me')
  await page.keyboard.press('Enter')
  await poll(async () => (await texts(page)).includes('remember me'), 10_000)
  // The copy is written a moment after the lines come.
  await page.waitForTimeout(2500)

  // From here no socket reaches a server: only the copy on this device can show anything.
  await page.routeWebSocket(/.*/, () => {})
  await page.reload()
  const shown = await poll(async () => (await texts(page)).includes('remember me'), 15_000)
  check('the kept messages show with no server answering', shown, JSON.stringify(await texts(page)))
  const syncing = await page.evaluate(() => !!document.querySelector('.space-grid.syncing'))
  check('it says it is still updating', syncing)

  // With the server back, the rest comes, the line goes, and nothing shows twice.
  const back = await page.context().newPage()
  await back.goto(APP_URL)
  await back.waitForSelector(BOX, { timeout: 20_000 })
  const done = await poll(
    async () => (await texts(back)).length > 0 && !(await back.evaluate(() => !!document.querySelector('.space-grid.syncing'))),
    20_000,
  )
  check('the line goes once the server has sent the rest', done)
  check('a message shows once', (await texts(back)).filter((t) => t === 'remember me').length === 1, JSON.stringify(await texts(back)))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
