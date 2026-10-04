import { APP_URL, FAKE_MEDIA, answer, check, finish, launch, makeSpace, stoppedEarly, wait } from './harness.mjs'

// The side bars are drawn again on every change: somebody arriving, writing, or going into voice.
// A row that did not change stays the same element, so the one under the pointer keeps its hover
// and does not flash. Only the rows that changed are made anew.
const browser = await launch({ args: FAKE_MEDIA })
try {
  const ada = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await ada.goto(APP_URL)
  await makeSpace(ada, 'Hover')
  await ada.waitForSelector('[aria-label="Write a message"]')
  await ada.click('.rail-left button[title="Make a text channel"]')
  await answer(ada, 'random')
  await ada.click('.space-title-button')
  await ada.click('.menu-item:has-text("Invite")')
  const box = ada.locator('.share-code')
  await box.waitFor({ timeout: 15_000 })
  const link = await box.getAttribute('data-link')
  await ada.keyboard.press('Escape')

  const bo = await (await browser.newContext()).newPage()
  await bo.goto(link)
  await bo.waitForSelector('[aria-label="Write a message"]', { timeout: 30_000 })
  await wait(2000)

  // Ada rests the pointer on #random; each row is marked, to see which are the same after.
  const row = await ada.locator('.rail-left .rail-item:has-text("random")').boundingBox()
  await ada.mouse.move(row.x + row.width / 2, row.y + row.height / 2)
  await ada.evaluate(() => {
    const rows = [...document.querySelectorAll('.rail-left .rail-row, .rail-left .voice-head, .rail-right .rail-person')]
    window.__rows = rows
    window.__hovered = document.querySelector('.rail-item:hover')
  })
  const same = () =>
    ada.evaluate(() => ({
      hovered: window.__hovered?.isConnected === true && window.__hovered.matches(':hover'),
      kept: window.__rows.filter((r) => r.isConnected).length,
      all: window.__rows.length,
    }))

  await bo.click('[aria-label="Write a message"]')
  await bo.keyboard.type('hello')
  await bo.keyboard.press('Enter')
  await ada.waitForSelector('.rail-left .rail-item.unread:has-text("general")', { timeout: 15_000 })
  await wait(500)
  const afterMessage = await same()
  check('a message from somebody else keeps the row under the pointer', afterMessage.hovered)
  // #general shows it unread now, and is the one row made anew.
  check('and every row but the one that changed', afterMessage.kept === afterMessage.all - 1, `${afterMessage.kept} of ${afterMessage.all}`)

  await bo.click('.voice-channel .rail-item:has-text("lounge")', { timeout: 15_000 })
  await ada.waitForSelector('.voice-member', { timeout: 15_000 })
  await wait(3000)
  const afterVoice = await same()
  check('somebody going into voice keeps the row under the pointer', afterVoice.hovered)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
