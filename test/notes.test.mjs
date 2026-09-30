import { APP_URL, FAKE_MEDIA, answer, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

// A note's own bar has its buttons: rename, who can see it, copy, and delete. The list has no
// buttons, only a right click. A note kept to some levels is out of sight for everybody else.
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

const noteTitles = (page) => page.evaluate(async () => {
  const { spaces } = await import('/src/space/registry.ts')
  return spaces.all()[0].chat.notes().map((n) => n.title)
})

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'notes')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)

  check('no channel in the list has a button of its own', (await alice.locator('.rail-row .person-more').count()) === 0)

  await alice.click('button[aria-label="Make a note"]')
  await answer(alice, 'Plans')
  await alice.waitForSelector('.note-view:not(.hidden)')
  check('Bob sees a note open to everybody', await poll(async () => (await noteTitles(bob)).includes('Plans'), 10_000))
  check('the note in the list has no button of its own', (await alice.locator('.rail-row .person-more').count()) === 0)

  const tools = await alice.locator('.note-tools button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))
  check('the note bar has rename, who can see it, copy, and delete', tools.length === 4 && tools[0] === 'Rename' && tools.at(-1) === 'Delete the note', tools.join(' | '))

  await alice.click('.note-tools button[aria-label="Rename"]')
  check('rename puts you in the title', await alice.evaluate(() => document.activeElement?.classList.contains('note-title')))
  await alice.keyboard.type('Secret plans')
  await alice.keyboard.press('Enter')
  check('the new name reaches Bob', await poll(async () => (await noteTitles(bob)).includes('Secret plans'), 10_000))

  await alice.click('.note-tools button[aria-label^="Who can see it"]')
  await alice.click('.pick-row:has-text("Moderator")')
  await alice.click('.ask-modal button:has-text("Save")')
  check('kept to Moderators, Bob no longer sees it', await poll(async () => !(await noteTitles(bob)).includes('Secret plans'), 10_000))
  check('its maker still does', (await noteTitles(alice)).includes('Secret plans'))
  check('and the list marks it kept', (await alice.locator('.rail-row:has-text("Secret plans") .kept-lock').count()) === 1)

  alice.once('dialog', (d) => void d.accept())
  await alice.click('.note-tools button[aria-label="Delete the note"]')
  check('delete, in the note, takes it away', await poll(async () => (await noteTitles(alice)).length === 0, 10_000))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}
finish()
