import { APP_URL, check, FAKE_MEDIA, finish, HOME, launch, makeSpace, stoppedEarly } from './harness.mjs'

// Somebody who may move people drags a person onto a voice channel, and that person's device
// goes there. A member cannot: nothing of theirs drags, and a move they sign is ignored.
const browser = await launch({ args: FAKE_MEDIA })

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.addInitScript((n) => localStorage.setItem('nook.name.v1', n), name)
  return context.newPage()
}

const until = (page, fn, arg, ms = 15_000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false)
const channelOf = (page) =>
  page.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    return spaces.all()[0]?.voice.state.channel ?? null
  })
const inChannel = ([channel, who]) =>
  [...document.querySelectorAll('.voice-channel')].some(
    (row) => row.querySelector('.voice-join')?.textContent.includes(channel) && [...row.querySelectorAll('.voice-member')].some((m) => m.textContent.includes(who)),
  )

try {
  const alice = await person('Alice')
  await alice.goto(APP_URL)
  await alice.waitForSelector(HOME)
  await makeSpace(alice, 'moves')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(1200)
  await alice.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    await spaces.all()[0].chat.makeChannel('studio', true)
  })
  const link = alice.url()
  const bob = await person('Bob')
  await bob.goto(link)
  await bob.waitForSelector('.space-name')
  const carol = await person('Carol')
  await carol.goto(link)
  await carol.waitForSelector('.space-name')
  await alice.waitForTimeout(1500)

  await alice.click('.voice-channel:has-text("lounge") .voice-join')
  await bob.click('.voice-channel:has-text("lounge") .voice-join')
  check('Alice sees Bob in the lounge', await until(alice, inChannel, ['lounge', 'Bob']))

  // Alice owns the space, so she may move people: she drags Bob to the studio.
  await alice.locator('.voice-member', { hasText: 'Bob' }).dragTo(alice.locator('.voice-channel', { hasText: 'studio' }))
  check('Bob is told who moved him', await until(bob, () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('moved you to studio'))))
  check('dragged onto the studio, Bob is moved there', await until(bob, () => document.querySelector('.voice-panel')?.textContent.includes('studio')), String(await channelOf(bob)))
  check('and Alice sees him there', await until(alice, inChannel, ['studio', 'Bob']))

  // Carol is not in voice: a drag from the list of people asks her to join.
  await alice.locator('.rail-person', { hasText: 'Carol' }).dragTo(alice.locator('.voice-channel', { hasText: 'studio' }))
  const asked = await until(carol, () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('asked you to join studio')))
  check('dragged from the list of people, Carol, not in voice, is asked to join', asked)
  await carol.click('.toast button:has-text("Join")')
  check('and one click takes her in', await until(alice, inChannel, ['studio', 'Carol']))

  // His right click menu has no Move to: people are moved with a drag, on the left.
  await alice.click('.rail-person.has-menu:has-text("Bob")', { button: 'right' })
  await alice.waitForSelector('.menu')
  check('the right click menu has no Move to', (await alice.locator('.menu .menu-heading:text-is("Move to")').count()) === 0)
  await alice.keyboard.press('Escape')
  await alice.locator('.voice-member', { hasText: 'Bob' }).dragTo(alice.locator('.voice-channel', { hasText: 'lounge' }))
  check('dragged back, Bob is in the lounge again', await until(alice, inChannel, ['lounge', 'Bob']))

  // Bob is a member.
  const drags = await bob.$$eval('.voice-member, .rail-person', (els) => els.some((e) => e.draggable))
  check('a member cannot drag anybody', !drags)
  await bob.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    const { signClaim } = await import('/src/store/identity.ts')
    const { loadIdentity } = await import('/src/store/identity.ts')
    const space = spaces.all()[0]
    const carol = space.mesh.peers().find((p) => p.name === 'Carol')
    const at = Date.now()
    const sig = await signClaim(['vmove', space.room.id, carol.key, 'lounge', at])
    await space.bus.send({ type: 'vmove', to: carol.id, data: { channel: 'lounge', by: loadIdentity().pubkey, at, sig } })
  })
  await carol.waitForTimeout(2500)
  check('a move signed by a member is ignored', (await channelOf(carol)) === 'studio', String(await channelOf(carol)))
} catch (err) {
  stoppedEarly(err)
}

await browser.close()
finish()
