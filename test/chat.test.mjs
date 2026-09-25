import { APP_URL, FAKE_MEDIA, check, finish, launch, stoppedEarly } from './harness.mjs'

const openSearch = (page) =>
  page.evaluate(() => {
    if (!document.querySelector('.search-wrap.open')) document.querySelector('button[aria-label="Search"]')?.click()
  })

const browser = await launch({ args: FAKE_MEDIA })

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

// The action bar is faded until hovered, so reach it the way a keyboard does.
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

  await alice.fill(BOX, '')
  await alice.click(BOX)
  await alice.keyboard.type('/dm Bo')
  await alice.waitForSelector('.mention-pop', { timeout: 5000 })
  const named = await alice.$$eval('.mention-option', (els) => els.map((e) => e.textContent))
  check('a command that wants a person offers the people', named.includes('Bob'), named.join())

  await alice.keyboard.press('Tab')
  const filled = await alice.inputValue(BOX)
  check('and picking one writes the whole name', filled === '/dm Bob ', JSON.stringify(filled))

  await alice.fill(BOX, '')
  await alice.click(BOX)
  await alice.keyboard.type('/msg Bo')
  await alice.waitForSelector('.mention-pop', { timeout: 5000 })
  const aliased = await alice.$$eval('.mention-option', (els) => els.map((e) => e.textContent))
  check('the other spelling of a command offers them too', aliased.includes('Bob'), aliased.join())
  await alice.keyboard.press('Escape')

  await alice.fill(BOX, '/me Bo')
  await alice.waitForTimeout(300)
  const quiet = await alice.$$eval('.mention-option', (els) => els.length)
  check('a command that wants no name offers nothing', quiet === 0, `${quiet}`)
  await alice.fill(BOX, '')

  const plusHidden = await bob.$eval('button[title="Make a text channel"]', (el) =>
    el.classList.contains('hidden'),
  )
  check('a member is not offered the channel button', plusHidden)

  alice.once('dialog', (d) => d.accept('random'))
  await alice.click('.rail-left button[title="Make a text channel"]')
  await alice.waitForFunction(() => document.querySelector('.space-head .channel-name')?.textContent === 'random', null, { timeout: 10_000 })
  await alice.click('.rail-left .rail-item:has-text("general")')
  await bob.click('.rail-left .rail-item:has-text("random")')
  await bob.waitForFunction(() => document.querySelector('.space-head .channel-name')?.textContent === 'random', null, { timeout: 10_000 })

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
  check('the tab says the app first, then the mention count', tab.startsWith('Nook | (1)'), tab)

  await bob.click('.rail-left .rail-item:has-text("general")')
  await bob.waitForTimeout(1200)
  const line = await bob.$$eval('.chat-new', (els) => els.map((e) => e.textContent))
  check('coming back draws a line where you left off', line.includes('New'), JSON.stringify(line))

  const stillUnread = await bob.$$eval('.rail-left .rail-item.unread', (els) => els.length)
  check('and reading it clears the mark', stillUnread === 0, `${stillUnread}`)

  await bob.reload()
  await bob.waitForSelector('.chat-line')
  await bob.waitForTimeout(1500)
  const afterReload = await bob.$$eval('.rail-left .rail-item.unread', (els) => els.length)
  check('the mark survives a reload', afterReload === 0, `${afterReload}`)

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

  await openSearch(alice)
  await alice.fill('input[aria-label="Search this space"]', 'luna')
  await alice.waitForTimeout(400)
  const hits = await alice.$$eval('.search-hit', (els) => els.map((e) => e.textContent))
  check('search finds a message inside a thread', hits.length === 1 && hits[0].includes('or Luna'), JSON.stringify(hits))

  await alice.click('.search-hit')
  await alice.waitForTimeout(600)
  const landed = await alice.$eval('.chat-head .eyebrow', (el) => el.textContent)
  check('and clicking it takes you to where it was said', landed === 'Thread in #general', landed)
  await alice.waitForTimeout(2500)
  const lit = await alice.evaluate(() => {
    const line = document.querySelector('.chat-line.found')
    return line ? getComputedStyle(line).backgroundColor : null
  })
  check('and it is still lit two and a half seconds later', !!lit && lit !== 'rgba(0, 0, 0, 0)', lit ?? 'not lit')

  await alice.click('button:has-text("Back")')
  await openSearch(alice)
  await alice.fill('input[aria-label="Search this space"]', 'nothing like this exists')
  await alice.waitForTimeout(400)
  const empty = await alice.$eval('.search-results', (el) => el.textContent)
  check('and says so when there is nothing', empty.includes('Nothing matches'), empty)

  await openSearch(alice)
  await alice.fill('input[aria-label="Search this space"]', '')
  await openSearch(alice)
  await alice.click('input[aria-label="Search this space"]')
  await alice.keyboard.type('from:Bo')
  await alice.waitForSelector('.mention-pop', { timeout: 5000 })
  const searchNames = await alice.$$eval('.mention-option', (els) => els.map((e) => e.textContent))
  check('the from: filter offers the people', searchNames.includes('Bob'), searchNames.join())

  await alice.keyboard.press('Tab')
  const filter = await alice.inputValue('input[aria-label="Search this space"]')
  check('and picking one writes the filter', filter === 'from:Bob ', JSON.stringify(filter))
  await openSearch(alice)
  await alice.fill('input[aria-label="Search this space"]', '')

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

  await alice.click('button[aria-label="Switch space"]')
  const opened = await alice.waitForSelector('.menu.switcher', { timeout: 5000 }).then(() => true, () => false)
  await alice.click('button[aria-label="Switch space"]')
  await alice.waitForTimeout(400)
  const shut = (await alice.$('.menu.switcher')) === null
  check('the menu at the top left opens on a press, and closes on the next', opened && shut, `${opened} ${shut}`)

  const grouped = await alice.$$eval('.chat-at.on-hover', (els) => els.length)
  check('a run from one person shows one clock, not five', grouped > 0, `${grouped} hidden`)

  for (let i = 0; i < 30; i++) await say(alice, `filler ${i}`)
  await alice.evaluate(() => {
    const log = document.querySelector('.chat-log')
    log.scrollTop = log.scrollHeight - log.clientHeight - 320
    log.dispatchEvent(new Event('scroll'))
    window.__under = []
    log.addEventListener('click', (ev) => window.__under.push(ev.target.className), true)
  })
  await alice.waitForSelector('.to-bottom:not(.hidden)', { timeout: 5000 })
  const r = await alice.$eval('.to-bottom', (el) => {
    const b = el.getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })
  await alice.mouse.move(r.x, r.y)
  await alice.mouse.down()
  const onPress = await alice.evaluate(() => {
    const log = document.querySelector('.chat-log')
    return log.scrollHeight - log.scrollTop - log.clientHeight < 5
  })
  await alice.mouse.up()
  await alice.waitForTimeout(200)
  const under = await alice.evaluate(() => window.__under)
  check('the way back down goes down on the press, and nothing under it is clicked', onPress && under.length === 0, JSON.stringify({ onPress, under }))

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
    // A note sits beside the label with no separator, so textContent runs the two together.
    return page.$$eval('.menu-item', (els) =>
      els.map((e) => e.querySelector('.menu-label')?.textContent?.trim() ?? ''),
    )
  }

  const onBob = await menuFor(alice, 'Bob')
  check(
    'one ellipsis opens everything the owner can do about somebody, their level included',
    onBob.some((t) => t === 'Admin') && onBob.some((t) => t === 'Member') && onBob.some((t) => t.startsWith('Remove')),
    onBob.join(' | '),
  )
  await alice.keyboard.press('Escape')
  check('escape closes it', (await alice.$('.menu')) === null)

  const onAlice = await menuFor(bob, 'Alice')
  check(
    'a member is offered nothing that changes anybody',
    !onAlice.some((t) => t === 'Admin' || t === 'Member' || t.startsWith('Remove')),
    onAlice.join(' | '),
  )
  await bob.keyboard.press('Escape')

  const onSelf = await alice.$$eval('.rail-person', (els) => {
    const mine = els.find((e) => e.textContent.includes('(you)'))
    return !!mine?.querySelector('.person-more')
  })
  check('and your own row has no menu at all', onSelf === false)

  await menuFor(alice, 'Bob')
  await alice.click('.menu-item:has(.menu-label:text-is("Mention"))')
  await alice.waitForTimeout(300)
  const composed = await alice.inputValue(BOX)
  check('a person can be tagged from the members list', composed === '@Bob ', JSON.stringify(composed))
  await alice.fill(BOX, '')

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

  // A test driver cannot hide a page, so replace what the app reads and fire the event it listens for.
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
        return !!row?.querySelector('.dot.warn')
      },
      null,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('a tab put away turns orange for everybody else', wentAway, JSON.stringify(await dots(alice)))

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
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
