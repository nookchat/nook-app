/**
 * Keeping the log small, and getting it onto another device.
 *
 *   node test/storage-check.mjs
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

const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1' })

try {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })

  const out = await page.evaluate(async () => {
    const { makeEvent, RoomLog } = await import('/src/store/log.ts')
    const { compact, DEFAULT_LIMITS } = await import('/src/store/compact.ts')
    const { loadIdentity } = await import('/src/store/identity.ts')

    /*
     * Compaction asks the log which events counted rather than guessing, so a
     * test of compaction has to build the log first. That is the point of the
     * argument: two places deciding the same question is how the real edit of
     * a message used to get thrown away in favour of somebody else's.
     */
    const logOf = (list) => {
      const log = new RoomLog('room')
      log.founder = list[0]?.author ?? ''
      for (const e of list) log.add(e)
      return log
    }
    const me = loadIdentity().pubkey
    const room = 'r'
    let clock = 0
    const ev = (kind, body) => makeEvent(room, me, ++clock, kind, body)

    // A message, edited three times, reacted to and un-reacted to.
    const said = await ev('said', { text: 'one', channel: 'general' })
    const events = [said]
    for (const text of ['two', 'three', 'four']) {
      events.push(await ev('edit', { target: said.id, text }))
    }
    events.push(await ev('react', { target: said.id, emoji: '👍', on: true }))
    events.push(await ev('react', { target: said.id, emoji: '👍', on: false }))
    for (const name of ['A', 'B', 'C']) events.push(await ev('profile', { name }))

    // A second message, retracted.
    const gone = await ev('said', { text: 'regret', channel: 'general' })
    events.push(gone, await ev('retract', { target: gone.id }))

    const before = events.length
    const { keep, drop } = compact(events, DEFAULT_LIMITS, logOf(events).effective())

    // Plenty of messages, to see the per channel limit bite.
    const many = []
    for (let i = 0; i < 60; i++) many.push(await ev('said', { text: `m${i}`, channel: 'general' }))
    const trimmed = compact(many, { perChannel: 20, total: 100 }, logOf(many).effective())

    return {
      before,
      after: keep.length,
      dropped: drop.length,
      kinds: keep.map((e) => e.kind).sort(),
      trimmedFrom: many.length,
      trimmedTo: trimmed.keep.length,
    }
  })

  check('compaction throws away what is superseded', out.after < out.before, `${out.before} → ${out.after}`)
  check(
    'only the newest edit and the newest profile survive',
    out.kinds.filter((k) => k === 'edit').length === 1 &&
      out.kinds.filter((k) => k === 'profile').length === 1,
    out.kinds.join(', '),
  )
  check(
    'a retracted message goes but its tombstone stays',
    out.kinds.includes('retract') && out.kinds.filter((k) => k === 'said').length === 1,
    out.kinds.join(', '),
  )
  check('history past the limit is trimmed', out.trimmedTo <= 21, `${out.trimmedFrom} → ${out.trimmedTo}`)

  // Export, then import into a browser that has never seen any of it.
  const bundle = await page.evaluate(async () => {
    const { exportAll } = await import('/src/store/transfer.ts')
    const { putEvents, noteRoom } = await import('/src/store/db.ts')
    const { makeEvent } = await import('/src/store/log.ts')
    const { loadIdentity } = await import('/src/store/identity.ts')

    /*
     * Compaction asks the log which events counted rather than guessing, so a
     * test of compaction has to build the log first. That is the point of the
     * argument: two places deciding the same question is how the real edit of
     * a message used to get thrown away in favour of somebody else's.
     */
    const logOf = (list) => {
      const log = new RoomLog('room')
      log.founder = list[0]?.author ?? ''
      for (const e of list) log.add(e)
      return log
    }
    const me = loadIdentity().pubkey
    const said = await makeEvent('movingroom', me, 1, 'said', { text: 'carried across', channel: 'general' })
    await putEvents([said])
    await noteRoom({ room: 'movingroom', secret: 'X'.repeat(25), lastSeen: Date.now(), title: '' })
    return JSON.stringify(await exportAll(false))
  })
  check('an export contains the spaces on this device', bundle.includes('movingroom'))

  const fresh = await (await browser.newContext()).newPage()
  await fresh.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  const imported = await fresh.evaluate(async (text) => {
    const { importBundle } = await import('/src/store/transfer.ts')
    const { loadRoom } = await import('/src/store/db.ts')
    const report = await importBundle(text, false)
    const events = await loadRoom('movingroom')
    return { report, texts: events.map((e) => e.body.text) }
  }, bundle)
  check(
    'importing on another device brings the messages with it',
    imported.texts.includes('carried across'),
    `${imported.report.accepted} accepted, ${imported.report.refused} refused`,
  )

  const forged = await fresh.evaluate(async (text) => {
    const bundle = JSON.parse(text)
    for (const space of bundle.spaces) {
      for (const e of space.events) e.body = { text: 'not what was signed', channel: 'general' }
    }
    const { importBundle } = await import('/src/store/transfer.ts')
    return importBundle(JSON.stringify(bundle), false)
  }, bundle)
  check(
    'a doctored file is refused event by event',
    forged.accepted === 0 && forged.refused > 0,
    `${forged.accepted} accepted, ${forged.refused} refused`,
  )

  /*
   * A locked space carried across whole.
   *
   * The room id is derived from the code and the password together, so an
   * import that keeps four fields and drops the rest hands the new device a
   * space it cannot open: the list offers it, the code alone derives a
   * different and empty room, and the name in the list belongs to a room
   * nobody can reach.
   */
  const carried = await fresh.evaluate(async () => {
    const { exportAll, importBundle } = await import('/src/store/transfer.ts')
    const { noteRoom, getRoom } = await import('/src/store/db.ts')
    await noteRoom({
      room: 'lockedroom',
      secret: 'ABCDEFGH1234',
      lastSeen: Date.now(),
      title: 'vault',
      locked: true,
      password: 'hunter2',
      founder: 'f'.repeat(64),
      closed: undefined,
    })
    const bundle = JSON.stringify(await exportAll(false))
    // A device that has never seen it: the note is removed, then read back in.
    const { forgetRoom } = await import('/src/store/db.ts')
    await forgetRoom('lockedroom')
    await importBundle(bundle, false)
    return await getRoom('lockedroom')
  })
  check(
    'a locked space survives an export and an import',
    carried?.locked === true && carried?.password === 'hunter2' && carried?.founder === 'f'.repeat(64),
    JSON.stringify({ locked: carried?.locked, password: carried?.password, title: carried?.title }),
  )
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} of ${results.length} checks passed.`)
process.exit(failed === 0 ? 0 : 1)
