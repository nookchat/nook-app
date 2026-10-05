import { APP_URL, HOME, check, finish, launch, openSettingsTab, stoppedEarly } from './harness.mjs'

// After an update, What's new shows what came with it, once. Somebody who signs up now sees none
// of it, and somebody from before there was a changelog sees the newest. Settings, About has all.
const browser = await launch({ named: false })
const SEEN = 'nook.changelog-seen.v1'

/** A device that has used Nook, and last showed the changelog at `seen` (or never, with null). */
async function returning(seen) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await context.addInitScript(
    ([key, at]) => {
      if (sessionStorage.getItem('set')) return
      sessionStorage.setItem('set', '1')
      localStorage.setItem('nook.name.v1', 'Returning')
      if (at === null) localStorage.removeItem(key)
      else localStorage.setItem(key, at)
    },
    [SEEN, seen],
  )
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.waitForSelector(HOME)
  return page
}

const entries = (page) => page.$$eval('.whats-new-entry', (els) => els.length)

try {
  const later = await returning('2026-09-30')
  await later.waitForSelector('.whats-new', { timeout: 8000 })
  const shown = { entries: await entries(later), more: (await later.textContent('.whats-new-foot')).includes('Settings, About') }
  check('after an update, What’s new shows what came since the last one it showed', shown.entries === 3 && shown.more, JSON.stringify(shown))
  const newest = await later.evaluate((key) => localStorage.getItem(key), SEEN)
  await later.click('.whats-new button:has-text("Got it")')
  check('Got it puts it away', !(await later.$('.whats-new')))
  await later.reload()
  await later.waitForSelector(HOME)
  await later.waitForTimeout(3000)
  check('and it does not come again for the same update', !(await later.$('.whats-new')), newest)

  await openSettingsTab(later, 'about')
  await later.click('button:has-text("See what’s new")')
  await later.waitForSelector('.whats-new')
  const all = await entries(later)
  check('Settings, About shows every update', all >= 5, String(all))
  await later.keyboard.press('Escape')
  check('and Escape closes it', !(await later.$('.whats-new')))

  const before = await returning(null)
  await before.waitForSelector('.whats-new', { timeout: 8000 })
  check('somebody from before there was a changelog sees the newest update only', (await entries(before)) === 1)

  // Somebody new signs up: everything is new, so nothing shows.
  const fresh = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  await fresh.goto(APP_URL)
  await fresh.click('.welcome-step:not(.hidden) button.primary')
  await fresh.click('.tour-skip')
  await fresh.fill('input[aria-label="Your name"]', 'Newcomer')
  await fresh.click('.welcome-step:not(.hidden) .welcome-go')
  await fresh.waitForSelector(HOME)
  await fresh.waitForTimeout(3500)
  check('somebody who signs up now sees no What’s new', !(await fresh.$('.whats-new')))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
