import { APP_URL, check, FAKE_MEDIA, finish, HOME, launch, makeSpace, poll, stoppedEarly, wait } from './harness.mjs'
import { startServer } from './pg.mjs'

// Somebody who leaves while the server is away never gets a "left" from it. The
// others must not keep them in the voice channel for good.
const PORT = 8831
const SERVER = `http://localhost:${PORT}`
let server = await startServer(PORT)
const browser = await launch({ args: FAKE_MEDIA })
const BOX = '[aria-label="Write a message"]'

async function person(name, { clock = false } = {}) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  // Alice's clock can be wound on, so the wait after a reconnect takes no time.
  if (clock) await page.clock.install()
  await page.goto(APP_URL)
  await page.evaluate(
    ({ n, at }) => {
      localStorage.setItem('nook.name.v1', n)
      localStorage.setItem('nook.server.v1', at)
      localStorage.setItem('nook.servers.v1', JSON.stringify([at]))
    },
    { n: name, at: SERVER },
  )
  await page.reload()
  await page.waitForSelector(HOME)
  return page
}

const inVoice = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.voice-channel .voice-member')].map((m) => m.textContent.trim()))

try {
  const alice = await person('Alice', { clock: true })
  await makeSpace(alice, 'ghosts')
  await alice.waitForSelector(BOX)
  await wait(1000)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  const carol = await person('Carol')
  await carol.goto(alice.url())
  await carol.waitForSelector(BOX)

  await bob.locator('.voice-channel .rail-item').first().click()
  await carol.locator('.voice-channel .rail-item').first().click()
  const seen = await poll(async () => {
    const names = await inVoice(alice)
    return names.some((t) => t.includes('Bob')) && names.some((t) => t.includes('Carol'))
  }, 20_000)
  check('Alice sees Bob and Carol in voice', seen)

  server.child.kill()
  await wait(1500)
  await bob.context().close()
  server = await startServer(PORT, { DATABASE_URL: server.database, NOOK_FILES: server.files })

  // Both back on the server, and Carol's hello through to Alice, before Alice's wait is wound on.
  const connected = (page) =>
    page.evaluate(async () => {
      const { spaces } = await import('/src/space/registry.ts')
      return spaces.all()[0]?.bus?.healthList.every((h) => h.status === 'open') === true
    })
  await poll(async () => (await connected(alice)) && (await connected(carol)), 30_000)
  await wait(2000)
  await alice.clock.runFor(30_000)
  const gone = await poll(async () => !(await inVoice(alice)).some((t) => t.includes('Bob')), 10_000)
  check('once the server is back, Bob is out of the channel', gone, (await inVoice(alice)).join(', '))
  const here = await alice.evaluate(() => document.querySelector('.status-bar')?.dataset.here ?? '')
  check('and out of the count of who is here', here === '2', here)
  await wait(3000)
  check('Carol, still here, stays in the channel', (await inVoice(alice)).some((t) => t.includes('Carol')), (await inVoice(alice)).join(', '))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  server.child.kill()
  finish()
}
