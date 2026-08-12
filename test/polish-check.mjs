/**
 * The thread list, the search filters, device linking, and two properties that
 * are easy to lose: that a redraw leaves alone what has not changed, and that
 * the room can be used without a pointer or a screen.
 *
 *   node test/polish-check.mjs
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
  // ---- redrawing without rebuilding ---------------------------------------
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
    document.querySelectorAll('.chat-row').forEach((el, i) => (el.dataset.mark = String(i)))
    const grown = make(2001)
    const one = time(grown)
    const kept = [...document.querySelectorAll('.chat-row')].filter((el) => el.dataset.mark).length
    document.querySelectorAll('.chat-row').forEach((el) => (el.dataset.again = '1'))
    grown[500].text = 'edited now'
    grown[500].edited = true
    time(grown)
    const rebuilt = [...document.querySelectorAll('.chat-row')].filter((el) => !el.dataset.again)
      .length
    const shown = [...document.querySelectorAll('.chat-row .chat-text')].map((e) => e.textContent)
    panel.root.remove()
    return {
      full,
      one,
      kept,
      rebuilt,
      inOrder:
        shown[0].includes('number 0') && shown[500] === 'edited now' && shown[2000].includes('2000'),
    }
  })
  check(
    'a new message leaves the rest of the conversation alone',
    speed.kept === 2000 && speed.one < speed.full / 4,
    `${speed.kept} kept, ${speed.full} ms to build, ${speed.one} ms to add one`,
  )
  check('an edit rebuilds exactly one row', speed.rebuilt === 1, `${speed.rebuilt}`)
  check('and the order still holds', speed.inOrder)
  await bare.context().close()

  // ---- the room -----------------------------------------------------------
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  page.on('pageerror', (e) => console.log('[error]', e.message))
  await page.goto(APP_URL)
  await page.evaluate(() => localStorage.setItem('cathode.name.v1', 'Alice'))
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  await page.fill('input[aria-label="Space name"]', 'polish')
  await page.click('button:has-text("New space")')
  await page.waitForSelector('.space-name')
  await page.waitForTimeout(900)

  await say(page, 'what should we call the release')
  await say(page, 'unrelated chatter with a https://example.com/x.png link in it')

  // Selection survives whatever else is going on.
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

  // ---- the thread list ----------------------------------------------------
  await pressAction(page, 'Reply in a thread', 0)
  await page.waitForTimeout(400)
  await say(page, 'how about Bliss')
  await say(page, 'or Luna')
  await page.click('button:has-text("Back")')
  await page.waitForTimeout(500)

  const threads = await page.$$eval('.rail-left .rail-list', (lists) => {
    const list = lists[2]
    return [...list.querySelectorAll('.rail-item')].map((e) => e.textContent.trim())
  })
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

  // ---- search filters -----------------------------------------------------
  const SEARCH = 'input[aria-label="Search this space"]'
  const hits = async (query) => {
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
  await page.fill(SEARCH, '')

  // ---- linking another device --------------------------------------------
  /*
   * The key itself, rather than the module's memory of it.
   *
   * A dynamic import with an extension is a second copy of the module in the
   * dev server, so asking that copy who it thinks you are proves nothing. What
   * a linking code has to do is change the key on this device, which is one
   * value in one place.
   */
  const linking = await page.evaluate(async () => {
    const { readPayload } = await import('/src/ui/link-device.ts')
    const KEY = 'cathode.identity.v1'
    const before = localStorage.getItem(KEY)
    const body = { k: 'b'.repeat(64), n: 'Carried Over', a: '' }
    const code = 'cathode1:' + btoa(unescape(encodeURIComponent(JSON.stringify(body))))
    const taken = readPayload(code)
    const after = localStorage.getItem(KEY)
    const rubbish = readPayload('hello')
    const stillThere = localStorage.getItem(KEY)
    localStorage.setItem(KEY, before)
    return { before, after, taken, rubbish, stillThere }
  })
  check('a linking code carries the name across', linking.taken?.name === 'Carried Over')
  check(
    'and puts the key it carries on this device',
    linking.after === 'b'.repeat(64) && linking.after !== linking.before,
    `${String(linking.after).slice(0, 8)}...`,
  )
  check('anything else is refused', linking.rubbish === null)
  check('and refusing it leaves the key alone', linking.stillThere === linking.after)

  // ---- reachable without a pointer, and out loud ---------------------------
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

  // Tab reaches the message actions, which is the only way to them without a
  // pointer: they are faded until something in the row has focus.
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

  // Every colour the palette draws text in, against every surface it draws on.
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
    // And the white that sits on the accent, which is every primary button.
    const onAccent = ratio(read('--accent-fg'), read('--accent'))
    if (onAccent < 4.5) bad.push(`--accent-fg on --accent: ${onAccent.toFixed(2)}`)
    return bad
  })
  check('every colour pair carries 4.5 to 1', contrast.length === 0, contrast.join(' | '))
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
}

await browser.close()

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
