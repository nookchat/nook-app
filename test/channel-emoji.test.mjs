import { APP_URL, check, closeSettings, editChannel, finish, launch, makeSpace, poll, stoppedEarly } from './harness.mjs'

// A channel's menu has Edit channel, which opens one page for its name, emoji, topic, who gets in,
// and delete. An emoji given there shows in place of the channel's mark.
const browser = await launch()
const emojis = (page) => page.$$eval('.channel-emoji', (els) => els.map((e) => e.textContent ?? ''))

async function setEmoji(page, row, search, save = true) {
  await editChannel(page, row)
  await page.click('.channel-face')
  await page.waitForSelector('.emoji-pop')
  await page.keyboard.type(search)
  await page.locator('.emoji-pop .emoji-cell:visible').first().click()
  if (save) await page.click('button:text-is("Save changes")')
}

try {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL)
  await page.evaluate(() => localStorage.setItem('nook.name.v1', 'Alice'))
  await page.reload()
  await makeSpace(page, 'Airsoft')
  await page.waitForSelector('[aria-label="Write a message"]')

  await page.click('.rail-left .rail-item:has-text("general")', { button: 'right' })
  const menu = await page.$$eval('.menu-item', (els) => els.map((e) => e.textContent?.trim() ?? ''))
  check('the menu keeps editing to one item', menu.some((t) => t.startsWith('Edit channel')) && !menu.some((t) => /Rename|topic|NSFW|Media only|Delete/.test(t)), JSON.stringify(menu))
  await page.keyboard.press('Escape')

  await setEmoji(page, '.rail-left .rail-item:has-text("general")', 'gun', false)
  await page.fill('input[aria-label="Topic"]', 'Games this weekend')
  await page.click('button:text-is("Save changes")')
  await closeSettings(page)
  const rail = await poll(() => page.evaluate(() => document.querySelector('.rail-left .channel-emoji')?.textContent ?? ''), 5000)
  check('a search for gun finds the pistol, and the channel wears it', rail === '🔫', rail)
  const head = await page.evaluate(() => document.querySelector('.channel-name .channel-emoji')?.textContent ?? '')
  check('so does the channel head', head === '🔫', head)
  const topic = await page.evaluate(() => document.querySelector('.channel-topic')?.textContent ?? '')
  check('and the topic saved on the same page shows', topic === 'Games this weekend', topic)

  await setEmoji(page, '.voice-channel .voice-head:has-text("lounge")', 'speaker')
  await closeSettings(page)
  await poll(async () => (await emojis(page)).length === 3, 5000)
  await page.reload()
  const after = await poll(async () => {
    const list = await emojis(page)
    return list.length === 3 ? list : null
  }, 15_000)
  check('a voice channel takes one too, and both stay after a reload', after?.[0] === '🔫' && after?.[2] === '🔫', JSON.stringify(after))

  await editChannel(page, '.rail-left .rail-item:has-text("general")')
  await page.click('button:text-is("Take it away")')
  await page.click('button:text-is("Save changes")')
  await closeSettings(page)
  const gone = await poll(async () => (await emojis(page)).length === 1, 5000)
  check('taking it away brings the mark back', gone, JSON.stringify(await emojis(page)))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
