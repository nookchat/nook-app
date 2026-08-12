/**
 * Everybody sees the same thing.
 *
 * This is the promise the whole design rests on. There is no server deciding
 * what a room contains, so every device works it out from the events it holds,
 * and two devices holding the same events must reach the same answer. Not a
 * similar answer. The same one, character for character.
 *
 * Events arrive in whatever order the network felt like. A reply can turn up
 * before the thing it replies to; a vote before its poll; a promotion before
 * the person being promoted has said a word. None of that may change the
 * result, so the way to test it is to stop reasoning about orders and try
 * them: build a pile of events, shuffle it many ways, and check every shuffle
 * renders identically.
 *
 * The shuffles are seeded, so a failure is reproducible rather than a story
 * about something that happened once.
 *
 *   node test/converge-check.mjs
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
page.on('pageerror', (e) => console.log('  [page error]', String(e)))

/**
 * Everything below runs in the page, because the log is the thing under test
 * and it is a browser module that wants real crypto.
 */
const HARNESS = `
  const { RoomLog, makeEvent } = await import('/src/store/log.ts')
  const { compact, DEFAULT_LIMITS, TIGHT_LIMITS } = await import('/src/store/compact.ts')

  /** A seeded shuffle, so a failure can be looked at again. */
  const rng = (seed) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const shuffled = (list, seed) => {
    const out = [...list]
    const next = rng(seed)
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  const KEYS = [1, 2, 3, 4].map((n) => String(n).repeat(64).slice(0, 64))
  const [ALICE, BOB, CAROL, MALLORY] = KEYS

  /**
   * Everything a device would draw, flattened into one string.
   *
   * Comparing rendered output rather than the event set is the point: two logs
   * holding the same events is not the claim. The claim is that they say the
   * same thing.
   */
  const shape = (log) => {
    const parts = []
    parts.push('space=' + log.spaceName())
    parts.push('channels=' + log.channels().join(','))
    parts.push('voice=' + log.channels(true).join(','))
    parts.push('roles=' + [...log.roles().entries()].sort().map(([k, v]) => k.slice(0, 4) + ':' + v).join(','))
    parts.push('names=' + [...log.names().entries()].sort().map(([k, v]) => k.slice(0, 4) + '=' + v).join(','))
    parts.push('pinned=' + [...log.pinned()].sort().map((id) => id.slice(0, 6)).join(','))
    parts.push('reset=' + log.resetAt())
    for (const channel of ['general', 'plans']) {
      for (const m of log.messages(channel)) {
        const reacts = [...m.reactions.entries()]
          .sort()
          .map(([e, who]) => e + ':' + [...who].sort().map((k) => k.slice(0, 4)).join('+'))
          .join(' ')
        const poll = m.poll
          ? 'poll[' + m.poll.options.join('|') + ']=' +
            m.poll.options
              .map((_, i) => (m.poll.votes.get(i) ?? new Set()).size)
              .join('/') + ' total=' + m.poll.total
          : ''
        parts.push(
          [channel, m.id.slice(0, 6), m.author.slice(0, 4), m.name, m.text, m.edited ? 'edited' : '',
           m.pinned ? 'pinned' : '', reacts, poll].join('~'),
        )
      }
    }
    return parts.join('\\n')
  }

  const build = (events, me = ALICE, founder = ALICE) => {
    const log = new RoomLog('room')
    log.founder = founder
    log.me = me
    for (const e of events) log.add(e)
    return log
  }
`

