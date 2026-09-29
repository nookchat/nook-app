import { APP_URL, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'

// "Updating Nook" is for the moment of a reload. It must go by itself, even when the
// reload said so twice and nothing else happens in the space after.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const updatingShown = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.person-doing')].some((e) => e.textContent.includes('Updating Nook')))

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'updating')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await wait(2000)

  const sayUpdating = () =>
    bob.evaluate(async () => {
      const { noteForUpdate } = await import('/src/space/resume.ts')
      const { spaces } = await import('/src/space/registry.ts')
      noteForUpdate(null, null)
      for (const space of spaces.all()) space.announce()
    })
  await sayUpdating()
  check('Alice sees Bob updating', await poll(() => updatingShown(alice), 5000))
  await wait(5000)
  await sayUpdating()
  await wait(500)
  await bob.context().close()

  const gone = await poll(async () => !(await updatingShown(alice)), 50_000)
  check('with Bob never back, it goes by itself', gone)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
