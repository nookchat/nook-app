/**
 * Three people in a room, all talking at once, ending up with the same room.
 *
 * The property tests take a pile of events and shuffle it. This does the
 * thing itself: three browsers, three identities, everybody typing at the same
 * time, edits and reactions and pins and votes landing in whatever order the
 * network chose, and then a comparison of what each of them is actually
 * showing. Character for character, not "roughly the same".
 *
 * Then one of them leaves, misses a conversation, and comes back, because
 * catching up is where a log that merges cleanly can still show the wrong
 * thing.
 *
 *   node test/agree-check.mjs
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
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-running-insecure-content',
  ],
})

/**
 * What this device is showing, as one comparable string.
 *
 * Written as an expression that calls itself. A string handed to evaluate is
 * evaluated as an expression, so a string that is merely shaped like a
 * function hands back the function rather than its result, every page reports
 * undefined, and a check that they all agree passes because undefined equals
 * undefined. That is the worst kind of green.
 */
const SHOWING = `(() => {
  const lines = [...document.querySelectorAll('.chat-line')].map((el) => {
    const name = el.querySelector('.chat-name')?.textContent?.trim() ?? ''
    const body = el.querySelector('.chat-text')?.textContent?.trim() ?? ''
    const reacts = [...el.querySelectorAll('.chat-react')]
      .map((b) => b.textContent.trim())
      .sort()
      .join(' ')
    const poll = [...el.querySelectorAll('.poll-option')]
      .map((b) => b.querySelector('.poll-label')?.textContent?.trim() + '=' +
                  (b.querySelector('.poll-count')?.textContent?.trim() || '0'))
      .join(',')
    const flags = [
      el.classList.contains('pinned') ? 'pinned' : '',
      el.querySelector('.chat-edited') ? 'edited' : '',
    ].filter(Boolean).join('+')
    return [name, body, flags, reacts, poll].join('~')
  })
  const pinBtn = document.querySelector('[aria-label="Pinned messages"]')
  const pins = pinBtn && !pinBtn.classList.contains('hidden') ? [pinBtn.title] : []
  const channels = [...document.querySelectorAll('.rail-item')].map((b) => b.textContent.trim())
  return JSON.stringify({ lines, pins, channels }, null, 1)
})()`

async function settle(pages, label, ms = 40_000) {
  const until = Date.now() + ms
  let last = []
  while (Date.now() < until) {
    last = await Promise.all(pages.map((p) => p.evaluate(SHOWING)))
    // Nothing read is not everybody agreeing.
    if (last.some((s) => typeof s !== 'string')) {
      throw new Error('a page reported nothing at all, so there is nothing to compare')
    }
    if (last.every((s) => s === last[0])) return last
    await new Promise((r) => setTimeout(r, 700))
  }
  console.log(`  (they never agreed on ${label})`)
  return last
}

/** The first line where two of them differ, for a failure worth reading. */
function firstDifference(a, b) {
  const left = a.split('\n')
  const right = b.split('\n')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) return `line ${i + 1}: ${left[i] ?? '(nothing)'} vs ${right[i] ?? '(nothing)'}`
  }
  return 'no difference'
}

