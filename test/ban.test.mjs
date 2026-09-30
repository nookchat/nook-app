import { APP_URL, FAKE_MEDIA, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'

// A ban is a removal that closes the old invites. Somebody banned who comes back as somebody new,
// with the old link, is not given the key, is not seen, and what they write is not shown. A link
// made after the ban carries a pass, and a newcomer with it is let in with no click.
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

const spaceOf = (page, work, arg) =>
  page.evaluate(
    async ({ work, arg }) => {
      const { spaces } = await import('/src/space/registry.ts')
      const space = spaces.all()[0]
      return new Function('space', 'arg', `return (${work})(space, arg)`)(space, arg)
    },
    { work: work.toString(), arg },
  )

const said = (page) => spaceOf(page, (space) => space.chat.log.messages().map((m) => m.text))
const newestKey = (page) => spaceOf(page, (space) => space.chat.log.keyEpochs().at(-1)?.id ?? '')
const holds = (page, id) => spaceOf(page, (space, id) => space.keys.has(id), id)
const me = (page) => spaceOf(page, (space) => space.chat.me)
const heardKeys = (page) => spaceOf(page, (space) => space.mesh.peers().map((p) => p.key))

async function inviteLink(page) {
  await page.click('.space-title-button')
  await page.click('.menu-item:has-text("Invite")')
  const box = page.locator('.share-code')
  await box.waitFor({ timeout: 15_000 })
  const link = await box.getAttribute('data-link')
  const shown = await box.textContent()
  await page.keyboard.press('Escape')
  return { link, shown }
}

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'bans')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const oldLink = alice.url()

  const bob = await person('Bob')
  await bob.goto(oldLink)
  await bob.waitForSelector(BOX)
  const mallory = await person('Mallory')
  await mallory.goto(oldLink)
  await mallory.waitForSelector(BOX)
  await poll(async () => (await spaceOf(alice, (space) => space.chat.log.keyMembers().length)) === 3, 20_000)

  check('before a ban, the invite has no pass', !(await inviteLink(alice)).link.includes('~'))

  // The ban, from Mallory's menu in the list of people.
  const malloryKey = await me(mallory)
  alice.once('dialog', (d) => void d.accept())
  await alice.click('.rail-person:has-text("Mallory")')
  await alice.click('.menu-item:has-text("Ban")')
  check('a ban removes them', await poll(async () => spaceOf(alice, (space, key) => space.chat.authority().isBanned(key), malloryKey), 10_000))
  const made = await poll(async () => (await newestKey(alice)) !== '' && (await holds(alice, await newestKey(alice))), 15_000)
  check('and makes a new key', made)
  const key = await newestKey(alice)
  check('which Bob has', await poll(() => holds(bob, key), 20_000))
  check('the old invites are closed', await poll(() => spaceOf(alice, (space) => space.chat.log.invitesClosed()), 10_000))

  // Mallory again, as somebody new, with the old link.
  const again = await person('Nobody')
  await again.goto(oldLink)
  await again.waitForSelector(BOX)
  const againKey = await me(again)
  await spaceOf(again, (space) => space.chat.say('let me back in', 'general'))
  await wait(8000)
  check('somebody new with the old link is not given the key', !(await holds(again, key)))
  check('what they write is not shown', !(await said(alice)).includes('let me back in') && !(await said(bob)).includes('let me back in'))
  check('and they are not seen as here', !(await heardKeys(alice)).includes(againKey))

  // A new link, with a pass.
  const { link, shown } = await inviteLink(alice)
  check('after a ban, the invite carries a pass', /~[0-9A-Z]{16}/.test(link), link)
  check('and the code it shows has the pass too', /~[0-9A-Z]{16}$/.test(shown.trim()), shown)
  const again2 = await inviteLink(alice)
  check('the same pass is used again, not a new one each time', again2.link === link)

  const dave = await person('Dave')
  await dave.goto(link)
  await dave.waitForSelector(BOX)
  check('a newcomer with the new link is given the key', await poll(() => holds(dave, key), 25_000))
  await spaceOf(dave, (space) => space.chat.say('hello from dave', 'general'))
  check('and what they write reaches the others', await poll(async () => (await said(alice)).includes('hello from dave'), 15_000))
  const daveKey = await me(dave)
  check('and they are seen as here', await poll(async () => (await heardKeys(alice)).includes(daveKey), 15_000))
  await spaceOf(alice, (space) => space.chat.say('dave can read this', 'general'))
  check('and they read the space', await poll(async () => (await said(dave)).includes('dave can read this'), 15_000))

  check('the one with the old link still has nothing', !(await holds(again, key)))

  // The pass is bound to the one who showed it.
  const passOk = await spaceOf(
    alice,
    async (space, who) => {
      const { passProof } = await import('/src/store/log.ts')
      const pass = space.chat.log.passes()[0]
      return (await passProof(pass, who)) !== (await passProof(pass, space.chat.me))
    },
    againKey,
  )
  check('a pass shown by one person proves nothing for another', passOk)

  // Unban: back in with no new link.
  await spaceOf(alice, (space, key) => space.chat.setRole(key, 'member'), malloryKey)
  check('an unban lets them back in', await poll(async () => holds(mallory, await newestKey(alice)), 25_000))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}
finish()
