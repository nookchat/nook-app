/**
 * Coming back.
 *
 * A person is their key. A session is a tab, and a tab that closes and opens
 * again is a new one, so a list keyed by session showed somebody who stepped
 * out and came back as two people: the row they left behind still carried
 * their name, and the new one had said nothing yet, so it had nothing to show
 * but a key.
 *
 * This walks that exact path: two people meet, one reloads, and the list has
 * to settle back to two rows with two names.
 *
 *   node test/rejoin-check.mjs
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

async function waitFor(fn, ms, label) {
  const until = Date.now() + ms
  let last
  while (Date.now() < until) {
    last = await fn()
    if (last) return last
    await new Promise((r) => setTimeout(r, 400))
  }
  console.log(`  (gave up waiting for ${label}: ${JSON.stringify(last)})`)
  return null
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-running-insecure-content',
  ],
})

/** The names shown in the members rail, in order. */
const roster = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.rail-person')].map((el) => ({
      text: (el.querySelector('.truncate')?.textContent ?? '').trim(),
      away: el.classList.contains('away'),
    })),
  )

try {
  const open = async (name) => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 820 } })
    const page = await context.newPage()
    await page.goto(APP_URL)
    await page.evaluate((n) => localStorage.setItem('cathode.name.v1', n), name)
    await page.reload()
    await page.waitForTimeout(700)
    return page
  }

  const alice = await open('Alice')
  await alice.evaluate(
    () => (document.querySelector('input[aria-label="Space name"]').value = 'Rejoin'),
  )
  await alice.getByRole('button', { name: 'New space' }).click()
  await alice.waitForTimeout(2500)
  const link = alice.url()

  /*
   * Said before Bob has ever heard of this place. He has to be given it when
   * he arrives, which is the whole promise of the thing: history is held by
   * the people who were there, and handed on when somebody turns up.
   */
  await alice.evaluate(() => document.querySelector('[aria-label="Write a message"]').focus())
  await alice.keyboard.type('said before you got here')
  await alice.keyboard.press('Enter')
  await alice.waitForTimeout(500)

  const bob = await open('Bob')
  await bob.goto(link)
  await bob.reload()
  await bob.waitForTimeout(1500)

  const gotHistory = await waitFor(
    async () =>
      bob.evaluate(() =>
        (document.querySelector('.chat-log')?.textContent ?? '').includes(
          'said before you got here',
        ),
      ),
    25_000,
    'Bob to be handed the history',
  )
  check('somebody arriving is given what was said before they came', !!gotHistory)

  // Both must see two people before anything is proved about coming back.
  const met = await waitFor(
    async () => {
      const rows = await roster(alice)
      return rows.length === 2 && rows.every((r) => r.text && !r.text.startsWith('#')) ? rows : null
    },
    25_000,
    'the two of them to see each other by name',
  )
  check(
    'two people in a space are two rows with two names',
    !!met,
    met ? met.map((r) => r.text).join(' | ') : (await roster(alice)).map((r) => r.text).join(' | '),
  )

  // Bob steps out and comes straight back with a new session.
  await bob.reload()
  await bob.waitForTimeout(1500)

  const settled = await waitFor(
    async () => {
      const rows = await roster(alice)
      return rows.length === 2 ? rows : null
    },
    25_000,
    'the roster to settle back to two',
  )
  const rows = settled ?? (await roster(alice))
  check(
    'coming back does not make a second copy of somebody',
    rows.length === 2,
    rows.map((r) => `${r.text}${r.away ? ' (away)' : ''}`).join(' | '),
  )
  check(
    'and the one who came back still has their name',
    rows.every((r) => r.text && !r.text.startsWith('#')),
    rows.map((r) => r.text).join(' | '),
  )

  // Bob closes for good. Alice should still know who he was, just not here.
  await bob.context().close()
  const gone = await waitFor(
    async () => {
      const list = await roster(alice)
      return list.some((r) => r.away) ? list : null
    },
    30_000,
    'Bob to be shown as away',
  )
  check(
    'somebody who leaves stays in the list, marked as not here',
    !!gone && gone.length === 2,
    (gone ?? (await roster(alice))).map((r) => `${r.text}${r.away ? ' (away)' : ''}`).join(' | '),
  )
} finally {
  await browser.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} checks passed.`)
process.exit(passed === results.length ? 0 : 1)
