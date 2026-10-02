import { mkdirSync } from 'node:fs'
import { APP_URL, check, finish, launch, stoppedEarly, wait } from './harness.mjs'

// The tour somebody new takes after I'm new: four slides, Next, Back, the dots, the arrow keys and
// a swipe go through it, Skip and the last slide go to the name, and an invite says so.

const OUT = new URL('../test-output/onboarding/', import.meta.url)
mkdirSync(OUT, { recursive: true })

const browser = await launch({ named: false })

const slide = (page) =>
  page.evaluate(() => {
    const on = document.querySelector('.tour-slide.on')
    return { at: [...document.querySelectorAll('.tour-slide')].indexOf(on), title: on?.querySelector('.tour-title')?.textContent ?? '' }
  })
const shown = (page, selector) => page.evaluate((s) => !!document.querySelector(s)?.closest('.welcome-step:not(.hidden)'), selector)

try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  await page.goto(APP_URL)
  await page.click('.welcome-step:not(.hidden) button.primary')
  await page.waitForSelector('.tour:not(.hidden)')
  const first = await slide(page)
  const count = await page.locator('.tour-slide').count()
  const focused = await page.evaluate(() => document.activeElement?.classList.contains('tour-next') ?? false)
  check('I’m new opens the tour on its first slide, with Next in focus', count === 4 && first.at === 0 && focused, JSON.stringify({ count, first, focused }))
  await page.screenshot({ path: new URL('desktop-1.png', OUT).pathname })

  await page.click('.tour-next')
  check('Next goes to the next slide', (await slide(page)).at === 1)
  await page.keyboard.press('ArrowRight')
  check('and so does the right arrow', (await slide(page)).at === 2)
  await page.keyboard.press('ArrowLeft')
  check('the left arrow goes back', (await slide(page)).at === 1)
  await page.click('.tour-dot >> nth=3')
  const last = await page.evaluate(() => ({
    next: document.querySelector('.tour-next')?.textContent ?? '',
    skip: getComputedStyle(document.querySelector('.tour-skip')).visibility,
    current: document.querySelector('.tour-dot[aria-current="step"]') === document.querySelectorAll('.tour-dot')[3],
  }))
  check('a dot goes to its slide; the last one has no Skip, and says Let’s go', last.next === 'Let’s go' && last.skip === 'hidden' && last.current, JSON.stringify(last))

  await page.click('.tour-next')
  check('Let’s go asks for the name', await shown(page, 'input[aria-label="Your name"]'))
  await page.click('.welcome-step:not(.hidden) .welcome-link')
  check('and the name’s Back goes back to the last slide', (await slide(page)).at === 3 && (await shown(page, '.tour-slide')))
  await page.click('.tour-dot >> nth=0')
  await page.click('.tour-back')
  check('Back on the first slide goes back to the start', await shown(page, '.welcome-brand'))
  await page.click('.welcome-step:not(.hidden) button.primary')
  await page.click('.tour-skip')
  check('Skip goes straight to the name', await shown(page, 'input[aria-label="Your name"]'))

  const phone = await (
    await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })
  ).newPage()
  await phone.goto(APP_URL)
  await phone.click('.welcome-step:not(.hidden) button.primary')
  await phone.waitForSelector('.tour:not(.hidden)')
  const fits = await phone.evaluate(() => {
    const card = document.querySelector('.welcome-card').getBoundingClientRect()
    return card.left >= 0 && card.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth
  })
  check('on a phone the card fits the width', fits)
  const box = await phone.locator('.tour-slides').boundingBox()
  const swipe = async (from, to) => {
    const y = box.y + box.height / 3
    await phone.dispatchEvent('.tour-slides', 'pointerdown', { pointerType: 'touch', pointerId: 7, clientX: from, clientY: y })
    await phone.dispatchEvent('.tour-slides', 'pointerup', { pointerType: 'touch', pointerId: 7, clientX: to, clientY: y })
  }
  await swipe(box.x + box.width - 20, box.x + 20)
  check('a swipe to the left goes to the next slide', (await slide(phone)).at === 1)
  await swipe(box.x + 20, box.x + box.width - 20)
  check('and a swipe to the right goes back', (await slide(phone)).at === 0)
  for (let i = 1; i <= 4; i++) {
    await wait(300)
    await phone.screenshot({ path: new URL(`phone-${i}.png`, OUT).pathname })
    if (i < 4) await phone.click('.tour-next')
  }

  // Somebody with an invite takes the tour too, and its last slide says they join.
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  await host.goto(APP_URL)
  await host.click('.welcome-step:not(.hidden) button.primary')
  await host.click('.tour-skip')
  await host.fill('input[aria-label="Your name"]', 'Hana')
  await host.keyboard.press('Enter')
  await host.fill('input[aria-label="Space name"]', 'toured')
  await host.click('button:has-text("New space")')
  await host.waitForSelector('.space-name', { timeout: 15_000 })
  const link = await host.evaluate(() => window.location.href)
  const guest = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  await guest.goto(link)
  await guest.click('.welcome-step:not(.hidden) button.primary')
  await guest.click('.tour-dot >> nth=3')
  const invited = await guest.evaluate(() => ({
    next: document.querySelector('.tour-next')?.textContent ?? '',
    steps: [...document.querySelectorAll('.tour-slide.on .tour-step b')].map((b) => b.textContent),
  }))
  check('with an invite, the last slide says they join, and Next is Pick my name', invited.next === 'Pick my name' && invited.steps.includes('Join their space'), JSON.stringify(invited))
  await guest.click('.tour-next')
  await guest.fill('input[aria-label="Your name"]', 'Gus')
  await guest.click('.welcome-step:not(.hidden) .welcome-go')
  await guest.waitForSelector('.space-name', { timeout: 15_000 })
  check('and then the name drops them in the space', true)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
