/**
 * Named spaces, who runs them, and what a short code is worth.
 *
 * Three questions, none of which the type checker can answer:
 *
 *   1. Does the founder actually stick? It is pinned the first time a device
 *      sees a space and never moved after, so a second person cannot walk in
 *      and declare themselves the admin.
 *   2. Does a member's role change get ignored? Only an admin may promote, and
 *      the check has to live in the log rather than in the button, because a
 *      peer sends events rather than clicks.
 *   3. Is the twelve symbol code still a key? A wrong password must produce a
 *      different room rather than a room you can see and fail to read, and one
 *      symbol out must produce a different room too.
 *
 *   node test/roles-check.mjs
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
})
const page = await browser.newPage()
await page.goto(APP_URL)

try {
  // --- the code is a key ---------------------------------------------------
  const keys = await page.evaluate(async () => {
    const { deriveRoom, newSecret, parseSecret } = await import('/src/room.ts')
    const secret = newSecret()
    const plain = await deriveRoom(secret)
    const locked = await deriveRoom(secret, 'hunter2')
    const wrong = await deriveRoom(secret, 'hunter3')

    // One symbol out. Crockford has no I, L, O or U, so 'Z' is always a swap.
    const near = secret.slice(0, -1) + (secret.at(-1) === 'Z' ? 'Y' : 'Z')
    const neighbour = await deriveRoom(near)

    return {
      length: parseSecret(secret)?.length,
      idLength: plain.id.length,
      passwordMoves: plain.id !== locked.id,
      wrongPassword: locked.id !== wrong.id,
      neighbour: plain.id !== neighbour.id,
      stable: (await deriveRoom(secret)).id === plain.id,
    }
  })
  check('a code is twelve symbols', keys.length === 12, `${keys.length}`)
  check('the topic gives nothing away', keys.idLength === 32, `${keys.idLength} hex`)
  check('a password moves the space somewhere else', keys.passwordMoves)
  check('a wrong password lands somewhere else again', keys.wrongPassword)
  check('one symbol out is a different space', keys.neighbour)
  check('the same code always derives the same space', keys.stable)

  /*
   * Stretching is the whole reason 60 bits is enough, so it has to be measured
   * rather than assumed. Wall clock alone says more about the machine than
   * about the code: a fast laptop does a quarter of a million rounds in under
   * twenty milliseconds. So this compares the real derivation against a single
   * round of the same thing. The ratio is what an attacker pays.
   */
  const cost = await page.evaluate(async () => {
    const { deriveRoom, newSecret } = await import('/src/room.ts')
    const secret = newSecret()

    const once = async (iterations) => {
      const material = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        'PBKDF2',
        false,
        ['deriveBits'],
      )
      const start = performance.now()
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations },
        material,
        256,
      )
      return performance.now() - start
    }

    // A baseline of ten thousand rounds, timed a few times, because one sample
    // of something this quick is mostly noise.
    let baseline = Infinity
    for (let i = 0; i < 5; i++) baseline = Math.min(baseline, await once(10_000))

    let real = Infinity
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      await deriveRoom(secret)
      real = Math.min(real, performance.now() - start)
    }

    return { rounds: Math.round((real / baseline) * 10_000) }
  })
  check(
    'a code is stretched before it is used as a key',
    cost.rounds > 100_000,
    `about ${cost.rounds.toLocaleString()} PBKDF2 rounds`,
  )

  // --- roles ---------------------------------------------------------------
  const roles = await page.evaluate(async () => {
    const { RoomLog } = await import('/src/store/log.ts')

    const key = (n) => String(n).repeat(64).slice(0, 64)
    const FOUNDER = key(1)
    const MEMBER = key(2)
    const THIRD = key(3)

    /*
     * Events are built by hand rather than signed, because this is about who
     * the log obeys rather than whether a signature holds. openEvent already
     * refuses anything unsigned, and a hostile peer would send well signed
     * events under its own key anyway. That is exactly what MEMBER is doing.
     */
    let n = 0
    const ev = (author, kind, body) => ({
      id: `${++n}`.padStart(64, '0'),
      room: 'r',
      author,
      lamport: n,
      kind,
      at: 1,
      body,
      sig: 'x'.repeat(128),
    })

    const build = (events) => {
      const log = new RoomLog('r')
      log.founder = FOUNDER
      for (const e of events) log.add(e)
      return log
    }

    const named = build([ev(FOUNDER, 'space', { name: 'Book club' })])
    const stolenName = build([ev(MEMBER, 'space', { name: 'Mine now' })])

    const grabbed = build([ev(MEMBER, 'role', { subject: MEMBER, role: 'admin' })])
    const promoted = build([ev(FOUNDER, 'role', { subject: MEMBER, role: 'admin' })])

    // A promotion, and then the new admin promoting a third person. Roles are
    // walked in order, so this only works if the middle step really took.
    const chain = build([
      ev(FOUNDER, 'role', { subject: MEMBER, role: 'admin' }),
      ev(MEMBER, 'role', { subject: THIRD, role: 'admin' }),
    ])

    // A member cannot demote the person who made the place.
    const coup = build([
      ev(FOUNDER, 'role', { subject: MEMBER, role: 'admin' }),
      ev(MEMBER, 'role', { subject: FOUNDER, role: 'kicked' }),
    ])

    // Channels are an admin's job too, or the rail fills up from outside.
    const channels = build([
      ev(FOUNDER, 'channel', { name: 'plans' }),
      ev(MEMBER, 'channel', { name: 'spam' }),
    ]).channels()

    return {
      nameOk: named.spaceName() === 'Book club',
      nameStaysPut: stolenName.spaceName() !== 'Mine now',
      founderIsAdmin: named.roleOf(FOUNDER) === 'admin',
      grabRefused: grabbed.roleOf(MEMBER) !== 'admin',
      promoteWorks: promoted.roleOf(MEMBER) === 'admin',
      chainWorks: chain.roleOf(THIRD) === 'admin',
      founderSurvives: coup.roleOf(FOUNDER) === 'admin',
      adminChannel: channels.includes('plans'),
      memberChannel: channels.includes('spam') === false,
    }
  })
  check('the founder names the space', roles.nameOk)
  check('a member cannot rename it', roles.nameStaysPut)
  check('the founder is its admin', roles.founderIsAdmin)
  check('a member cannot promote themselves', roles.grabRefused)
  check('an admin can promote somebody else', roles.promoteWorks)
  check('and the new admin can promote a third', roles.chainWorks)
  check('but nobody can depose the founder', roles.founderSurvives)
  check('an admin makes a channel', roles.adminChannel)
  check('a member does not', roles.memberChannel)

  // --- the order a conversation is read in ----------------------------------
  /*
   * Two people who have never synced, writing at known real times. A plain
   * counter gives them both low numbers and interleaves them by author, so the
   * later arrival lands at the top of somebody else's history. The clock this
   * log stamps has to put them in the order they were actually written.
   */
  const order = await page.evaluate(async () => {
    const { RoomLog, makeEvent } = await import('/src/store/log.ts')
    const wait = () => new Promise((r) => setTimeout(r, 20))
    const write = async (log, who, text) => {
      const e = await makeEvent('r', who, log.nextLamport(), 'said', { text })
      log.add(e)
      return e
    }
    const alice = new RoomLog('r')
    const bob = new RoomLog('r')
    const A = 'a'.repeat(64)
    const B = 'b'.repeat(64)

    const a1 = await write(alice, A, 'alice 1')
    await wait()
    const a2 = await write(alice, A, 'alice 2')
    await wait()
    const b1 = await write(bob, B, 'bob 1') // bob only turns up now, log empty
    await wait()
    const a3 = await write(alice, A, 'alice 3')

    const merged = new RoomLog('r')
    for (const e of [a1, a2, b1, a3]) merged.add(e)

    // And a reply must never sort above the thing it replies to, whatever the
    // clocks say, which is what the counter half of it is for.
    const late = new RoomLog('r')
    late.add(a3)
    const reply = await write(late, B, 'bob replies')

    return {
      merged: merged.messages().map((m) => m.text),
      causal: reply.lamport > a3.lamport,
    }
  })
  check(
    'a late arrival does not land at the top of the history',
    JSON.stringify(order.merged) === JSON.stringify(['alice 1', 'alice 2', 'bob 1', 'alice 3']),
    order.merged.join(' | '),
  )
  check('and a reply still sorts after what it replies to', order.causal)

  // --- everything written goes out ------------------------------------------
  /*
   * The bug this guards: naming yourself wrote a profile event to this device
   * and sent it nowhere, so everybody else saw a key instead of a name. Every
   * kind of event has to leave through the same hook, including the ones added
   * next year.
   */
  const outbound = await page.evaluate(async () => {
    const { RoomChat } = await import('/src/store/room-chat.ts')
    const chat = new RoomChat('outbound-test-room', 'K7M29QPTVB2W')
    const sent = []
    chat.onLocal = (e) => sent.push(e.kind)
    await chat.announceName('Alice')
    await chat.say('hello', 'general')
    await chat.makeChannel('plans')
    await chat.setSpaceName('Book club')
    await chat.claimFounder()
    return sent
  })
  for (const kind of ['profile', 'said', 'channel', 'space', 'role']) {
    check(`a ${kind} event is handed to the other people`, outbound.includes(kind), outbound.join(','))
  }

  // --- pictures and GIFs ----------------------------------------------------
  const pics = await page.evaluate(async () => {
    const { imageLinks } = await import('/src/ui/chat-panel.ts')
    return {
      gif: imageLinks('look https://example.com/cat.gif'),
      query: imageLinks('https://media.example.com/a/b.gif?width=200'),
      png: imageLinks('https://example.com/shot.png and https://example.com/x.webp'),
      plain: imageLinks('https://example.com/article'),
      insecure: imageLinks('http://example.com/cat.gif'),
      capped: imageLinks(
        [1, 2, 3, 4, 5, 6].map((n) => `https://example.com/${n}.gif`).join(' '),
      ).length,
      tricked: imageLinks('https://example.com/cat.gif.exe'),
    }
  })
  check('a GIF link becomes a GIF', pics.gif.length === 1, pics.gif.join())
  check('and one with a query string still does', pics.query.length === 1)
  check('so do the other picture kinds', pics.png.length === 2)
  check('an ordinary link is left as a link', pics.plain.length === 0)
  check('an insecure link is never fetched', pics.insecure.length === 0)
  check('and one message cannot post a wall of them', pics.capped === 4, `${pics.capped}`)
  check('something dressed up as a picture is not one', pics.tricked.length === 0)

  // --- the microphone -------------------------------------------------------
  const mic = await page.evaluate(async () => {
    const { micConstraints, micSettings, setMicSettings } = await import('/src/net/mic.ts')
    const before = micConstraints()
    setMicSettings({ ...micSettings(), denoise: false })
    const after = micConstraints()
    setMicSettings({ echo: true, denoise: true, gain: true })
    return { before, after }
  })
  check(
    'the microphone is cleaned up by default',
    mic.before.noiseSuppression === true && mic.before.echoCancellation === true,
    JSON.stringify(mic.before),
  )
  check('and the cleaning can be turned off for music', mic.after.noiseSuppression === false)

  // --- sounds --------------------------------------------------------------
  const sounds = await page.evaluate(async () => {
    const { isNews, soundsOn, setSounds } = await import('/src/ui/sounds.ts')
    const on = soundsOn()
    setSounds(false)
    const off = soundsOn() === false
    setSounds(on)
    return {
      backfillIsQuiet: isNews(Date.now() - 10 * 60_000) === false,
      freshIsNews: isNews(Date.now() - 1000),
      canBeTurnedOff: off,
    }
  })
  check('history arriving from a peer makes no noise', sounds.backfillIsQuiet)
  check('something said just now does', sounds.freshIsNews)
  check('and the whole lot can be turned off', sounds.canBeTurnedOff)
} finally {
  await browser.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} checks passed.`)
process.exit(passed === results.length ? 0 : 1)
