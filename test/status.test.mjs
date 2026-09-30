import { APP_URL, FAKE_MEDIA, answer, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

// Your status: online, idle, do not disturb or invisible, and a few words of your own. The others
// see it in the list of people. Do not disturb stops notifications and message sounds.
const browser = await launch({ args: FAKE_MEDIA })
const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

async function pick(page, label) {
  await page.click('.me-who')
  await page.click(`.menu-item:has-text("${label}")`)
}

const aliceRow = (page) => page.locator('.rail-person:has-text("Alice")')
const dotOf = (page) => aliceRow(page).locator('.person-face > .dot').getAttribute('class')

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'status')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await aliceRow(bob).waitFor({ timeout: 15_000 })

  check('somebody here starts online', /\bgood\b/.test(await dotOf(bob)))

  await pick(alice, 'Do not disturb')
  check('your own dot shows your status', await poll(async () => /\bbad\b/.test(await alice.locator('.me-face > .dot').getAttribute('class')), 5000))
  check('the others see do not disturb', await poll(async () => /\bbad\b/.test(await dotOf(bob)), 10_000))
  const quiet = await alice.evaluate(async () => (await import('/src/store/status.ts')).doNotDisturb())
  check('do not disturb stops notifications and message sounds', quiet)

  await pick(alice, 'Say what you are up to')
  await answer(alice, 'Out for lunch')
  check('the others see your words under your name', await poll(async () => (await aliceRow(bob).textContent()).includes('Out for lunch'), 10_000))

  await pick(alice, 'Invisible')
  const away = await poll(async () => /\baway\b/.test(await aliceRow(bob).getAttribute('class')), 10_000)
  check('invisible: the others list you as away', away)
  check('still under your level', (await bob.locator('.rail-head, .rail-person').allTextContents()).findIndex((t) => t.startsWith('Owner')) >= 0)
  check('and see none of your words', !(await aliceRow(bob).textContent()).includes('Out for lunch'))

  await pick(alice, 'Online')
  await pick(alice, 'Clear your status words')
  check('back online, and seen as here again', await poll(async () => /\bgood\b/.test(await dotOf(bob)), 10_000))
  const kept = await alice.evaluate(() => localStorage.getItem('nook.status.v1'))
  check('online with no words keeps nothing', kept === null, String(kept))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}
finish()
