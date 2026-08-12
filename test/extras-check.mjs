/**
 * The rest of what a chat app is expected to have.
 *
 * Markdown, slash commands, private messages, avatars, channel labels and
 * topics, deleting a channel, an admin taking a message down, drafts, and the
 * keys that move you around. Two browsers, because half of it has to cross a
 * wire and mean the same thing on the other side.
 *
 *   node test/extras-check.mjs
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
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})

const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('cathode.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

async function say(page, text) {
  await page.click(BOX)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(350)
}

/** Type a message with real line breaks in it. */
async function sayLines(page, lines) {
  await page.click(BOX)
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await page.keyboard.down('Shift')
      await page.keyboard.press('Enter')
      await page.keyboard.up('Shift')
    }
    await page.keyboard.type(lines[i])
  }
  await page.keyboard.press('Enter')
  await page.waitForTimeout(350)
}

const texts = (page) =>
  page.$$eval('.chat-text', (els) => els.map((e) => e.textContent.trim()))

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'everything')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(900)
  const link = alice.url()

  const bob = await person('Bob')
  await bob.goto(link)
  await bob.waitForFunction(
    () => document.querySelector('.space-name')?.textContent === 'everything',
    null,
    { timeout: 60_000 },
  )

  // ---- markdown -----------------------------------------------------------
  await say(alice, '**bold** *italic* ~~struck~~ ||secret|| `code` and snake_case_word')
  await sayLines(alice, ['```js', 'const x = 1', '```'])
  await sayLines(alice, ['> quoted line', '- one', '- two'])

  const marks = await alice.evaluate(() => ({
    bold: !!document.querySelector('.chat-text strong'),
    italic: !!document.querySelector('.chat-text em'),
    struck: !!document.querySelector('.chat-text s'),
    spoiler: !!document.querySelector('.spoiler'),
    code: !!document.querySelector('.chat-text code'),
    fence: document.querySelector('.chat-code code')?.textContent ?? '',
    quote: document.querySelector('.chat-quote')?.textContent ?? '',
    list: document.querySelectorAll('.chat-list li').length,
    snake: (document.querySelector('.chat-text')?.textContent ?? '').includes('snake_case_word'),
  }))
  check('bold, italic and strikethrough', marks.bold && marks.italic && marks.struck)
  check('inline code and spoilers', marks.code && marks.spoiler)
  check('a fenced block keeps what was typed', marks.fence === 'const x = 1', marks.fence)
  check('a quote and a list', marks.quote.includes('quoted line') && marks.list === 2)
  check('an underscore inside a word is left alone', marks.snake === true)

  // A spoiler stays hidden until it is asked for.
  const hiddenFirst = await alice.$eval('.spoiler', (el) => el.classList.contains('shown'))
  await alice.click('.spoiler')
  const shownAfter = await alice.$eval('.spoiler', (el) => el.classList.contains('shown'))
  check('a spoiler opens on a click, and not before', !hiddenFirst && shownAfter)

  // ---- slash commands -----------------------------------------------------
  await say(alice, '/me waves at everybody')
  const emote = await alice.$eval('.chat-text.emote', (el) => el.textContent.trim())
  check('/me reads as something you did', emote === 'Alice waves at everybody', emote)

  await say(alice, '/shrug')
  const all = await texts(alice)
  check('/shrug survives the formatter intact', all[all.length - 1] === '¯\\_(ツ)_/¯', all[all.length - 1])

  await say(alice, '/nope')
  check('an unknown command is not posted to everybody', !(await texts(alice)).includes('/nope'))

  await say(alice, '//not a command')
  check('two slashes says one', (await texts(alice)).includes('/not a command'))

  // ---- nudges --------------------------------------------------------------
  // The 2004 classic. The window shakes on both ends, and nothing is written
  // into the log: a nudge is true for half a second and then it is not.
  await alice.fill(BOX, '/nudge')
  await alice.press(BOX, 'Enter')
  const bobShaken = await bob
    .waitForFunction(() => document.body.classList.contains('nudged'), null, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('a nudge shakes the other side', bobShaken)

  const aliceShaken = await alice.evaluate(
    () =>
      document.body.classList.contains('nudged') ||
      [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('You nudged')),
  )
  check('and the side that sent it', aliceShaken)

  await alice.fill(BOX, '/nudge')
  await alice.press(BOX, 'Enter')
  await alice.waitForTimeout(400)
  const rationed = await alice.evaluate(() =>
    [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Easy')),
  )
  check('a second nudge straight after is rationed', rationed)

  const logged = await texts(alice)
  check(
    'and none of it was posted to the room',
    !logged.some((t) => t.includes('/nudge')),
  )

  // ---- channel label, topic, and deleting one -----------------------------
  await say(alice, '/topic what we are doing today')
  await alice.waitForTimeout(500)
  const topic = await alice.$eval('.channel-topic', (el) => el.textContent)
  check('a channel can say what it is for', topic === 'what we are doing today', topic)

  await say(alice, '/rename The Main Room')
  await alice.waitForTimeout(600)
  const railed = await alice.$$eval('.rail-left .rail-item', (els) =>
    els.map((e) => e.textContent.trim()),
  )
  check('and be called something else', railed.some((r) => r.includes('The Main Room')), railed.join(' | '))

  const stillRoutes = await alice.evaluate(() =>
    [...document.querySelectorAll('.chat-text')].some((e) => e.textContent.includes('bold')),
  )
  check('renaming keeps everything that was said in it', stillRoutes)

  const seenByBob = await bob
    .waitForFunction(
      () => [...document.querySelectorAll('.rail-item')].some((e) => e.textContent.includes('The Main Room')),
      null,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('everybody else sees the new name', seenByBob)

  // A second channel, then taken away.
  alice.once('dialog', (d) => d.accept('scratch'))
  await alice.click('.rail-left button[title="Make a text channel"]')
  await alice.waitForTimeout(700)
  await say(alice, 'something in the scratch channel')
  const row = alice.locator('.rail-row', { hasText: 'scratch' })
  await row.locator('.person-more').evaluate((el) => el.focus())
  await row.locator('.person-more').click()
  await alice.waitForSelector('.menu')
  alice.once('dialog', (d) => d.accept())
  await alice.click('.menu-item:has-text("Delete it")')
  await alice.waitForTimeout(900)
  const afterDelete = await alice.$$eval('.rail-left .rail-item', (els) =>
    els.map((e) => e.textContent.trim()),
  )
  check('a channel can be deleted', !afterDelete.some((r) => r.includes('scratch')), afterDelete.join(' | '))
  check(
    'and what was said in it goes with it',
    !(await texts(alice)).some((t) => t.includes('scratch channel')),
  )

  // ---- an admin takes a message down --------------------------------------
  await say(bob, 'something regrettable')
  await alice.waitForFunction(
    () => [...document.querySelectorAll('.chat-text')].some((e) => e.textContent.includes('regrettable')),
    null,
    { timeout: 30_000 },
  )
  const bobsRow = alice.locator('.chat-row', { hasText: 'regrettable' })
  const remove = bobsRow.locator('button[aria-label="Delete this message"]')
  await remove.evaluate((el) => el.focus())
  alice.once('dialog', (d) => d.accept())
  await remove.click()
  await alice.waitForTimeout(800)
  check(
    'an admin can take down somebody else’s message',
    !(await texts(alice)).some((t) => t.includes('regrettable')),
  )
  const goneForBob = await bob
    .waitForFunction(
      () => ![...document.querySelectorAll('.chat-text')].some((e) => e.textContent.includes('regrettable')),
      null,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('and it goes for the person who wrote it too', goneForBob)

  // ---- private messages ---------------------------------------------------
  await say(alice, '/dm Bob a private word')
  await alice.waitForTimeout(900)
  const dmTitle = await alice.$eval('.chat-head .eyebrow', (el) => el.textContent)
  check('a private conversation opens on its own', dmTitle === 'Bob', dmTitle)
  check('and holds what was said', (await texts(alice)).includes('a private word'))

  const bobGot = await bob
    .waitForFunction(
      () => [...document.querySelectorAll('.rail-item')].some((e) => e.textContent.includes('Alice')),
      null,
      { timeout: 60_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('it reaches the person it is for', bobGot)

  await bob.click('.rail-item:has-text("Alice")')
  await bob.waitForTimeout(700)
  check('who can read it', (await texts(bob)).includes('a private word'))

  await say(bob, 'and one back')
  const backToAlice = await alice
    .waitForFunction(
      () => [...document.querySelectorAll('.chat-text')].some((e) => e.textContent.includes('one back')),
      null,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('and answer', backToAlice)

  /*
   * The room carries it and cannot read it. Checked against the stored event
   * rather than against the screen: the sealed body is what everybody else
   * holds, and the words must not be in it.
   */
  const sealed = await alice.evaluate(async () => {
    const { loadRoom, listRooms } = await import('/src/store/db.ts')
    const rooms = await listRooms()
    const events = await loadRoom(rooms[0].room)
    const dm = events.find((e) => e.kind === 'dm')
    return dm ? JSON.stringify(dm.body) : ''
  })
  check(
    'what the room stores is sealed',
    sealed.length > 0 && !sealed.includes('private word'),
    sealed.slice(0, 60),
  )

  await alice.click('button:has-text("Back")')
  await alice.waitForTimeout(400)

  // ---- drafts, and the keys ----------------------------------------------
  await alice.click(BOX)
  await alice.keyboard.type('half a thought')
  alice.once('dialog', (d) => d.accept('other'))
  await alice.click('.rail-left button[title="Make a text channel"]')
  await alice.waitForTimeout(700)
  check('switching channel empties the box', (await alice.inputValue(BOX)) === '')
  await alice.click('.rail-left .rail-item:has-text("The Main Room")')
  await alice.waitForTimeout(500)
  check(
    'and coming back puts the draft back',
    (await alice.inputValue(BOX)) === 'half a thought',
    await alice.inputValue(BOX),
  )
  await alice.fill(BOX, '')

  // Up on an empty box edits the last thing you said.
  await say(alice, 'the first draft')
  await alice.click(BOX)
  await alice.keyboard.press('ArrowUp')
  await alice.waitForTimeout(300)
  check('up edits your last message', (await alice.inputValue(BOX)) === 'the first draft')
  await alice.keyboard.press('Escape')
  check('escape puts it down again', (await alice.inputValue(BOX)) === '')

  // ---- avatars ------------------------------------------------------------
  const initials = await alice.$$eval('.chat-who .avatar', (els) =>
    els.map((e) => e.textContent.trim()),
  )
  check('everybody has a face from the start', initials.length > 0 && initials[0] === 'A', initials.join())

  const picture = await alice.evaluate(async () => {
    const { squareThumb } = await import('/src/ui/avatar.ts')
    // A tiny picture made here, so the test needs no file on disk.
    const canvas = document.createElement('canvas')
    canvas.width = 200
    canvas.height = 120
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#c0392b'
    ctx.fillRect(0, 0, 200, 120)
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'))
    const file = new File([blob], 'me.png', { type: 'image/png' })
    const url = await squareThumb(file)
    return { length: url.length, kind: url.slice(0, 20) }
  })
  check(
    'a picture is shrunk until it fits in one event',
    picture.length < 2600 && picture.kind.startsWith('data:image/'),
    `${picture.length} characters, ${picture.kind}`,
  )
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
}

await browser.close()

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
