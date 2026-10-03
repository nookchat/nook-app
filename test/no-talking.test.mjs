import { APP_URL, FAKE_MEDIA, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

// A voice channel marked No talking: a member's mic stays off and nobody hears them, the owner
// still talks, and the mark comes off.
const browser = await launch({ args: FAKE_MEDIA })
const NO_TALKING = 'No talking in this channel: your mic stays off'

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await context.addInitScript((n) => localStorage.setItem('nook.name.v1', n), name)
  return context.newPage()
}

const until = (page, fn, arg, ms = 10_000) =>
  page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false)

const inOwnLounge = () => document.querySelector('.voice-channel .voice-head')?.classList.contains('on') === true

/** Whether this device is muted, from the space itself. */
const muted = (page) =>
  page.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    return spaces.all()[0].voice.state.muted
  })

/** How loud this device plays everybody else in its voice channel. */
const levels = (page) =>
  page.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    return [...spaces.all()[0].voice.calls.values()].map((call) => call.level)
  })

try {
  const alice = await person('Alice')
  await alice.goto(APP_URL)
  await alice.waitForSelector('input[aria-label="Space name"]')
  await alice.fill('input[aria-label="Space name"]', 'Listen Here')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector('.space-name')

  await alice.click('.voice-join')
  await until(alice, inOwnLounge)
  await bob.click('.voice-join')
  await until(bob, inOwnLounge)
  const heard = await poll(async () => (await levels(alice)).some((l) => l > 0), 15_000)
  check('before the mark, Alice hears Bob', heard)

  await alice.click('.voice-channel .voice-head', { button: 'right' })
  await alice.click('.menu-item:has-text("No talking")')
  const marked = await poll(async () => (await bob.locator('.voice-head [title^="No talking"]').count()) === 1, 15_000)
  check('a voice channel marked No talking says so, for everybody', marked)
  check("Bob's mic goes off by itself", await poll(() => muted(bob), 10_000))
  check('and Alice plays him at no volume', await poll(async () => (await levels(alice)).every((l) => l === 0), 10_000))

  await bob.click(`.voice-tool[aria-label="${NO_TALKING}"]`)
  check('his mic button says why, and turns nothing on', (await muted(bob)) === true)
  const told = await poll(() => bob.$$eval('.toast', (els) => els.some((t) => t.textContent.includes('No talking'))), 5000)
  check('with a toast', told)

  check('the owner still talks', (await muted(alice)) === false)
  check('and Bob still hears her', (await levels(bob)).some((l) => l > 0))

  await alice.click('.voice-channel .voice-head', { button: 'right' })
  await alice.click('.menu-item:has-text("Let everybody talk")')
  const unmarked = await poll(async () => (await bob.locator('.voice-head [title^="No talking"]').count()) === 0, 15_000)
  check('the mark comes off', unmarked)
  await bob.click('.voice-tool[aria-label="Unmute"]')
  check('and Bob can turn his mic on again', (await muted(bob)) === false)
  check('and Alice hears him again', await poll(async () => (await levels(alice)).some((l) => l > 0), 10_000))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
