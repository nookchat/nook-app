import { APP_URL, check, FAKE_MEDIA, finish, HOME, launch, makeSpace, poll, stoppedEarly, wait } from './harness.mjs'

// Somebody removed keeps the code, but not the key: what is written after they go is sealed
// with a new one that only the people still in the space have. Somebody who joins after that
// gets their copy from whoever is online, and nobody clicks anything for any of it.
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
const keyTag = (page) => spaceOf(page, (space) => space.keys.writing.tag)
const members = (page) => spaceOf(page, (space) => space.chat.log.keyMembers().length)

try {
  const alice = await person('Alice')
  await makeSpace(alice, 'rekey')
  await alice.waitForSelector(BOX)
  const link = alice.url()

  const bob = await person('Bob')
  await bob.goto(link)
  await bob.waitForSelector(BOX)
  const carol = await person('Carol')
  await carol.goto(link)
  await carol.waitForSelector(BOX)
  await poll(async () => (await members(alice)) === 3, 20_000)

  check('a space starts with the code as its key', (await keyTag(alice)) === '' && (await keyTag(bob)) === '')
  await spaceOf(alice, (space) => space.chat.say('before carol went', 'general'))
  const heard = await poll(async () => (await said(carol)).includes('before carol went'), 20_000)
  check('everybody reads under the code', heard)

  const carolKey = await spaceOf(carol, (space) => space.chat.me)
  await spaceOf(alice, (space, key) => space.chat.setRole(key, 'kicked'), carolKey)
  const made = await poll(async () => (await keyTag(alice)) !== '', 10_000)
  check('removing somebody makes a new key, with no click', made)
  const tag = await keyTag(alice)
  const bobHas = await poll(async () => (await keyTag(bob)) === tag, 20_000)
  check('the others still in the space have it', bobHas)
  check('the one removed does not', !(await spaceOf(carol, (space, t) => space.keys.has(t), tag)))

  await spaceOf(alice, (space) => space.chat.say('after carol went', 'general'))
  await spaceOf(bob, (space) => space.chat.say('bob after carol went', 'general'))
  const bobReads = await poll(async () => (await said(bob)).includes('after carol went'), 20_000)
  const aliceReads = await poll(async () => (await said(alice)).includes('bob after carol went'), 20_000)
  check('they read each other', bobReads && aliceReads)
  await wait(2000)
  const carolSees = await said(carol)
  check('the one removed cannot open it, though the code still reaches the space', !carolSees.includes('after carol went') && !carolSees.includes('bob after carol went'))

  // Somebody new comes in on the old link. Whoever is online gives them the key.
  const dave = await person('Dave')
  await dave.goto(link)
  await dave.waitForSelector(BOX)
  const daveReads = await poll(async () => (await said(dave)).includes('after carol went'), 30_000)
  check('somebody who joins later gets the key from whoever is online', daveReads)
  check('and has the newest one to write with', (await keyTag(dave)) === tag)
  await spaceOf(dave, (space) => space.chat.say('dave says hi', 'general'))
  const bobHearsDave = await poll(async () => (await said(bob)).includes('dave says hi'), 20_000)
  check('what they write reaches the others', bobHearsDave)
  await wait(1500)
  check('and not the one removed', !(await said(carol)).includes('dave says hi'))

  // The key is in the log, sealed for each person, so a reload finds it with no help.
  await alice.close()
  await dave.close()
  await bob.reload()
  await bob.waitForSelector(BOX)
  const afterReload = await poll(async () => (await said(bob)).includes('dave says hi'), 20_000)
  check('a reload opens the newer lines from the log alone', afterReload)

  // Voice goes on under the new key: its handshakes are sealed with it.
  const erin = await person('Erin')
  await erin.goto(link)
  await erin.waitForSelector(BOX)
  const erinHas = await poll(async () => (await keyTag(erin)) === tag, 30_000)
  check('with only Bob online, Bob gives the key to somebody new', erinHas)
  await bob.click('.voice-channel .rail-item:has-text("lounge")')
  await erin.click('.voice-channel .rail-item:has-text("lounge")')
  const talking = await poll(() => spaceOf(bob, (space) => space.voice.connected > 0), 20_000)
  check('voice connects under the new key', talking)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
