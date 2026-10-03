import { APP_URL, answer, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'

// A space with a password: a wrong one lets nobody in and opens no empty space in its place,
// the right one does, and a reload asks for it no more.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const question = (page) => page.locator('.ask-modal').textContent({ timeout: 10_000 })
const spaceName = (page) => page.evaluate(() => document.querySelector('.space-name')?.textContent ?? null)

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'Locked Room')
  await alice.fill('input[aria-label="Space password"]', 'opensesame')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const invite = alice.url()

  const bob = await person('Bob')
  await bob.goto(invite)
  check('an invite to a space with a password asks for it', (await question(bob)).includes('has a password'))

  await answer(bob, 'wrong one')
  const again = await poll(async () => (await question(bob)).includes('wrong'), 10_000)
  check('a wrong password is turned away, and it says so', again)
  check('and nothing opens behind it', (await bob.locator(BOX).count()) === 0)

  await answer(bob, 'opensesame')
  await bob.waitForSelector(BOX, { timeout: 15_000 })
  const named = await poll(async () => (await spaceName(bob)) === 'Locked Room', 15_000)
  check('the right one lets them in, to the space itself', named, String(await spaceName(bob)))

  await wait(2500)
  await bob.reload()
  await bob.waitForSelector(BOX, { timeout: 20_000 })
  check('a reload asks for the password no more', (await bob.locator('.ask-modal').count()) === 0)
  const still = await poll(async () => (await spaceName(bob)) === 'Locked Room', 15_000)
  check('and opens the same space', still, String(await spaceName(bob)))

  // A wrong password, given up on: home, and no Unnamed space in the list.
  const carol = await person('Carol')
  await carol.goto(invite)
  await answer(carol, 'nope')
  await poll(async () => (await question(carol)).includes('wrong'), 10_000)
  await carol.keyboard.press('Escape')
  await carol.waitForSelector('input[aria-label="Space name"]', { timeout: 10_000 })
  await wait(1500)
  const listed = await carol.evaluate(() => document.body.textContent?.includes('Unnamed space') ?? false)
  check('giving up goes home, with no empty space made', !listed)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
