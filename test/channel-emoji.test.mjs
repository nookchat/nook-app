import { APP_URL, check, finish, launch, makeSpace, poll, stoppedEarly } from './harness.mjs'

// Somebody who keeps the channels gives one an emoji, which shows in place of its mark, and takes it away again.
const browser = await launch()
const emojis = (page) => page.$$eval('.channel-emoji', (els) => els.map((e) => e.textContent ?? ''))

async function setEmoji(page, row, search) {
  await page.click(row, { button: 'right' })
  await page.click('.menu-item:has-text("Set an emoji")')
  await page.waitForSelector('.emoji-pop')
  await page.keyboard.type(search)
  await page.locator('.emoji-pop .emoji-cell:visible').first().click()
}

try {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL)
  await page.evaluate(() => localStorage.setItem('nook.name.v1', 'Alice'))
  await page.reload()
  await makeSpace(page, 'Airsoft')
  await page.waitForSelector('[aria-label="Write a message"]')

  await setEmoji(page, '.rail-left .rail-item:has-text("general")', 'gun')
  const rail = await poll(() => page.evaluate(() => document.querySelector('.rail-left .channel-emoji')?.textContent ?? ''), 5000)
  check('a search for gun finds the pistol, and the channel wears it', rail === '🔫', rail)
  const head = await page.evaluate(() => document.querySelector('.channel-name .channel-emoji')?.textContent ?? '')
  check('so does the channel head', head === '🔫', head)

  await setEmoji(page, '.voice-channel .rail-item:has-text("lounge")', 'speaker')
  await poll(async () => (await emojis(page)).length === 3, 5000)
  await page.reload()
  const after = await poll(async () => {
    const list = await emojis(page)
    return list.length === 3 ? list : null
  }, 15_000)
  check('a voice channel takes one too, and both stay after a reload', after?.[0] === '🔫' && after?.[2] === '🔫', JSON.stringify(after))

  await page.click('.rail-left .rail-item:has-text("general")', { button: 'right' })
  await page.click('.menu-item:has-text("Take the emoji away")')
  const gone = await poll(async () => (await emojis(page)).length === 1, 5000)
  check('taking it away brings the mark back', gone, JSON.stringify(await emojis(page)))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
