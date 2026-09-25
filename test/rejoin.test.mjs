import { APP_URL, FAKE_MEDIA, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

async function waitFor(fn, ms, label) {
  const found = await poll(fn, ms, 400)
  if (!found) console.log(`  (gave up waiting for ${label}: ${JSON.stringify(found)})`)
  return found || null
}

const browser = await launch({ args: [...FAKE_MEDIA, '--allow-running-insecure-content'] })

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

  const twice = await open('Bob')
  await twice.goto(link)
  await twice.reload()
  await twice.waitForTimeout(2000)

  const settledAgain = await waitFor(
    async () => {
      const list = await roster(alice)
      return list.length === 2 ? list : null
    },
    30_000,
    'the second Bob to fold into the first',
  )
  const both = settledAgain ?? (await roster(alice))
  check(
    'the same name on a second device is not a second person',
    both.length === 2,
    both.map((r) => `${r.text}${r.away ? ' (away)' : ''}`).join(' | '),
  )
  check(
    'and the one shown is the one who is here',
    both.every((r) => !r.away),
    both.map((r) => `${r.text}${r.away ? ' (away)' : ''}`).join(' | '),
  )

  const alsoAlice = await open('Alice')
  await alsoAlice.goto(link)
  await alsoAlice.reload()
  await alsoAlice.waitForTimeout(2500)
  const self = await waitFor(
    async () => {
      const list = await roster(alice)
      return list.filter((r) => r.text.startsWith('Alice')).length === 1 && list.length === 2 ? list : null
    },
    20_000,
    'Alice to be shown once',
  ).catch(() => null)
  const selfRows = self ?? (await roster(alice))
  check(
    'your own name on another device is not a second you',
    !!self,
    selfRows.map((r) => r.text).join(' | '),
  )
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
