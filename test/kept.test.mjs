import { answer, APP_URL, check, FAKE_MEDIA, finish, HOME, launch, makeSpace, poll, stoppedEarly, wait } from './harness.mjs'

// A channel kept to some levels: the others do not see it, cannot read it, and what they
// write into it anyway is left out.
const browser = await launch({ args: FAKE_MEDIA })
const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector(HOME)
  return page
}

const chatOf = (page, work, arg) =>
  page.evaluate(
    async ({ work, arg }) => {
      const { spaces } = await import('/src/space/registry.ts')
      const chat = spaces.all()[0]?.chat
      return new Function('chat', 'arg', `return (${work})(chat, arg)`)(chat, arg)
    },
    { work: work.toString(), arg },
  )

const textRail = (page) => page.$$eval('.rail-left .rail-row .rail-item', (els) => els.map((e) => e.textContent.trim()))
const voiceRail = (page) => page.$$eval('.voice-channel .voice-join', (els) => els.map((e) => e.textContent.trim()))
const said = (page) => chatOf(page, (chat) => chat.log.messages().map((m) => m.text))

try {
  const alice = await person('Alice')
  await makeSpace(alice, 'kept')
  await alice.waitForSelector(BOX)
  await alice.click('.rail-left button[title="Make a text channel"]')
  await answer(alice, 'staff')
  await alice.click('button[title="Make a voice channel"]')
  await answer(alice, 'backroom')
  await wait(500)

  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  const carol = await person('Carol')
  await carol.goto(alice.url())
  await carol.waitForSelector(BOX)
  await poll(async () => (await textRail(carol)).includes('staff'), 20_000)
  check('before, everybody sees staff', (await textRail(carol)).includes('staff'))

  const bobKey = await chatOf(bob, (chat) => chat.me)
  await chatOf(alice, (chat, key) => chat.setRole(key, 'mod'), bobKey)

  await alice.click('.rail-left .rail-row:has-text("staff")', { button: 'right' })
  await alice.click('.menu-item:has-text("Who can see it")')
  await alice.check('.pick-row input[aria-label="Moderator"]')
  await alice.click('.ask-modal button:text-is("Save")')

  const hidden = await poll(async () => !(await textRail(carol)).includes('staff'), 20_000)
  check('a member no longer sees staff', hidden, (await textRail(carol)).join(', '))
  check('a moderator still does', (await textRail(bob)).includes('staff'))
  check('and so does the owner, with no lock beside the name', await alice.locator('.rail-row:has-text("staff") .kept-mark').count() === 0)

  await bob.click('.rail-left .rail-item:has-text("staff")')
  await bob.click(BOX)
  await bob.keyboard.type('mods only in here')
  await bob.keyboard.press('Enter')
  await poll(async () => (await said(alice)).includes('mods only in here'), 20_000)
  check('the owner reads what the moderator wrote', (await said(alice)).includes('mods only in here'))
  await wait(1000)
  check('the member does not', !(await said(carol)).includes('mods only in here'))

  await chatOf(carol, (chat) => chat.say('sneaking in', 'staff'))
  await chatOf(carol, (chat) => chat.say('hello in general', 'general'))
  await poll(async () => (await said(alice)).includes('hello in general'), 20_000)
  check('what a member writes into staff anyway is left out', !(await said(alice)).includes('sneaking in'))

  await poll(async () => (await voiceRail(carol)).includes('backroom'), 10_000)
  await alice.click('.voice-channel .voice-head:has-text("backroom")', { button: 'right' })
  await alice.click('.menu-item:has-text("Who can see and join")')
  await alice.check('.pick-row input[aria-label="Moderator"]')
  await alice.click('.ask-modal button:text-is("Save")')
  const noRoom = await poll(async () => !(await voiceRail(carol)).includes('backroom'), 20_000)
  check('a member no longer sees the kept voice channel', noRoom, (await voiceRail(carol)).join(', '))
  check('a moderator does', (await voiceRail(bob)).includes('backroom'))

  await alice.click('.rail-left button[title="Make a text channel"]')
  await alice.fill('.ask-modal .ask-input', 'secret')
  await alice.check('.pick-row input[aria-label="Moderator"]')
  await alice.click('.ask-modal button:text-is("Make")')
  await poll(async () => (await textRail(bob)).includes('secret'), 20_000)
  check('a channel kept at its making shows to a moderator', (await textRail(bob)).includes('secret'))
  const carolHasIt = await poll(() => chatOf(carol, (chat) => chat.log.everyChannel().some((c) => c.name === 'secret')), 20_000)
  check('and never to a member, who has the channel in the log', carolHasIt && !(await textRail(carol)).includes('secret'), (await textRail(carol)).join(', '))

  await alice.click('.rail-left .rail-row:has-text("staff")', { button: 'right' })
  await alice.click('.menu-item:has-text("Who can see it")')
  await alice.uncheck('.pick-row input[aria-label="Moderator"]')
  await alice.click('.ask-modal button:text-is("Save")')
  const back = await poll(async () => (await textRail(carol)).includes('staff'), 20_000)
  check('opened up again, the member sees staff', back)

  // The soundboard is a level's to have: a moderator has it, a member does not.
  await bob.click('.voice-channel .rail-item:has-text("lounge")')
  await carol.click('.voice-channel .rail-item:has-text("lounge")')
  await bob.waitForSelector('.voice-bar:not(.hidden)', { timeout: 15_000 })
  await carol.waitForSelector('.voice-bar:not(.hidden)', { timeout: 15_000 })
  check('a moderator in voice has the soundboard', (await bob.locator('.voice-bar button[aria-label="Soundboard"]').count()) === 1)
  check('a member in voice does not', (await carol.locator('.voice-bar button[aria-label="Soundboard"]').count()) === 0)
  await carol.click('[aria-label="Write a message"]')
  await carol.keyboard.type('/sound')
  await carol.keyboard.press('Escape')
  await carol.keyboard.press('Enter')
  const told = await poll(() => carol.$$eval('.toast', (els) => els.some((t) => t.textContent.includes('cannot use the soundboard'))), 5000)
  check('and /sound says so', told)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
