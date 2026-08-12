/**
 * Deep history sync: the pull protocol, and the floor that gates it.
 *
 * The backfill on a fresh link is the newest 250 events. This checks the part
 * that goes back for the rest:
 *
 *   1. A device that missed more than one backfill's worth of history asks
 *      for the slice below where its copy stops, round after round, until the
 *      two summaries agree. Six hundred events must all arrive.
 *   2. A device that trimmed under storage pressure asks for nothing, because
 *      it would only refuse what came back.
 *   3. A tidy that merely drops a retracted message must not raise the floor.
 *      It used to, which pinned every device at its own oldest message and
 *      quietly turned the answer to question 1 into "never".
 *
 *   node test/sync-check.mjs
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
  const sync = await page.evaluate(async () => {
    const { RoomChat } = await import('/src/store/room-chat.ts')
    const { makeEvent } = await import('/src/store/log.ts')

    const room = 'ab'.repeat(16)
    const a = new RoomChat(room, 'HISTORY')
    const said = []
    for (let i = 0; i < 600; i++) {
      said.push(
        await makeEvent(room, a.me, a.log.nextLamport(), 'said', {
          text: `message ${i}`,
          channel: 'general',
        }),
      )
    }
    for (const e of said) a.log.add(e)

    // B turns up empty, gets one backfill, and has to ask for the rest.
    const b = new RoomChat(room, 'HISTORY')
    const give = async (to, raws) => {
      for (const raw of raws) await to.ingest(raw)
    }
    await give(b, a.backfill())
    const afterBackfill = b.log.all().length

    let rounds = 0
    let lastBelow = -1
    for (;;) {
      const have = JSON.parse(a.summary())
      const below = b.wantPull(have)
      if (below === null || below === lastBelow) break
      lastBelow = below
      rounds += 1
      await give(b, a.below(below))
      if (rounds > 20) break
    }

    // A device that trimmed by choice asks for nothing.
    const c = new RoomChat(room, 'HISTORY')
    await give(c, a.backfill())
    c.log.floor = c.log.all()[0].lamport
    const trimmedAsks = c.wantPull(JSON.parse(a.summary()))

    // A tidy that only drops a retraction's target leaves the floor alone.
    const gone = said[300]
    a.log.add(
      await makeEvent(room, a.me, a.log.nextLamport(), 'retract', { target: gone.id }),
    )
    await a.tidy()

    return {
      afterBackfill,
      rounds,
      total: b.log.all().length,
      settled: b.wantPull(JSON.parse(a.summary())),
      trimmedAsks,
      floorAfterTidy: a.log.floor,
      tidiedAway: a.log.all().every((e) => e.id !== gone.id),
    }
  })

  check(
    'one backfill is one backfill',
    sync.afterBackfill === 250,
    `${sync.afterBackfill} events`,
  )
  check(
    'asking goes back for everything the backfill left out',
    sync.total === 600,
    `${sync.total} of 600, in ${sync.rounds} pulls`,
  )
  check('and takes as few rounds as the arithmetic allows', sync.rounds === 2, `${sync.rounds}`)
  check('once the summaries agree, nobody asks for anything', sync.settled === null)
  check('a device that trimmed by choice asks for nothing', sync.trimmedAsks === null)
  check(
    'a tidy that drops a retracted message leaves the floor alone',
    sync.floorAfterTidy === 0 && sync.tidiedAway,
    `floor ${sync.floorAfterTidy}`,
  )
} finally {
  await browser.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} checks passed.`)
process.exit(passed === results.length ? 0 : 1)
