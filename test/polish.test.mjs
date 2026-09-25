import { APP_URL, FAKE_MEDIA, check, finish, launch, stoppedEarly } from './harness.mjs'

const openSearch = (page) =>
  page.evaluate(() => {
    if (!document.querySelector('.search-wrap.open')) document.querySelector('button[aria-label="Search"]')?.click()
  })

const browser = await launch({ args: FAKE_MEDIA })

const BOX = '[aria-label="Write a message"]'

async function say(page, text) {
  await page.click(BOX)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(320)
}

async function pressAction(page, label, index = 0) {
  const button = page.locator('.chat-row').nth(index).locator(`button[aria-label="${label}"]`)
  await button.evaluate((el) => el.focus())
  await button.click()
}

try {
  const bare = await (await browser.newContext()).newPage()
  await bare.goto(APP_URL)
  await bare.waitForSelector('input[aria-label="Space name"]')
  const speed = await bare.evaluate(async () => {
    const { ChatPanel } = await import('/src/ui/chat-panel.ts')
    const panel = new ChatPanel('Me', 'Chat')
    document.body.append(panel.root)
    const make = (n) =>
      Array.from({ length: n }, (_, i) => ({
        id: String(i).padStart(64, '0'),
        author: String(i % 5).padStart(64, 'a'),
        name: `Person ${i % 5}`,
        channel: 'general',
        at: 1700000000000 + i * 1000,
        lamport: i,
        text: `a message about number ${i}`,
        replyTo: null,
        edited: false,
        retracted: false,
        reactions: new Map(),
      }))
    const time = (list) => {
      const at = performance.now()
      panel.render(list)
      return Math.round(performance.now() - at)
    }
    const full = time(make(2000))
    const drawn = document.querySelectorAll('.chat-row').length
    document.querySelectorAll('.chat-row').forEach((el, i) => (el.dataset.mark = String(i)))
    const grown = make(2001)
    const one = time(grown)
    const kept = [...document.querySelectorAll('.chat-row')].filter((el) => el.dataset.mark).length
    document.querySelectorAll('.chat-row').forEach((el) => (el.dataset.again = '1'))
    const near = grown.length - 10
    grown[near].text = 'edited now'
    grown[near].edited = true
    time(grown)
    const rebuilt = [...document.querySelectorAll('.chat-row')].filter((el) => !el.dataset.again)
      .length
    const shown = [...document.querySelectorAll('.chat-row .chat-text')].map((e) => e.textContent)
    panel.root.style.height = '600px'
    panel.log.scrollTop = 0
    panel.log.dispatchEvent(new Event('scroll'))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const more = document.querySelectorAll('.chat-row').length
    panel.root.remove()
    return {
      full,
      one,
      drawn,
      kept,
      rebuilt,
      more,
      inOrder:
        shown[0].includes(`number ${2001 - drawn}`) &&
        shown[shown.length - 10] === 'edited now' &&
        shown[shown.length - 1].includes('2000'),
    }
  })
  check(
    'a long channel draws the newest few screens, not all of it',
    speed.drawn > 50 && speed.drawn < 400,
    `${speed.drawn} of 2000 drawn in ${speed.full} ms`,
  )
  check(
    'a new message leaves the rest of the conversation alone',
    speed.kept === speed.drawn - 1 && speed.one < Math.max(4, speed.full / 2),
    `${speed.kept} kept, ${speed.full} ms to build, ${speed.one} ms to add one`,
  )
  check('an edit rebuilds exactly one row', speed.rebuilt === 1, `${speed.rebuilt}`)
  check('and the order still holds', speed.inOrder)
  check('scrolling to the top draws the older ones', speed.more > speed.drawn, `${speed.drawn} then ${speed.more}`)
  await bare.context().close()

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  page.on('pageerror', (e) => console.log('[error]', e.message))
  await page.goto(APP_URL)
  await page.evaluate(() => localStorage.setItem('nook.name.v1', 'Alice'))
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  await page.fill('input[aria-label="Space name"]', 'polish')
  await page.click('button:has-text("New space")')
  await page.waitForSelector('.space-name')
  await page.waitForTimeout(900)

  await say(page, 'what should we call the release')
  await say(page, 'unrelated chatter with a https://example.com/x.png link in it')

  await say(page, 'and one more')
  const selection = await page.evaluate(async () => {
    const line = document.querySelector('.chat-text')
    const range = document.createRange()
    range.selectNodeContents(line)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    const before = sel.toString()
    document.querySelector('[aria-label="Write a message"]').dispatchEvent(new Event('input'))
    await new Promise((r) => setTimeout(r, 60))
    return { before, after: getSelection().toString() }
  })
  check(
    'selecting a message survives a redraw',
    selection.before.length > 0 && selection.before === selection.after,
    JSON.stringify(selection),
  )

  await pressAction(page, 'Reply in a thread', 0)
  await page.waitForTimeout(400)
  await say(page, 'how about Bliss')
  await say(page, 'or Luna')
  await page.click('button:has-text("Back")')
  await page.waitForTimeout(500)

  const threads = await page.$$eval('.rail-left .rail-threads .rail-item', (items) =>
    items.map((e) => e.textContent.trim()),
  )
  check(
    'a thread is findable from the rail after it scrolls away',
    threads.some((t) => t.includes('what should we call the release') && t.includes('2')),
    JSON.stringify(threads),
  )

  await page.click('.rail-left .rail-item:has-text("what should we call")')
  await page.waitForTimeout(500)
  const opened = await page.$eval('.chat-head .eyebrow', (el) => el.textContent)
  check('and opens from there', opened.startsWith('Thread in'), opened)
  await page.click('button:has-text("Back")')
  await page.waitForTimeout(400)

  const SEARCH = 'input[aria-label="Search this space"]'
  const hits = async (query) => {
    await openSearch(page)
    await page.fill(SEARCH, query)
    await page.waitForTimeout(350)
    return page.$$eval('.search-hit', (els) => els.map((e) => e.textContent))
  }

  check('a plain word still searches', (await hits('luna')).length === 1)
  check('from: narrows to one person', (await hits('from:alice')).length > 0)
  check('and finds nobody when nobody matches', (await hits('from:nobody')).length === 0)
  check('in: narrows to one channel', (await hits('in:general')).length > 0)
  check('and an empty channel has nothing', (await hits('in:nowhere')).length === 0)
  const links = await hits('has:link')
  check('has:link finds the message with a link', links.length === 1, JSON.stringify(links))
  check('has:image finds the picture', (await hits('has:image')).length === 1)
  check('filters combine with words', (await hits('from:alice in:general luna')).length === 1)
  await openSearch(page)
  await page.fill(SEARCH, '')

  const reads = await page.evaluate(async () => {
    const { readOffer } = await import('/src/net/link.ts')
    return {
      link: readOffer('https://nook.video/#link=K7M29QPTVB2W@nook.example.org'),
      typed: readOffer('k7m2-9qpt-vb2w', 'nook.example.org'),
      joined: readOffer('K7M2-9QPT-VB2W@nook.example.org'),
      bare: readOffer('K7M2-9QPT-VB2W'),
      rubbish: readOffer('hello'),
    }
  })
  check(
    'a link, or its code with a server, is read the same way',
    [reads.link, reads.typed, reads.joined].every((r) => r?.code === 'K7M29QPTVB2W' && r.server === 'https://nook.example.org'),
    JSON.stringify(reads.link),
  )
  check('a code with no server, and anything else, is refused', reads.bare === null && reads.rubbish === null)

  const roles = await page.evaluate(() => ({
    log: {
      role: document.querySelector('.chat-log')?.getAttribute('role'),
      live: document.querySelector('.chat-log')?.getAttribute('aria-live'),
      label: document.querySelector('.chat-log')?.getAttribute('aria-label'),
    },
    rails: [...document.querySelectorAll('.rail')].map((r) => r.getAttribute('aria-label')),
    nameless: [...document.querySelectorAll('button')].filter(
      (b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.title,
    ).length,
  }))
  check(
    'the conversation is a log, and says what arrives',
    roles.log.role === 'log' && roles.log.live === 'polite' && !!roles.log.label,
    JSON.stringify(roles.log),
  )
  check('both rails say what they are', roles.rails.every(Boolean), JSON.stringify(roles.rails))
  check('every button has a name', roles.nameless === 0, `${roles.nameless} without one`)

  const reachable = await page.evaluate(async () => {
    const button = document.querySelector('.chat-row button[aria-label="Reply"]')
    button.focus()
    // The fade is a transition, so the value a moment later is the real one.
    await new Promise((r) => setTimeout(r, 200))
    const bar = button.closest('.chat-actions')
    return { focused: document.activeElement === button, shown: getComputedStyle(bar).opacity }
  })
  check(
    'the message actions can be reached with the keyboard',
    reachable.focused && reachable.shown === '1',
    JSON.stringify(reachable),
  )

  const contrast = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    const read = (name) => style.getPropertyValue(name).trim()
    const toRgb = (value) => {
      const el = document.createElement('div')
      el.style.color = value
      document.body.append(el)
      const out = getComputedStyle(el).color.match(/\d+/g).map(Number)
      el.remove()
      return out
    }
    const lum = (value) => {
      const [r, g, b] = toRgb(value).map((c) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a, b) => {
      const la = lum(a)
      const lb = lum(b)
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
    }
    const surfaces = ['--bg', '--face', '--surface', '--surface-2'].map(read)
    const inks = ['--fg', '--fg-dim', '--fg-faint', '--heading', '--accent-text', '--good', '--warn', '--bad']
    const bad = []
    for (const ink of inks) {
      for (const surface of surfaces) {
        const r = ratio(read(ink), surface)
        if (r < 4.5) bad.push(`${ink} on ${surface}: ${r.toFixed(2)}`)
      }
    }
    const onAccent = ratio(read('--accent-fg'), read('--accent'))
    if (onAccent < 4.5) bad.push(`--accent-fg on --accent: ${onAccent.toFixed(2)}`)
    return bad
  })
  check('every colour pair carries 4.5 to 1', contrast.length === 0, contrast.join(' | '))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
