import { APP_URL, FAKE_MEDIA, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

// Leaving the page is leaving the space. A reload, as an update does, or a closed tab takes
// you out of voice, for the others at once, and nothing puts you back in by itself.
const browser = await launch({ args: FAKE_MEDIA })

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await context.addInitScript((n) => localStorage.setItem('nook.name.v1', n), name)
  const page = await context.newPage()
  return page
}

const inLounge = (page) => page.$eval('.voice-channel .voice-head', (el) => el.classList.contains('on')).catch(() => false)
const loungeNames = (page) => page.$$eval('.voice-channel .voice-member', (els) => els.map((e) => e.textContent.trim()))
const until = (page, fn, arg, ms = 20_000) =>
  page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false)
const aliceInLounge = () => [...document.querySelectorAll('.voice-member')].some((e) => e.textContent.includes('Alice'))
const aliceOut = () => ![...document.querySelectorAll('.voice-member')].some((e) => e.textContent.includes('Alice'))

try {
  const alice = await person('Alice')
  await alice.goto(APP_URL)
  await alice.waitForSelector('input[aria-label="Space name"]')
  await alice.fill('input[aria-label="Space name"]', 'leaving')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(1200)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector('.space-name')
  await bob.waitForTimeout(1200)

  await alice.click('.voice-join')
  await bob.click('.voice-join')
  const met = await until(bob, aliceInLounge)
  // Each side's own join, and the other's, land in either order.
  const bothIn = await poll(async () => (await inLounge(alice)) && (await inLounge(bob)), 20_000)
  check('both are in the lounge', met && bothIn)

  // A reload with nothing said first, as a crash or F5 does.
  await alice.reload()
  check('Bob sees Alice leave within a few seconds', await until(bob, aliceOut, undefined, 5000), (await loungeNames(bob)).join(', '))
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(3000)
  check('after the reload Alice is not put back in the lounge', !(await inLounge(alice)))
  check('and Bob still does not see her there', await until(bob, aliceOut, undefined, 1000), (await loungeNames(bob)).join(', '))
  check(
    'and nobody is shown as updating',
    await bob.evaluate(() => ![...document.querySelectorAll('.person-doing')].some((e) => e.textContent.includes('Updating'))),
  )

  // In again, then the tab closes.
  await alice.click('.voice-join')
  check('Alice joins again with a click', await until(bob, aliceInLounge))
  await alice.close({ runBeforeUnload: false })
  check('a closed tab leaves the lounge at once', await until(bob, aliceOut, undefined, 5000), (await loungeNames(bob)).join(', '))

  // A browser that holds sound back until a click. Headless Chrome never does, so a stand-in
  // context plays that part: it stays suspended until something resumes it after the click.
  const fresh = await person('Carol')
  await fresh.goto(APP_URL)
  await fresh.waitForTimeout(1000)
  const state = await fresh.evaluate(async () => {
    const { watchContext } = await import('/src/net/unlock.ts')
    let clicked = false
    window.addEventListener('pointerdown', () => (clicked = true), true)
    window.__ctx = {
      state: 'suspended',
      resume() {
        if (clicked) this.state = 'running'
        return Promise.resolve()
      },
    }
    watchContext(window.__ctx)
    await new Promise((r) => setTimeout(r, 600))
    return window.__ctx.state
  })
  const asked = await fresh.$$eval('.toast', (els) => els.some((t) => t.textContent.includes('Hear the call')))
  check('with no click, the sound waits and the page asks for one', state === 'suspended' && asked, state)
  await fresh.click('.toast button:has-text("Hear the call")')
  const after = await fresh.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 300))
    return window.__ctx.state
  })
  check('and that click lets it go', after === 'running', after)
} catch (err) {
  stoppedEarly(err)
}

await browser.close()
finish()
