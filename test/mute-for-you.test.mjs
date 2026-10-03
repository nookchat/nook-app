import { APP_URL, check, FAKE_MEDIA, finish, HOME, launch, makeSpace, stoppedEarly } from './harness.mjs'

// Muting somebody for yourself is local to your device: it never shows in the voice list for
// anybody else, and the icon for it must come and go with your own Mute switch alone.
const browser = await launch({ args: FAKE_MEDIA })

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await context.addInitScript((n) => localStorage.setItem('nook.name.v1', n), name)
  return context.newPage()
}

const until = (page, fn, arg, ms = 10_000) =>
  page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false)

const inLounge = (who) =>
  [...document.querySelectorAll('.voice-channel .voice-member')].some((e) => e.textContent.includes(who))

const mutedByYou = (who) =>
  !![...document.querySelectorAll('.voice-channel .voice-member')]
    .find((e) => e.textContent.includes(who))
    ?.querySelector('[title="Muted by you"]')

const anyMutedByYou = () => document.querySelector('[title="Muted by you"]') != null

try {
  const alice = await person('Alice')
  await alice.goto(APP_URL)
  await alice.waitForSelector(HOME)
  await makeSpace(alice, 'mute-for-you')
  await alice.waitForSelector('.space-name')
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector('.space-name')

  const inOwnLounge = () => document.querySelector('.voice-channel .voice-head')?.classList.contains('on') === true
  await alice.click('.voice-join')
  await until(alice, inOwnLounge)
  await bob.click('.voice-join')
  await until(bob, inOwnLounge)
  check('Alice sees Bob join the voice channel', await until(alice, inLounge, 'Bob'))

  // Right click Bob, in Alice's voice list, and turn her own Mute switch on for him.
  await alice.click('.voice-member:has-text("Bob")', { button: 'right' })
  await alice.waitForSelector('.menu-volume .menu-switch', { timeout: 5000 })
  await alice.click('.menu-volume .menu-switch')
  await alice.keyboard.press('Escape')

  check('the icon appears on Bob\'s row, for Alice', await until(alice, mutedByYou, 'Bob'))
  check('Alice\'s own row never gets it', !(await alice.evaluate(mutedByYou, 'Alice')))
  check('and Bob never sees it: it is local to Alice alone', !(await bob.evaluate(anyMutedByYou)))

  // Turn the switch back off.
  await alice.click('.voice-member:has-text("Bob")', { button: 'right' })
  await alice.waitForSelector('.menu-volume .menu-switch', { timeout: 5000 })
  await alice.click('.menu-volume .menu-switch')
  await alice.keyboard.press('Escape')

  const noLongerMutedByYou = (who) =>
    ![...document.querySelectorAll('.voice-channel .voice-member')]
      .find((e) => e.textContent.includes(who))
      ?.querySelector('[title="Muted by you"]')
  check('unmuting takes the icon away again', await until(alice, noLongerMutedByYou, 'Bob'))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
