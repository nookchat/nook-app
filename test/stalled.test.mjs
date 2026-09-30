import { APP_URL, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'
import { startServer } from './pg.mjs'

// A socket that looks open and carries nothing, as after a laptop sleeps or moves to another
// network: the server is stopped, not gone, so the browser never hears the socket close. The
// pages find out for themselves, dial again, and show nothing stale: not who was here, not what
// was said. And a message that comes in takes its author's "typing" away at once.
const PORT = 8823
const SERVER = `http://localhost:${PORT}`
const server = await startServer(PORT)

const browser = await launch()
const BOX = '[aria-label="Write a message"]'

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
const open = (page) => spaceOf(page, (space) => space.channel.connection.open)
/** Who the list shows as here: a member who is not here is still on it, greyed. */
const names = (page) => page.$$eval('.rail-right .rail-person:not(.away)', (els) => els.map((e) => e.textContent ?? ''))
const typing = (page) => page.$eval('.chat-typing', (e) => !e.classList.contains('hidden'))

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'stalled')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  const carol = await person('Carol')
  await carol.goto(alice.url())
  await carol.waitForSelector(BOX)
  const all = async (page) => {
    const here = await names(page)
    return ['Alice', 'Bob', 'Carol'].every((n) => here.some((t) => t.includes(n)))
  }
  check('all three see each other', await poll(async () => (await all(alice)) && (await all(bob)), 15_000))

  await bob.click(BOX)
  await bob.keyboard.type('on my way')
  check('Alice sees Bob typing', await poll(() => typing(alice), 5000))
  await bob.keyboard.press('Enter')
  await poll(async () => (await said(alice)).includes('on my way'), 5000)
  check('his message takes the typing away at once', await poll(async () => !(await typing(alice)), 1000))

  // The server stops answering, and the sockets stay open.
  server.child.kill('SIGSTOP')
  const stoppedAt = Date.now()
  await carol.context().close()
  await spaceOf(bob, (space) => space.chat.say('said while it was stuck', 'general'))

  // Back on the network: Alice looks at once.
  await alice.evaluate(() => window.dispatchEvent(new Event('online')))
  const aliceSaw = await poll(async () => !(await open(alice)), 15_000, 250)
  check(`back online, Alice sees the server stopped answering, in ${((Date.now() - stoppedAt) / 1000).toFixed(1)} s`, aliceSaw)
  // Nothing tells Bob: a quiet socket is enough.
  const bobSaw = await poll(async () => !(await open(bob)), 60_000, 500)
  check(`Bob sees it with no help, in ${((Date.now() - stoppedAt) / 1000).toFixed(1)} s`, bobSaw)

  server.child.kill('SIGCONT')
  const back = await poll(async () => (await open(alice)) && (await open(bob)), 30_000, 250)
  check('once it answers, both pages are back by themselves', back)
  check('what Bob said while it was stuck reaches Alice', await poll(async () => (await said(alice)).includes('said while it was stuck'), 15_000))
  const carolGone = async (page) => (await names(page)).every((n) => !n.includes('Carol'))
  check('Carol, who left while it was stuck, is off Alice\'s list', await poll(() => carolGone(alice), 30_000), (await names(alice)).join(', '))
  check('and off Bob\'s', await poll(() => carolGone(bob), 5000), (await names(bob)).join(', '))
  await wait(2000)
  const two = async (page) => (await names(page)).length === 2
  check('Alice and Bob still see each other', (await two(alice)) && (await two(bob)), (await names(alice)).join(', '))
} catch (err) {
  stoppedEarly(err)
} finally {
  server.child.kill('SIGCONT')
  await browser.close()
  server.child.kill()
  finish()
}
