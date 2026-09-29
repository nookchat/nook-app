import { createServer, connect } from 'node:net'
import { APP_URL, FAKE_MEDIA, check, finish, launch, stoppedEarly, wait } from './harness.mjs'
import { startServer } from './pg.mjs'

// An update reloads the page into the lounge again. Leaving then must take you out of it,
// for you, for the others, and for anybody who comes later. And a session the server does
// not hold, whatever the page once heard, is not shown as here.
const PORT = 8809
const { child: server } = await startServer(PORT)
const serverSince = Date.now()
/** A page trusts the list only once the server has been up this long: before, the others are still coming back. */
const LIST_TRUSTED_MS = 26_000

// In front of the server, as a reverse proxy would be: it passes on what a page sends a few
// times a second, in one write. So the last thing a page says as it goes comes with its close.
const PROXY = 8810
const proxy = createServer((client) => {
  const upstream = connect(PORT, 'localhost')
  let held = []
  const flush = setInterval(() => {
    if (held.length === 0) return
    upstream.write(Buffer.concat(held))
    held = []
  }, 60)
  client.on('data', (chunk) => held.push(chunk))
  upstream.on('data', (chunk) => client.write(chunk))
  const end = () => {
    clearInterval(flush)
    if (held.length) upstream.write(Buffer.concat(held))
    held = []
    upstream.end()
    client.end()
  }
  client.on('close', end)
  client.on('error', end)
  upstream.on('close', () => client.destroy())
  upstream.on('error', () => client.destroy())
})
await new Promise((done) => proxy.listen(PROXY, done))

const browser = await launch({ args: FAKE_MEDIA })

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await context.addInitScript(
    ({ n, at }) => {
      localStorage.setItem('nook.name.v1', n)
      localStorage.setItem('nook.server.v1', at)
      localStorage.setItem('nook.servers.v1', JSON.stringify([at]))
    },
    { n: name, at: `http://localhost:${PROXY}` },
  )
  return context.newPage()
}

const loungeNames = (page) =>
  page.$$eval('.voice-channel .voice-member', (els) => els.map((e) => e.textContent.trim()))
const until = (page, fn, arg, ms = 20_000) =>
  page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false)
const inLounge = (who) =>
  [...document.querySelectorAll('.voice-channel .voice-member')].some((e) => e.textContent.includes(who))
const notInLounge = (who) =>
  ![...document.querySelectorAll('.voice-channel .voice-member')].some((e) => e.textContent.includes(who))

try {
  const alice = await person('Alice')
  await alice.goto(APP_URL)
  await alice.waitForSelector('input[aria-label="Space name"]')
  await alice.fill('input[aria-label="Space name"]', 'presence')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(1200)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector('.space-name')
  await bob.waitForTimeout(1200)

  const inOwnLounge = () => document.querySelector('.voice-channel .voice-head')?.classList.contains('on') === true
  await alice.click('.voice-join')
  await until(alice, inOwnLounge)
  await bob.click('.voice-join')
  await until(bob, inOwnLounge)
  check('both are in the lounge', (await until(bob, inLounge, 'Alice')) && (await until(alice, inLounge, 'Bob')))

  // What Update now does, then the reload.
  await alice.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    const { noteForUpdate } = await import('/src/space/resume.ts')
    const space = spaces.all().find((s) => s.voice?.state.channel)
    const { channel, muted, deafened } = space.voice.state
    noteForUpdate({ room: space.room.id, channel, muted, deafened }, null)
    for (const s of spaces.all()) s.announce()
  })
  await alice.waitForTimeout(300)
  await alice.reload()
  await alice.waitForSelector('.space-name')
  check(
    'after the update Alice is back in the lounge',
    await until(alice, () => document.querySelector('.voice-channel .voice-head')?.classList.contains('on') === true),
  )
  check(
    'and Bob sees her there, not as updating',
    await until(bob, () =>
      [...document.querySelectorAll('.voice-member')].some((e) => e.textContent.includes('Alice') && !e.classList.contains('updating')),
    ),
  )
  await alice.waitForTimeout(1500)

  await alice.click('button.voice-leave')
  check('Alice leaves: she is not in her own lounge', await until(alice, notInLounge, 'Alice', 8000), (await loungeNames(alice)).join(', '))
  check('and not in Bob\'s', await until(bob, notInLounge, 'Alice', 8000), (await loungeNames(bob)).join(', '))
  await bob.waitForTimeout(3000)
  check('and she stays out', (await loungeNames(bob)).every((n) => !n.includes('Alice')), (await loungeNames(bob)).join(', '))

  const carol = await person('Carol')
  await carol.goto(alice.url())
  await carol.waitForSelector('.space-name')
  check('Bob is in the lounge for somebody who comes later', await until(carol, inLounge, 'Bob'))
  await carol.waitForTimeout(2000)
  check('and Alice is not', (await loungeNames(carol)).every((n) => !n.includes('Alice')), (await loungeNames(carol)).join(', '))

  // A session the page heard of, which the server does not hold: the list from the server takes it away.
  await wait(Math.max(0, LIST_TRUSTED_MS - (Date.now() - serverSince)))
  await bob.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    const space = spaces.all()[0]
    const key = space.mesh.peers().find((p) => p.name === 'Alice')?.key
    space.bus.deliver({
      v: 1,
      id: 'ghost-announce',
      from: 'deadbeef0001',
      t: Date.now(),
      type: 'announce',
      data: { name: 'Alice', key, voice: 'lounge', voiceFor: 1000 },
    })
  })
  check('a ghost of Alice shows in Bob\'s lounge', await until(bob, inLounge, 'Alice', 5000))
  await bob.waitForTimeout(200)
  await bob.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    spaces.all()[0].channel.askWho()
  })
  check('the server\'s list of who is here takes the ghost away', await until(bob, notInLounge, 'Alice', 5000), (await loungeNames(bob)).join(', '))
  check('and Bob is still there', (await loungeNames(bob)).some((n) => n.includes('Bob')))
} catch (err) {
  stoppedEarly(err)
}

await browser.close()
proxy.close()
server.kill()
finish()
