import { APP_URL, check, finish, launch, makeSpace, stoppedEarly } from './harness.mjs'

// Somebody not signed in, in a browser, gets the page about Nook. Its buttons go to the same
// steps as the card, its links scroll and leave the address alone, and an invite skips it.
const browser = await launch({ named: false })
const shown = (page, selector) => page.evaluate((s) => !!document.querySelector(s)?.closest('.welcome-step:not(.hidden)'), selector)

try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  await page.goto(APP_URL)
  await page.waitForSelector('.landing')
  check('somebody not signed in gets the page about Nook', await shown(page, '.lp-hero'))
  await page.waitForTimeout(3200)
  // The typing ghost in the small Nook, and no other: the closing ghost is out of sight and still.
  const moving = await page.evaluate(() =>
    [...document.querySelectorAll('.landing .nook-ghost')].filter((g) => {
      const s = getComputedStyle(g)
      return s.animationName !== 'none' && s.animationPlayState === 'running'
    }).length,
  )
  check('one ghost moves on the screen', moving === 1, String(moving))

  const before = page.url()
  await page.click('.lp-nav-link:has-text("Privacy")')
  await page.waitForTimeout(900)
  const scrolled = await page.evaluate(() => ({
    top: Math.round(document.getElementById('lp-privacy').getBoundingClientRect().top),
    scroll: document.querySelector('.welcome').scrollTop,
  }))
  check('a link in its bar scrolls to its part, under the bar', scrolled.scroll > 0 && scrolled.top >= 0 && scrolled.top < 120, JSON.stringify(scrolled))
  check('and leaves the address as it was: after the # is an invite', page.url() === before, page.url())

  await page.click('.lp-hero button:has-text("Get started")')
  await page.waitForSelector('.tour:not(.hidden)')
  check('Get started starts the tour', !(await page.$('.welcome.on-landing')))
  await page.click('.tour-back')
  check('and Back on its first slide comes back to the page', await shown(page, '.lp-hero'))

  await page.click('.lp-hero button:has-text("I have an account")')
  check('I have an account asks how to get in', await shown(page, '.welcome-option'))
  await page.click('.welcome-step:not(.hidden) .welcome-link')
  check('and its Back comes back to the page too', await shown(page, '.lp-hero'))

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await phone.goto(APP_URL)
  await phone.waitForSelector('.landing')
  const fits = await phone.evaluate(() => {
    const box = document.querySelector('.welcome')
    return { scroll: box.scrollWidth, width: box.clientWidth }
  })
  check('on a phone nothing goes past the side of the screen', fits.scroll <= fits.width, JSON.stringify(fits))

  // An invite goes to the card that says so, with no page about Nook in front of it.
  const host = await (await launch()).newPage()
  await host.goto(APP_URL)
  await makeSpace(host, 'Party')
  await host.waitForSelector('[aria-label="Write a message"]')
  await host.waitForTimeout(1500)
  await host.click('.space-title-button')
  await host.click('.menu-item:has-text("Invite")')
  const link = await host.locator('.share-code').getAttribute('data-link')
  const guest = await (await browser.newContext()).newPage()
  await guest.goto(link)
  await guest.waitForSelector('.welcome-title')
  check('an invite skips the page and says it is an invite', !(await guest.$('.landing')) && (await guest.textContent('.welcome-step:not(.hidden) .welcome-title')) === 'You have been invited')
  await host.context().browser().close()
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
