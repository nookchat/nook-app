import { APP_URL, FAKE_MEDIA, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

// A camera in a voice channel: one click, and everybody in the channel sees it, somebody who
// comes in later too. The line for it is there from the start, so nothing is set up again.
const browser = await launch({ args: FAKE_MEDIA })
const BOX = '[aria-label="Write a message"]'
const LOUNGE = '.voice-channel .rail-item:has-text("lounge")'

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

/** The tiles on this page, and whether each one has moving pictures. */
const tiles = (page) =>
  page.$$eval('.camera-strip:not(.hidden) .camera-tile', (els) =>
    els.map((el) => {
      const video = el.querySelector('video')
      return { name: el.querySelector('.camera-tag')?.textContent ?? '', playing: !!video && video.videoWidth > 0 && !video.paused }
    }),
  )

const connected = (page) =>
  page.evaluate(async () => (await import('/src/space/registry.ts')).spaces.all()[0]?.voice.connected ?? 0)

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'cameras')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)

  await alice.click(LOUNGE)
  await bob.click(LOUNGE)
  await alice.waitForSelector('.voice-bar:not(.hidden)', { timeout: 15_000 })
  await bob.waitForSelector('.voice-bar:not(.hidden)', { timeout: 15_000 })
  await poll(async () => (await connected(bob)) > 0, 20_000)
  check('with no camera on there are no tiles', (await tiles(bob)).length === 0)

  await alice.click('.voice-bar button[aria-label="Turn on camera"]')
  const mine = await poll(async () => (await tiles(alice)).find((t) => t.name === 'You' && t.playing), 10_000)
  check('Alice sees her own camera', mine)
  const seen = await poll(async () => (await tiles(bob)).find((t) => t.name === 'Alice' && t.playing), 20_000)
  check('Bob sees it, with no new handshake', seen, JSON.stringify(await tiles(bob)))
  check('the voice list marks her camera', (await bob.locator('.voice-member:has-text("Alice") .voice-camera').count()) === 1)
  await bob.screenshot({ path: 'test-output/camera.png' })

  // Somebody who comes in while it is on sees it too.
  const carol = await person('Carol')
  await carol.goto(alice.url())
  await carol.waitForSelector(BOX)
  await carol.click(LOUNGE)
  const late = await poll(async () => (await tiles(carol)).find((t) => t.name === 'Alice' && t.playing), 20_000)
  check('somebody who joins later sees it', late)

  await bob.click('.voice-bar button[aria-label="Turn on camera"]')
  const both = await poll(async () => {
    const names = (await tiles(carol)).filter((t) => t.playing).map((t) => t.name)
    return names.includes('Alice') && names.includes('Bob')
  }, 20_000)
  check('two cameras at once', both, JSON.stringify(await tiles(carol)))

  await alice.click('.voice-bar button[aria-label="Turn off camera"]')
  const off = await poll(async () => !(await tiles(bob)).some((t) => t.name === 'Alice'), 15_000)
  check('turned off, her tile goes for the others', off)
  check('and for her', !(await tiles(alice)).some((t) => t.name === 'You'))

  await bob.click('.voice-bar button[aria-label="Leave"]')
  const gone = await poll(async () => !(await tiles(carol)).some((t) => t.name === 'Bob'), 15_000)
  check('leaving voice takes the camera with it', gone)
  await bob.click(LOUNGE)
  await bob.waitForSelector('.voice-bar:not(.hidden)', { timeout: 15_000 })
  check('and turns it off: back in voice, it is off', (await bob.locator('.voice-bar button[aria-label="Turn on camera"]').count()) === 1)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