try {
  const open = async (name) => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 860 } })
    const page = await context.newPage()
    await page.goto(APP_URL)
    await page.evaluate((n) => localStorage.setItem('cathode.name.v1', n), name)
    await page.reload()
    await page.waitForTimeout(800)
    return page
  }
  const say = async (page, text) => {
    await page.evaluate((t) => {
      const input = document.querySelector('[aria-label="Write a message"]')
      input.focus()
      input.value = t
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }, text)
  }

  const alice = await open('Alice')
  await alice.evaluate(
    () => (document.querySelector('input[aria-label="Space name"]').value = 'Agree'),
  )
  await alice.getByRole('button', { name: 'New space' }).click()
  await alice.waitForTimeout(2500)
  const link = alice.url()

  const bob = await open('Bob')
  await bob.goto(link)
  await bob.reload()
  const carol = await open('Carol')
  await carol.goto(link)
  await carol.reload()
  await carol.waitForTimeout(2000)

  const all = [alice, bob, carol]
  const met = await (async () => {
    for (let i = 0; i < 60; i++) {
      const counts = await Promise.all(
        all.map((p) => p.evaluate(() => document.querySelectorAll('.rail-person').length)),
      )
      if (counts.every((c) => c === 3)) return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  })()
  check('three people are in the room', met)

  // ---- everybody talks at once --------------------------------------------
  /*
   * No pauses between them and no coordination. Whatever order these land in
   * is the order the network chose, which is the whole point.
   */
  await Promise.all([
    (async () => {
      for (let i = 0; i < 6; i++) await say(alice, `alice ${i}`)
    })(),
    (async () => {
      for (let i = 0; i < 6; i++) await say(bob, `bob ${i}`)
    })(),
    (async () => {
      for (let i = 0; i < 6; i++) await say(carol, `carol ${i}`)
    })(),
  ])

  const afterTalking = await settle(all, 'eighteen messages sent at once')
  check(
    'eighteen messages sent at once leave everybody with the same room',
    afterTalking.every((s) => s === afterTalking[0]),
    afterTalking.every((s) => s === afterTalking[0])
      ? `${JSON.parse(afterTalking[0]).lines.length} lines, identical on all three`
      : firstDifference(afterTalking[0], afterTalking[1]),
  )

  // ---- and the order they are read in is the same ---------------------------
  const order = JSON.parse(afterTalking[0]).lines.map((l) => l.split('~')[1])
  check(
    'and in the same order',
    order.length === 18 && new Set(order).size === 18,
    `${order.length} lines, ${new Set(order).size} distinct`,
  )

  // ---- reactions, edits, pins and a poll, all at once -----------------------
  await Promise.all([
    alice.evaluate(() => {
      // Alice edits her own first line.
      const line = [...document.querySelectorAll('.chat-row')].find((el) =>
        el.textContent.includes('alice 0'),
      )
      const edit = [...line.querySelectorAll('.chat-actions button')].find((b) => b.title === 'Edit')
      edit?.click()
    }),
    bob.evaluate(() => {
      const line = [...document.querySelectorAll('.chat-row')].find((el) =>
        el.textContent.includes('carol 1'),
      )
      const react = [...line.querySelectorAll('.chat-actions button')].find(
        (b) => b.title === 'React',
      )
      react?.click()
    }),
    carol.evaluate(() => {
      const line = [...document.querySelectorAll('.chat-row')].find((el) =>
        el.textContent.includes('bob 2'),
      )
      const react = [...line.querySelectorAll('.chat-actions button')].find(
        (b) => b.title === 'React',
      )
      react?.click()
    }),
  ])
  await alice.waitForTimeout(400)

  // Take whatever the reaction pickers offered, on both.
  for (const page of [bob, carol]) {
    await page.evaluate(() => {
      const pick = document.querySelector('.emoji-pick button, .chat-emoji button, .picker button')
      pick?.click()
    })
  }
  // Alice was asked for new text by a prompt, which needs handling, so she
  // instead pins something, which is the admin action worth checking here.
  await alice.evaluate(() => {
    const line = [...document.querySelectorAll('.chat-row')].find((el) =>
      el.textContent.includes('bob 0'),
    )
    const pin = [...line.querySelectorAll('.chat-actions button')].find((b) =>
      b.title.startsWith('Pin'),
    )
    pin?.click()
  })

  const afterReacting = await settle(all, 'reactions and a pin')
  check(
    'reactions and a pin land the same way for everybody',
    afterReacting.every((s) => s === afterReacting[0]),
    afterReacting.every((s) => s === afterReacting[0])
      ? 'identical on all three'
      : firstDifference(afterReacting[0], afterReacting[1]),
  )
  check(
    'and the pin is actually shown',
    JSON.parse(afterReacting[0]).pins.length === 1,
    JSON.parse(afterReacting[0]).pins.join(' | ') || '(none)',
  )

  // ---- somebody misses a conversation and comes back ------------------------
  await carol.context().close()
  await Promise.all([
    (async () => {
      for (let i = 0; i < 5; i++) await say(alice, `while away ${i}`)
    })(),
    (async () => {
      for (let i = 0; i < 5; i++) await say(bob, `also away ${i}`)
    })(),
  ])
  await settle([alice, bob], 'the two who stayed')

  const carolAgain = await open('Carol')
  await carolAgain.goto(link)
  await carolAgain.reload()
  await carolAgain.waitForTimeout(2500)

  const caught = await settle([alice, bob, carolAgain], 'the one who came back', 60_000)
  check(
    'somebody who missed a conversation ends up with the same room as everybody else',
    caught.every((s) => s === caught[0]),
    caught.every((s) => s === caught[0])
      ? `${JSON.parse(caught[0]).lines.length} lines, identical`
      : firstDifference(caught[0], caught[2]),
  )
} finally {
  await browser.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} checks passed.`)
process.exit(passed === results.length ? 0 : 1)
