import { APP_URL, FAKE_MEDIA, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'
import { startServer } from './pg.mjs'

// The server restarts, as it does for an update, under people who are chatting and in voice.
// Nobody clicks anything: the pages come back by themselves, what was written while it was
// down arrives, and voice, which goes between the browsers, never stops.
const PORT = 8821
const SERVER = `http://localhost:${PORT}`
let server = await startServer(PORT)
const { database, files } = server
const DOWN_MS = Number(process.env.DOWN_MS ?? 20_000)
/** From the server answering again to the pages being back. */
const BACK_WITHIN_MS = 8000

const browser = await launch({ args: FAKE_MEDIA })
const BOX = '[aria-label="Write a message"]'
const LOUNGE = '.voice-channel .rail-item:has-text("lounge")'

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate(
    ({ n, s }) => {
      localStorage.setItem('nook.name.v1', n)
      localStorage.setItem('nook.server.v1', s)
      localStorage.setItem('nook.servers.v1', JSON.stringify([s]))
    },
    { n: name, s: SERVER },
  )
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const spaceOf = (page, work, arg) =>
  page.evaluate(
    async ({ work, arg }) => {
      const { spaces } = await import('/src/space/registry.ts')
      return new Function('space', 'arg', `return (${work})(space, arg)`)(spaces.all()[0], arg)
    },
    { work: work.toString(), arg },
  )

const said = (page) => spaceOf(page, (space) => space.chat.log.messages().map((m) => m.text))
const open = (page) => spaceOf(page, (space) => space.channel.connection?.open ?? space.bus.healthList.every((h) => h.status === 'open'))
const talking = (page) => spaceOf(page, (space) => space.voice.connected)
const peopleHere = (page) => page.$$eval('.rail-right .rail-person:not(.away)', (els) => els.length)

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'restart')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await alice.click(LOUNGE)
  await bob.click(LOUNGE)
  check('both are in voice', await poll(async () => (await talking(alice)) > 0 && (await talking(bob)) > 0, 20_000))
  check('and see each other', await poll(async () => (await peopleHere(alice)) === 2, 10_000))

  // The server goes, as `docker compose restart` does it.
  server.child.kill('SIGTERM')
  await poll(async () => !(await open(alice)), 10_000)
  check('the pages see it go', !(await open(alice)) && !(await open(bob)))
  await spaceOf(alice, (space) => space.chat.say('written while it was down', 'general'))
  await wait(DOWN_MS)
  check('voice keeps going while it is down', (await talking(alice)) > 0)

  server = await startServer(PORT, { DATABASE_URL: database, NOOK_FILES: files })
  const up = Date.now()
  const back = await poll(async () => (await open(alice)) && (await open(bob)), 90_000, 200)
  const took = Date.now() - up
  check(`the pages are back by themselves, in ${(took / 1000).toFixed(1)} s`, back && took < BACK_WITHIN_MS)
  const arrived = await poll(async () => (await said(bob)).includes('written while it was down'), 20_000)
  check('what was written while it was down arrives', arrived)
  await spaceOf(bob, (space) => space.chat.say('and after', 'general'))
  check('and writing goes on', await poll(async () => (await said(alice)).includes('and after'), 10_000))
  check('voice never stopped', (await talking(alice)) > 0 && (await talking(bob)) > 0)

  // Past the time the others get to say hello: nobody was counted gone.
  await wait(30_000)
  check('they still see each other here', (await peopleHere(alice)) === 2 && (await peopleHere(bob)) === 2)
  check('and both are still in the voice channel', (await alice.locator('.voice-member').count()) === 2)

  // Somebody new joins voice after the restart, which needs the server for the handshake.
  const carol = await person('Carol')
  await carol.goto(alice.url())
  await carol.waitForSelector(BOX)
  await carol.click(LOUNGE)
  check('a new call starts after the restart', await poll(async () => (await talking(carol)) >= 2, 20_000))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  server.child.kill()
  finish()
}
