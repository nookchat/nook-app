import { APP_URL, FAKE_MEDIA, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'

const browser = await launch({ args: [...FAKE_MEDIA, '--allow-running-insecure-content'] })

// It must call itself: a string shaped like a function evaluates to undefined on every page, and undefined agrees.
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
    if (last.some((s) => typeof s !== 'string')) {
      throw new Error('a page reported nothing at all, so there is nothing to compare')
    }
    if (last.every((s) => s === last[0])) return last
    await wait(700)
  }
  console.log(`  (they never agreed on ${label})`)
  return last
}

function firstDifference(a, b) {
  const left = a.split('\n')
  const right = b.split('\n')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) return `line ${i + 1}: ${left[i] ?? '(nothing)'} vs ${right[i] ?? '(nothing)'}`
  }
  return 'no difference'
}

const agreed = (showing) => showing.every((s) => s === showing[0])

const open = async (name) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 860 } })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
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

const sayMany = async (page, prefix, count) => {
  for (let i = 0; i < count; i++) await say(page, `${prefix} ${i}`)
}

try {
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
  const met = await poll(async () => {
    const counts = await Promise.all(
      all.map((p) => p.evaluate(() => document.querySelectorAll('.rail-person').length)),
    )
    return counts.every((c) => c === 3)
  }, 30_000, 500)
  check('three people are in the room', met)

  await Promise.all([sayMany(alice, 'alice', 6), sayMany(bob, 'bob', 6), sayMany(carol, 'carol', 6)])

  const afterTalking = await settle(all, 'eighteen messages sent at once')
  check(
    'eighteen messages sent at once leave everybody with the same room',
    agreed(afterTalking),
    agreed(afterTalking)
      ? `${JSON.parse(afterTalking[0]).lines.length} lines, identical on all three`
      : firstDifference(afterTalking[0], afterTalking[1]),
  )

  const order = JSON.parse(afterTalking[0]).lines.map((l) => l.split('~')[1])
  check(
    'and in the same order',
    order.length === 18 && new Set(order).size === 18,
    `${order.length} lines, ${new Set(order).size} distinct`,
  )

  await Promise.all([
    alice.evaluate(() => {
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

  for (const page of [bob, carol]) {
    await page.evaluate(() => {
      const pick = document.querySelector('.emoji-pick button, .chat-emoji button, .picker button')
      pick?.click()
    })
  }
  // The edit asks for new text in a prompt, so Alice pins a line instead.
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
    agreed(afterReacting),
    agreed(afterReacting) ? 'identical on all three' : firstDifference(afterReacting[0], afterReacting[1]),
  )
  check(
    'and the pin is actually shown',
    JSON.parse(afterReacting[0]).pins.length === 1,
    JSON.parse(afterReacting[0]).pins.join(' | ') || '(none)',
  )

  await carol.context().close()
  await Promise.all([sayMany(alice, 'while away', 5), sayMany(bob, 'also away', 5)])
  await settle([alice, bob], 'the two who stayed')

  const carolAgain = await open('Carol')
  await carolAgain.goto(link)
  await carolAgain.reload()
  await carolAgain.waitForTimeout(2500)

  const caught = await settle([alice, bob, carolAgain], 'the one who came back', 60_000)
  check(
    'somebody who missed a conversation ends up with the same room as everybody else',
    agreed(caught),
    agreed(caught) ? `${JSON.parse(caught[0]).lines.length} lines, identical` : firstDifference(caught[0], caught[2]),
  )
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
