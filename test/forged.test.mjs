import { APP_URL, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'
import { startServer } from './pg.mjs'

// Events a member signs with a place in the log of their own choosing, sent the way the app
// sends its own, to a real server. Each device must still see the space as its owner made it.

const PORT = 8853
const SERVER = `http://localhost:${PORT}`
const started = await startServer(PORT)
const browser = await launch()
const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL)
  await page.evaluate(
    ({ n, server }) => {
      localStorage.setItem('nook.name.v1', n)
      localStorage.setItem('nook.server.v1', server)
      localStorage.setItem('nook.servers.v1', JSON.stringify([server]))
    },
    { n: name, server: SERVER },
  )
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
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

/** Signs an event with the place in the log given, and sends it as the app sends its own. */
const forge = (page, kind, body, lamport) =>
  spaceOf(
    page,
    async (space, { kind, body, lamport }) => {
      const { makeEvent } = await import('/src/store/log.ts')
      const event = await makeEvent(space.room.id, space.chat.me, lamport, kind, body)
      await space.channel.put([event])
      return event.id
    },
    { kind, body, lamport },
  )

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'forged')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const link = alice.url()
  const aliceKey = await spaceOf(alice, (space) => space.chat.me)

  const mallory = await person('Mallory')
  await mallory.goto(link)
  await mallory.waitForSelector(BOX)
  const malloryKey = await spaceOf(mallory, (space) => space.chat.me)
  // Before everything in the log: a claim to have made the space.
  await forge(mallory, 'role', { subject: malloryKey, role: 'admin' }, 0)
  await wait(1500)

  const carol = await person('Carol')
  await carol.goto(link)
  await carol.waitForSelector(BOX)
  const founder = await poll(() => spaceOf(carol, (space) => space.chat.founder), 15_000)
  check('somebody new takes the owner from who wrote first, not from a claim placed before it', founder === aliceKey, founder === malloryKey ? 'Mallory' : founder)
  const level = await spaceOf(carol, (space, key) => space.chat.levelOf(key).id, malloryKey)
  check('and the forger is a plain member there', level === 'member', level)

  // Signals. Mallory holds the space key, as every member does, and the session ids are on the
  // server's list. Every signal is signed now, and a session is the key that signed it.
  const signal = (page, { from, type, data, to, signed }) =>
    spaceOf(
      page,
      async (space, { from, type, data, to, signed }) => {
        const { buildEnvelope, seal, signedDigest } = await import('/src/signal/envelope.ts')
        const { tagged } = await import('/src/space/keys.ts')
        const { sign, loadIdentity } = await import('/src/store/identity.ts')
        const env = buildEnvelope(from ?? space.selfId, { type, data, to })
        if (signed) {
          env.k = loadIdentity().pubkey
          env.s = sign(await signedDigest(space.room.id, env))
        }
        const { tag, key } = space.keys.writing
        space.channel.publish(tagged(tag, await seal(key, env)))
      },
      { from, type, data, to, signed },
    )
  const aliceSession = await spaceOf(alice, (space) => space.selfId)
  const keyAt = (session) => spaceOf(carol, (space, id) => space.mesh.peers().find((p) => p.id === id)?.key ?? null, session)
  await poll(() => keyAt(aliceSession), 15_000)
  check('a real announce names the key that signed it', (await keyAt(aliceSession)) === aliceKey)

  await signal(mallory, { from: 'f00d01', type: 'announce', data: { name: 'Alice', key: aliceKey }, signed: true })
  await signal(mallory, { from: 'f00d02', type: 'announce', data: { name: 'Alice', key: aliceKey }, signed: false })
  await poll(() => keyAt('f00d02'), 10_000)
  check('an announce that names somebody else\'s key gets the key that signed it', (await keyAt('f00d01')) === malloryKey, await keyAt('f00d01'))
  check('an unsigned one names no key at all', (await keyAt('f00d02')) === '', JSON.stringify(await keyAt('f00d02')))

  for (const signed of [true, false]) await signal(mallory, { from: aliceSession, type: 'bye', signed })
  await wait(1500)
  check('a goodbye in another session\'s name, signed or not, is not heard', (await keyAt(aliceSession)) === aliceKey)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  started.child.kill()
  finish()
}
