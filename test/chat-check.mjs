/**
 * The things a chat app is expected to have.
 *
 * Typing indicators, unread marks, mentions, search, threads, multi-line
 * messages and the polish around them. Two browsers for anything that has to
 * cross a wire, one for anything that does not.
 *
 *   node test/chat-check.mjs
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
  const page = await (await browser.newContext()).newPage()
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
  await page.waitForTimeout(400)
}

const texts = (page) =>
  page.$$eval('.chat-line', (els) =>
    els.map((e) => e.querySelector('.chat-text')?.textContent ?? ''),
  )

/** The action bar is faded until hovered, so reach it the way a keyboard does. */
async function pressAction(page, label, index = 0) {
  const button = page.locator('.chat-row').nth(index).locator(`button[aria-label="${label}"]`)
  await button.evaluate((el) => el.focus())
  await button.click()
}

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'the office')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(1000)
  const link = alice.url()

  const bob = await person('Bob')
  await bob.goto(link)
  await bob.waitForFunction(
    () => document.querySelector('.space-name')?.textContent === 'the office',
    null,
    { timeout: 60_000 },
  )

  // ---- multi-line ---------------------------------------------------------
  await alice.click(BOX)
  await alice.keyboard.type('line one')
  await alice.keyboard.down('Shift')
  await alice.keyboard.press('Enter')
  await alice.keyboard.up('Shift')
  await alice.keyboard.type('line two')
  const halfway = await alice.inputValue(BOX)
  check('shift and enter make a line rather than sending', halfway === 'line one\nline two', JSON.stringify(halfway))

  await alice.keyboard.press('Enter')
  await alice.waitForTimeout(500)
  check('enter sends it', (await alice.inputValue(BOX)) === '')
  const both = await alice.$eval('.chat-line .chat-text', (el) => ({
    text: el.textContent,
    breaks: el.querySelectorAll('br').length,
  }))
  check(
    'and both lines are one message with a break in it',
    both.breaks === 1 && both.text === 'line oneline two',
    JSON.stringify(both),
  )

  // ---- typing indicators --------------------------------------------------
  await bob.click(BOX)
  await bob.keyboard.type('thinking')
  const sawTyping = await alice
    .waitForFunction(
      () => {
        const line = document.querySelector('.chat-typing')
        return line && !line.classList.contains('hidden') && line.textContent.includes('Bob')
      },
      null,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('somebody typing shows up for everybody else', sawTyping)

  // It stops on its own. Nothing is written down, so nothing has to be undone.
  const stopped = await alice
    .waitForFunction(
      () => document.querySelector('.chat-typing')?.classList.contains('hidden'),
      null,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('and stops on its own when they stop', stopped)
  await bob.fill(BOX, '')

  // ---- mentions -----------------------------------------------------------
  await alice.click(BOX)
  await alice.keyboard.type('@Bo')
  await alice.waitForSelector('.mention-pop', { timeout: 5000 })
  const offered = await alice.$$eval('.mention-option', (els) => els.map((e) => e.textContent))
  check('typing an @ offers the people in the room', offered.includes('Bob'), offered.join())

  await alice.keyboard.press('Enter')
  const completed = await alice.inputValue(BOX)
  check('and completing one writes the whole name', completed === '@Bob ', JSON.stringify(completed))

  await alice.keyboard.type('can you look at this')
  await alice.keyboard.press('Enter')
  await alice.waitForTimeout(1500)

  const litUp = await bob
    .waitForFunction(() => document.querySelectorAll('.chat-line.calls-me').length === 1, null, {
      timeout: 30_000,
    })
    .then(() => true)
    .catch(() => false)
  check('being named lights the message up for the person named', litUp)

  const notMine = await alice.$$eval('.chat-line.calls-me', (els) => els.length)
  check('and not for everybody else', notMine === 0, `${notMine}`)

  const mentionMark = await bob.$eval('.mention', (el) => ({
    text: el.textContent,
    me: el.classList.contains('me'),
  }))
  check('the name itself is marked', mentionMark.text === '@Bob' && mentionMark.me, JSON.stringify(mentionMark))

  // ---- unread -------------------------------------------------------------
  // Making channels is an admin's act, so Bob is not even offered the button.
  const plusHidden = await bob.$eval('button[title="Make a text channel"]', (el) =>
    el.classList.contains('hidden'),
  )
  check('a member is not offered the channel button', plusHidden)

  // Alice makes a second channel and Bob stands in it, so the first goes unread.
  alice.once('dialog', (d) => d.accept('random'))
  await alice.click('.rail-left button[title="Make a text channel"]')
  await alice.waitForFunction(() => document.querySelector('.space-head .eyebrow')?.textContent === '#random', null, { timeout: 10_000 })
  await alice.click('.rail-left .rail-item:has-text("general")')
  await bob.click('.rail-left .rail-item:has-text("random")')
  await bob.waitForFunction(() => document.querySelector('.space-head .eyebrow')?.textContent === '#random', null, { timeout: 10_000 })

  await say(alice, 'anybody about')
  await say(alice, 'hello @Bob again')
  await bob.waitForTimeout(2500)

  const rail = await bob.$$eval('.rail-left .rail-item', (els) =>
    els.map((e) => ({
      name: e.textContent,
      unread: e.classList.contains('unread'),
      badge: e.querySelector('.pill.bad')?.textContent ?? '',
    })),
  )
  const general = rail.find((r) => r.name.includes('general'))
  check('a channel with something new in it says so', general?.unread === true, JSON.stringify(rail))
  check('and a mention in it is counted', general?.badge === '1', JSON.stringify(general))
  const tab = await bob.title()
  check('the tab carries the mention count too', tab.startsWith('(1)'), tab)

  await bob.click('.rail-left .rail-item:has-text("general")')
  await bob.waitForTimeout(1200)
  const line = await bob.$$eval('.chat-new', (els) => els.map((e) => e.textContent))
  check('coming back draws a line where you left off', line.includes('New'), JSON.stringify(line))

  const stillUnread = await bob.$$eval('.rail-left .rail-item.unread', (els) => els.length)
  check('and reading it clears the mark', stillUnread === 0, `${stillUnread}`)

  // The mark is this device's own business and outlives a reload.
  await bob.reload()
  await bob.waitForSelector('.chat-line')
  await bob.waitForTimeout(1500)
  const afterReload = await bob.$$eval('.rail-left .rail-item.unread', (els) => els.length)
  check('the mark survives a reload', afterReload === 0, `${afterReload}`)

  // ---- threads ------------------------------------------------------------
  await say(alice, 'what should we call the release')
  await alice.waitForTimeout(400)
  const last = (await alice.$$eval('.chat-row', (e) => e.length)) - 1
  await pressAction(alice, 'Reply in a thread', last)
  await alice.waitForTimeout(400)
  const title = await alice.$eval('.chat-head .eyebrow', (el) => el.textContent)
  check('a message opens a thread', title === 'Thread in #general', title)

  await say(alice, 'how about Bliss')
  await say(alice, 'or Luna')
  const inThread = await texts(alice)
  check('replies land in the thread', inThread.length === 3, JSON.stringify(inThread))

  await alice.click('button:has-text("Back")')
  await alice.waitForTimeout(500)
  const inChannel = await texts(alice)
  check(
    'and stay out of the channel underneath',
    !inChannel.includes('how about Bliss'),
    JSON.stringify(inChannel.slice(-3)),
  )
  const affordance = await alice.$$eval('.chat-thread', (els) => els.map((e) => e.textContent))
  check('the channel shows the way in, and the count', affordance.includes('2 replies'), JSON.stringify(affordance))

  const bobSees = await bob
    .waitForFunction(
      () => [...document.querySelectorAll('.chat-thread')].some((e) => e.textContent === '2 replies'),
      null,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('everybody else sees the thread too', bobSees)

  // ---- search -------------------------------------------------------------
  await alice.fill('input[aria-label="Search this space"]', 'luna')
  await alice.waitForTimeout(400)
  const hits = await alice.$$eval('.search-hit', (els) => els.map((e) => e.textContent))
  check('search finds a message inside a thread', hits.length === 1 && hits[0].includes('or Luna'), JSON.stringify(hits))

  await alice.click('.search-hit')
  await alice.waitForTimeout(600)
  const landed = await alice.$eval('.chat-head .eyebrow', (el) => el.textContent)
  check('and clicking it takes you to where it was said', landed === 'Thread in #general', landed)

  await alice.click('button:has-text("Back")')
  await alice.fill('input[aria-label="Search this space"]', 'nothing like this exists')
  await alice.waitForTimeout(400)
  const empty = await alice.$eval('.search-results', (el) => el.textContent)
  check('and says so when there is nothing', empty.includes('Nothing matches'), empty)
  await alice.fill('input[aria-label="Search this space"]', '')

  // ---- quick reactions ----------------------------------------------------
  await alice.evaluate(() =>
    localStorage.setItem('cathode.quick.v1', JSON.stringify(['🎉', '🚀'])),
  )
  await pressAction(alice, 'React to this message', 0)
  await alice.waitForSelector('.emoji-pop.quick')
  const quick = await alice.$$eval('.emoji-pop.quick .chat-react', (els) =>
    els.map((e) => e.textContent),
  )
  check('the pinned reactions lead the quick row', quick[0] === '🎉' && quick[1] === '🚀', quick.join(''))
  await alice.keyboard.press('Escape')

  // ---- polish -------------------------------------------------------------
  const grouped = await alice.$$eval('.chat-at.on-hover', (els) => els.length)
  check('a run from one person shows one clock, not five', grouped > 0, `${grouped} hidden`)

  // ---- who runs the place, and what you can do about people ---------------
  const crowns = await alice.$$eval('.rail-person', (els) =>
    els.map((e) => ({ who: e.textContent.trim(), crown: !!e.querySelector('.crown') })),
  )
  check(
    'the admin wears a crown rather than the word',
    crowns.filter((c) => c.crown).length === 1 && crowns.every((c) => !c.who.includes('admin')),
    JSON.stringify(crowns),
  )

  const menuFor = async (page, who) => {
    const more = page.locator('.rail-person', { hasText: who }).locator('.person-more')
    await more.first().evaluate((el) => el.focus())
    await more.first().click()
    await page.waitForSelector('.menu', { timeout: 5000 })
    // The label only. A note sits in a second span with no separator between
    // them, so textContent runs the two together.
    return page.$$eval('.menu-item', (els) =>
      els.map((e) => e.querySelector('span')?.textContent?.trim() ?? ''),
    )
  }

  const onBob = await menuFor(alice, 'Bob')
  check(
    'one ellipsis opens everything an admin can do about somebody',
    onBob.some((t) => t === 'Make an admin') && onBob.some((t) => t.startsWith('Remove')),
    onBob.join(' | '),
  )
  await alice.keyboard.press('Escape')
  check('escape closes it', (await alice.$('.menu')) === null)

  const onAlice = await menuFor(bob, 'Alice')
  check(
    'a member is offered nothing that changes anybody',
    !onAlice.some((t) => t.includes('admin') || t.startsWith('Remove')),
    onAlice.join(' | '),
  )
  await bob.keyboard.press('Escape')

  // Your own row has nothing to offer, so it has no button either.
  const onSelf = await alice.$$eval('.rail-person', (els) => {
    const mine = els.find((e) => e.textContent.includes('(you)'))
    return !!mine?.querySelector('.person-more')
  })
  check('and your own row has no menu at all', onSelf === false)

  // Tagging somebody from the list of who is here.
  await menuFor(alice, 'Bob')
  await alice.click('.menu-item:has-text("Mention Bob")')
  await alice.waitForTimeout(300)
  const composed = await alice.inputValue(BOX)
  check('a person can be tagged from the members list', composed === '@Bob ', JSON.stringify(composed))
  await alice.fill(BOX, '')

  // ---- who is here, and who is only technically here ----------------------
  const dots = (page) =>
    page.$$eval('.rail-person', (els) =>
      els.map((e) => ({
        who: e.textContent.trim(),
        state: [...(e.querySelector('.dot')?.classList ?? [])].filter((c) => c !== 'dot').join(''),
      })),
    )

  const awake = await alice
    .waitForFunction(() => document.querySelectorAll('.rail-person .dot.good').length >= 2, null, {
      timeout: 30_000,
    })
    .then(() => true)
    .catch(() => false)
  check('everybody looking at the space is green', awake, JSON.stringify(await dots(alice)))

  /*
   * Put Bob's tab behind something else. The page cannot be genuinely hidden
   * from a test driver, so the property it reads is replaced and the event it
   * listens for is fired, which is the same thing from the app's side.
   */
  const setHidden = (page, hidden) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { value: h, configurable: true })
      Object.defineProperty(document, 'visibilityState', {
        value: h ? 'hidden' : 'visible',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    }, hidden)

  await setHidden(bob, true)
  const wentAway = await alice
    .waitForFunction(
      () => {
        const row = [...document.querySelectorAll('.rail-person')].find((e) =>
          e.textContent.includes('Bob'),
        )
        return row?.querySelector('.dot.warn') !== null && row?.querySelector('.dot.warn') !== undefined
      },
      null,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('a tab put away turns orange for everybody else', wentAway, JSON.stringify(await dots(alice)))

  // The number along the bottom is the list on the right, counted.
  const agree = await alice.evaluate(() => {
    const rows = [...document.querySelectorAll('.rail-person')]
    const here = rows.filter((r) => !r.classList.contains('away')).length
    const said = Number(
      (document.querySelector('.status-bar')?.textContent ?? '').match(/(\d+) here/)?.[1] ?? -1,
    )
    return { here, said }
  })
  check(
    'the count along the bottom is the list on the right',
    agree.here === agree.said,
    JSON.stringify(agree),
  )

  await setHidden(bob, false)
  const cameBack = await alice
    .waitForFunction(
      () => {
        const row = [...document.querySelectorAll('.rail-person')].find((e) =>
          e.textContent.includes('Bob'),
        )
        return !!row?.querySelector('.dot.good')
      },
      null,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('and green again the moment they come back', cameBack, JSON.stringify(await dots(alice)))
  /*
   * ---- nothing false on the way in ---------------------------------------
   *
   * Between the shell being laid out and the store answering, the app used to
   * draw a room that did not exist: "Unnamed space", no messages, nobody here,
   * for a frame and a half. Every frame of a reload is recorded here, and every
   * one of them has to be either empty or right.
   */
  await alice.context().addInitScript(() => {
    window.__frames = []
    const snap = () => {
      window.__frames.push({
        name: document.querySelector('.space-name')?.textContent ?? '',
        lines: document.querySelectorAll('.chat-line').length,
        chans: document.querySelectorAll('.rail-left .rail-item').length,
      })
      if (window.__frames.length < 200) requestAnimationFrame(snap)
    }
    requestAnimationFrame(snap)
  })
  await alice.reload()
  await alice.waitForSelector('.chat-line')
  await alice.waitForTimeout(1200)
  const frames = await alice.evaluate(() => window.__frames ?? [])
  const drawn = frames.filter((f) => f.chans > 0)
  const lying = drawn.filter((f) => f.name !== 'the office' || f.lines === 0)
  check(
    'no frame of the opening shows a room that is not there',
    drawn.length > 0 && lying.length === 0,
    `${frames.length} frames, ${drawn.length} drawn, ${lying.length} wrong: ${JSON.stringify(lying[0] ?? null)}`,
  )
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
}

await browser.close()

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
