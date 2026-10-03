import { APP_URL, check, finish, HOME, launch, makeSpace, poll, stoppedEarly, wait } from './harness.mjs'

// A menu never goes off screen or under the desktop app's title bar. A pin opens its message
// from anywhere, a note too. And in the channel head, search comes before the actions.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'
const BAR = 32

async function person(name, { bar = false, height = 820 } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height } })
  // The title bar the desktop app draws over the page, as desktop/preload.cjs does it.
  if (bar) {
    await context.addInitScript((px) => {
      document.addEventListener('DOMContentLoaded', () => {
        const el = document.createElement('div')
        el.id = 'nook-titlebar'
        el.style.cssText = `position:fixed;top:0;left:0;right:0;height:${px}px;z-index:2147483647;background:#333`
        document.body.append(el)
        document.documentElement.style.setProperty('--nook-titlebar', `${px}px`)
      })
    }, BAR)
  }
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector(HOME)
  return page
}

const spaceOf = (page, work, arg) =>
  page.evaluate(
    async ({ work, arg }) => {
      const { spaces } = await import('/src/space/registry.ts')
      return new Function('space', 'arg', `return (${work})(space, arg)`)(spaces.all()[0], arg)
    },
    { work: work.toString(), arg },
  )

/** Where the open menu is, and whether all of it is in view and below the bar. */
const menuBox = (page, top) =>
  page.$eval('.menu', (el, top) => {
    const r = el.getBoundingClientRect()
    return {
      inView: r.top >= top && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      scrolls: el.scrollHeight > el.clientHeight,
    }
  }, top)

try {
  const alice = await person('Alice', { bar: true })
  await makeSpace(alice, 'placing')
  await alice.waitForSelector(BOX)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await poll(() => alice.locator('.rail-right .rail-person:has-text("Bob")').count(), 15_000)

  // A right click on somebody at the top of the list, with the pointer just under the bar.
  // A short window: the menu does not fit under the row, so it has to go up, but not under the bar.
  await alice.setViewportSize({ width: 1280, height: 560 })
  const row = alice.locator('.rail-right .rail-person:has-text("Bob")')
  await row.click({ button: 'right', position: { x: 40, y: 4 } })
  await alice.waitForSelector('.menu')
  const top = await menuBox(alice, BAR)
  check('a right click menu near the top stays below the title bar, all of it in view', top.inView, JSON.stringify(top))
  await alice.keyboard.press('Escape')
  await alice.setViewportSize({ width: 1280, height: 820 })

  // Near the bottom right corner it flips up and left, and stays in view.
  await alice.evaluate(async () => {
    const { openMenu } = await import('/src/ui/menu.ts')
    openMenu(document.body, [{ label: 'One', run() {} }, { label: 'Two', run() {} }, { label: 'Three', run() {} }], {
      at: { x: window.innerWidth - 4, y: window.innerHeight - 4 },
    })
  })
  const corner = await menuBox(alice, BAR)
  check('near the bottom right corner it is pushed into view', corner.inView, JSON.stringify(corner))
  await alice.keyboard.press('Escape')

  // A menu taller than the window fits between the bar and the bottom, and scrolls.
  await alice.setViewportSize({ width: 1280, height: 300 })
  await alice.evaluate(async () => {
    const { openMenu } = await import('/src/ui/menu.ts')
    const items = Array.from({ length: 30 }, (_, i) => ({ label: `Item ${i + 1}`, run() {} }))
    openMenu(document.body, items, { at: { x: 200, y: 150 } })
  })
  const tall = await menuBox(alice, BAR)
  check('a menu taller than the window fits in it, and scrolls', tall.inView && tall.scrolls, JSON.stringify(tall))
  await alice.keyboard.press('Escape')
  await alice.setViewportSize({ width: 1280, height: 820 })

  // Search comes before the actions in the channel head.
  const firstPin = await spaceOf(alice, (space) => space.chat.say('the pinned one', 'general'))
  for (let i = 0; i < 40; i++) await spaceOf(alice, (space, n) => space.chat.say(`filler ${n}`, 'general'), i)
  await spaceOf(alice, (space, id) => space.chat.pin(id, true), firstPin.id)
  await alice.waitForSelector('.space-head button[aria-label="Pinned messages"]:not(.hidden)')
  const order = await alice.$$eval('.space-head > *', (els) =>
    els.map((el) => (el.querySelector('input.space-search') ? 'search' : el.getAttribute('aria-label') ?? el.className)),
  )
  const searchAt = order.indexOf('search')
  const pinsAt = order.indexOf('Pinned messages')
  check('search is left of the pinned messages button', searchAt >= 0 && searchAt < pinsAt, order.join(' | '))

  // In a note, Pinned opens the channel at that message.
  await spaceOf(alice, (space) => space.chat.saveNote('abcdef12', 'Plans', '# Plans'))
  const noteRow = alice.locator('.rail-left .rail-item:has-text("Plans")').first()
  await noteRow.waitFor({ timeout: 10_000 })
  await noteRow.click()
  await alice.waitForSelector('.note-view:not(.hidden)', { timeout: 10_000 })
  await alice.click('.space-head button[aria-label="Pinned messages"]')
  await alice.click('.pins-menu .pin-card')
  await wait(500)
  const shown = await poll(
    () =>
      alice.evaluate(() => {
        if (!document.querySelector('.note-view')?.classList.contains('hidden')) return false
        const text = [...document.querySelectorAll('.chat-log .chat-text')].find((n) => n.textContent.includes('the pinned one'))
        if (!text) return false
        const r = text.getBoundingClientRect()
        return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight
      }),
    5000,
  )
  check('from a note, a pin opens the channel at the pinned message', shown)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