try {
  // ---- a pile of events that exercises every kind ---------------------------
  const made = await page.goto(APP_URL).then(() =>
    page.evaluate(
      new Function(`return (async () => {
        ${HARNESS}
        window.__h = { RoomLog, makeEvent, compact, DEFAULT_LIMITS, TIGHT_LIMITS, shuffled, shape, build, KEYS }

        /*
         * Signed for real, because openEvent is not what is being tested here
         * but makeEvent stamps the id from the content and the id is half of
         * the sort order. A hand written id would test a different program.
         */
        let clock = 1000
        const ev = async (author, kind, body) => {
          clock += 1
          return makeEvent('room', author, clock, kind, body)
        }

        const events = []
        const push = async (...args) => {
          const e = await ev(...args)
          events.push(e)
          return e
        }

        await push(ALICE, 'space', { name: 'The Place' })
        await push(ALICE, 'profile', { name: 'Alice' })
        await push(BOB, 'profile', { name: 'Bob' })
        await push(CAROL, 'profile', { name: 'Carol' })
        await push(ALICE, 'role', { subject: BOB, role: 'admin' })
        await push(ALICE, 'channel', { name: 'plans' })
        await push(BOB, 'channel', { name: 'lounge', voice: true })

        const m1 = await push(ALICE, 'said', { text: 'first', channel: 'general' })
        const m2 = await push(BOB, 'said', { text: 'second', channel: 'general' })
        const m3 = await push(CAROL, 'said', { text: 'in plans', channel: 'plans' })
        const m4 = await push(CAROL, 'said', { text: 'to be retracted', channel: 'general' })

        await push(ALICE, 'edit', { target: m1.id, text: 'first, edited' })
        await push(BOB, 'react', { target: m1.id, emoji: '👍', on: true })
        await push(CAROL, 'react', { target: m1.id, emoji: '👍', on: true })
        await push(CAROL, 'react', { target: m1.id, emoji: '👍', on: false })
        await push(BOB, 'pin', { target: m2.id, on: true })
        await push(CAROL, 'retract', { target: m4.id })

        const poll = await push(ALICE, 'poll', {
          question: 'Pizza?', options: ['Yes', 'No'], channel: 'general',
        })
        await push(BOB, 'vote', { target: poll.id, choice: 0 })
        await push(CAROL, 'vote', { target: poll.id, choice: 1 })
        await push(CAROL, 'vote', { target: poll.id, choice: 0 })

        // Things that must be refused, whatever order they arrive in.
        await push(MALLORY, 'role', { subject: MALLORY, role: 'admin' })
        await push(MALLORY, 'space', { name: 'Mine' })
        await push(MALLORY, 'channel', { name: 'spam' })
        await push(MALLORY, 'pin', { target: m1.id, on: true })
        await push(MALLORY, 'edit', { target: m1.id, text: 'not yours to edit' })
        await push(MALLORY, 'retract', { target: m2.id })

        window.__events = events
        return events.length
      })()`),
    ),
  )
  check('a pile of every kind of event was built', made > 20, `${made} events`)

  // ---- order must not matter ------------------------------------------------
  const orders = await page.evaluate(() => {
    const { shuffled, shape, build, KEYS } = window.__h
    const events = window.__events
    const first = shape(build(events))
    const bad = []
    for (let seed = 1; seed <= 200; seed++) {
      const got = shape(build(shuffled(events, seed)))
      if (got !== first) bad.push(seed)
    }
    return { first, bad, tried: 200 }
  })
  check(
    'two hundred arrival orders all render the same thing',
    orders.bad.length === 0,
    orders.bad.length ? `differed on seeds ${orders.bad.slice(0, 5).join(', ')}` : 'identical',
  )

  // ---- and what it renders is actually right --------------------------------
  const right = await page.evaluate(() => {
    const { shape, build } = window.__h
    return shape(build(window.__events))
  })
  check('an edit by somebody else is refused', !right.includes('not yours to edit'), '')
  check('a retraction by somebody else is refused', right.includes('~second~'), '')
  check("a stranger's pin does not stick", !right.includes('first, edited~edited~pinned'), '')
  check('a stranger cannot rename the space', right.includes('space=The Place'), '')
  check('a stranger cannot make a channel', !right.includes('spam'), '')
  check('a retracted message is gone', !right.includes('to be retracted'), '')
  check('a reaction taken back is taken back', right.includes('👍:2222'), right.split('\n').find((l) => l.includes('👍')) ?? '')
  check('a moved vote is not two votes', right.includes('total=2'), right.split('\n').find((l) => l.includes('poll')) ?? '')

  // ---- partition, then merge ------------------------------------------------
  const merged = await page.evaluate(() => {
    const { shuffled, shape, build } = window.__h
    const events = window.__events
    const bad = []
    for (let seed = 1; seed <= 60; seed++) {
      const mixed = shuffled(events, seed)
      const half = Math.floor(mixed.length / 2)
      // Two devices see different halves, then trade.
      const left = build([...mixed.slice(0, half), ...mixed.slice(half)])
      const right = build([...mixed.slice(half), ...mixed.slice(0, half)])
      if (shape(left) !== shape(right)) bad.push(seed)
    }
    return bad
  })
  check(
    'two devices that were apart agree once they have traded',
    merged.length === 0,
    merged.length ? `differed on ${merged.length} splits` : 'identical every time',
  )

  // ---- adding the same event twice ------------------------------------------
  const twice = await page.evaluate(() => {
    const { shape, build } = window.__h
    const events = window.__events
    return shape(build(events)) === shape(build([...events, ...events]))
  })
  check('hearing the same event twice changes nothing', twice)

  // ---- compaction must not change what a device says ------------------------
  /*
   * Compaction throws events away to stay inside a browser's storage. That is
   * fine only if what is thrown away was adding nothing: a device that has
   * compacted and one that has not must still render the same room, or the two
   * of them are looking at different histories and neither knows.
   */
  const afterCompact = await page.evaluate(() => {
    const { shape, build, compact, DEFAULT_LIMITS } = window.__h
    const events = window.__events
    const before = shape(build(events))
    const { keep } = compact(events, DEFAULT_LIMITS, build(events).effective())
    const after = shape(build(keep))
    return { same: before === after, before, after, kept: keep.length, was: events.length }
  })
  check(
    'compacting a small room changes nothing about it',
    afterCompact.same,
    `${afterCompact.was} events to ${afterCompact.kept}`,
  )

  /*
   * The case that actually bites, and the honest answer to it.
   *
   * Trimming is the one thing that makes two devices disagree: whoever trimmed
   * is looking at a shorter room than whoever did not, and neither knows. That
   * cannot be avoided on a device that is genuinely out of storage. What can
   * be avoided is doing it to everybody for no reason, which a limit that
   * applies whether or not there is any pressure does.
   *
   * So the guarantee is: a device with room keeps everything, and two devices
   * with room always agree exactly. Only a device actually running out loses
   * anything, and then it is that device's problem rather than the room's.
   */
  const healthy = await page.evaluate(async () => {
    const { RoomLog, makeEvent, shape, compact, KEYS } = window.__h
    const { limitsForNow, NO_LIMITS } = await import('/src/store/compact.ts')
    const [ALICE] = KEYS

    const events = []
    let clock = 1000
    events.push(await makeEvent('room', ALICE, ++clock, 'space', { name: 'Busy' }))
    for (let i = 0; i < 400; i++) {
      events.push(await makeEvent('room', ALICE, ++clock, 'said', { text: 'm' + i, channel: 'general' }))
    }
    const build = (list) => {
      const log = new RoomLog('room')
      log.founder = ALICE
      log.me = ALICE
      for (const e of list) log.add(e)
      return log
    }
    const limits = await limitsForNow()
    const kept = compact(events, limits, build(events).effective()).keep
    return {
      unlimited: limits.perChannel === NO_LIMITS.perChannel,
      same: shape(build(kept)) === shape(build(events)),
      kept: kept.length,
      was: events.length,
    }
  })
  check(
    'a device with room to spare throws nothing away',
    healthy.unlimited && healthy.same,
    `${healthy.was} events, ${healthy.kept} kept`,
  )

  const differentLimits = await page.evaluate(async () => {
    const { RoomLog, makeEvent, shape, compact, DEFAULT_LIMITS, TIGHT_LIMITS, KEYS } = window.__h
    const [ALICE] = KEYS

    const events = []
    let clock = 1000
    events.push(await makeEvent('room', ALICE, ++clock, 'space', { name: 'Busy' }))
    events.push(await makeEvent('room', ALICE, ++clock, 'profile', { name: 'Alice' }))
    // More than the tight limit and fewer than the loose one, so the two
    // devices genuinely land in different places.
    for (let i = 0; i < 400; i++) {
      events.push(await makeEvent('room', ALICE, ++clock, 'said', { text: 'm' + i, channel: 'general' }))
    }

    const build = (list) => {
      const log = new RoomLog('room')
      log.founder = ALICE
      log.me = ALICE
      for (const e of list) log.add(e)
      return log
    }
    const all = build(events).effective()
    const roomy = compact(events, DEFAULT_LIMITS, all).keep
    const cramped = compact(events, TIGHT_LIMITS, all).keep
    /*
     * The room itself and what was said in it are compared separately. The
     * headers, meaning the name, the channels, who runs it, must match exactly
     * on both. Only the old end of the conversation may be missing, and what
     * is left of it has to read the same word for word.
     */
    const split = (text) => {
      const lines = text.split('\n')
      const at = lines.findIndex((l) => l.startsWith('general~') || l.startsWith('plans~'))
      return at === -1 ? { head: lines, body: [] } : { head: lines.slice(0, at), body: lines.slice(at) }
    }
    const wide = split(shape(build(roomy)))
    const tight = split(shape(build(cramped)))
    const tail = wide.body.slice(wide.body.length - tight.body.length)

    return {
      tailMatches:
        wide.head.join('|') === tight.head.join('|') &&
        tight.body.length < wide.body.length &&
        tail.join('\n') === tight.body.join('\n'),
      roomy: roomy.length,
      cramped: cramped.length,
    }
  })
  /*
   * And when it does happen, it is only the old end that goes. A device short
   * of storage must see less; it must not see something different. The newest
   * history, which is what anybody is actually reading, has to match.
   */
  check(
    'a device short of storage sees less, not something else',
    differentLimits.tailMatches,
    `${differentLimits.roomy} kept against ${differentLimits.cramped}`,
  )

  /*
   * And the loop that follows from it. A device that trimmed old messages is
   * handed them straight back by a peer that did not, trims them again, and is
   * handed them again, for as long as both are open. Nothing breaks, and
   * nothing settles either.
   */
  const churn = await page.evaluate(async () => {
    const { RoomLog, makeEvent, compact, TIGHT_LIMITS, KEYS } = window.__h
    const [ALICE] = KEYS
    const events = []
    let clock = 1000
    for (let i = 0; i < 400; i++) {
      events.push(
        await makeEvent('room', ALICE, ++clock, 'said', { text: 'm' + i, channel: 'general' }),
      )
    }
    const build = (list) => {
      const log = new RoomLog('room')
      log.founder = ALICE
      log.me = ALICE
      for (const e of list) log.add(e)
      return log
    }

    // A device short of room trims, and marks how far back it will now go.
    const log = build(events)
    const kept = compact(events, TIGHT_LIMITS, log.effective()).keep
    let floor = Infinity
    for (const e of kept) if (e.kind === 'said' && e.lamport < floor) floor = e.lamport
    log.replace(kept)
    log.floor = floor

    // A peer that still has the lot hands it over, as peers do.
    let takenBack = 0
    for (const e of events) if (log.add(e)) takenBack += 1

    return { trimmed: kept.length, takenBack, holding: log.size }
  })
  check(
    'a device that trimmed is not handed it all straight back',
    churn.takenBack === 0,
    `${churn.takenBack} trimmed events were taken back, holding ${churn.holding}`,
  )

  // ---- one bad clock must not poison the room -------------------------------
  /*
   * The clock starts from the wall clock so that a conversation reads in the
   * order it happened. That means a device whose clock is wrong writes numbers
   * from its own idea of now, and every device that hears it takes the higher
   * number. One machine set to 2099 could drag the whole room's ordering there
   * for good, and every message after it would sort above everything real.
   */
  const clock = await page.evaluate(async () => {
    const { RoomLog, makeEvent, KEYS } = window.__h
    const [ALICE, BOB] = KEYS

    const sane = new RoomLog('room')
    sane.founder = ALICE
    const normal = await makeEvent('room', ALICE, sane.nextLamport(), 'said', {
      text: 'now', channel: 'general',
    })
    sane.add(normal)

    // A century ahead, which is what a wrong clock or a hostile peer sends.
    const mad = await makeEvent('room', BOB, Date.now() + 100 * 365 * 24 * 3600 * 1000, 'said', {
      text: 'from the future', channel: 'general',
    })
    sane.add(mad)

    const next = sane.nextLamport()
    return {
      poisoned: next > Date.now() + 10 * 60 * 1000,
      aheadMinutes: Math.round((next - Date.now()) / 60000),
      // The mad event still sorts where it says it does, because every device
      // sorts by what the event carries and they all agree on that.
      stillOrdered: sane.messages('general').map((m) => m.text).join(' then '),
    }
  })
  check(
    'a device with a mad clock does not drag the room after it',
    clock.poisoned === false,
    `our next message lands ${clock.aheadMinutes} minutes ahead`,
  )
  check(
    'and its message still sorts where it claims, so nobody disagrees',
    clock.stillOrdered === 'now then from the future',
    clock.stillOrdered,
  )

} finally {
  await browser.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} checks passed.`)
process.exit(passed === results.length ? 0 : 1)
