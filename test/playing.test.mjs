import { APP_URL, check, finish, launch, stoppedEarly } from './harness.mjs'

// The desktop shell tells the page what game runs. Here a stand-in shell does, in one browser.
const SHELL = () => {
  window.nookDesktop = {
    platform: 'darwin',
    watchGames: (on) => {
      window.__watching = on
    },
    onPlaying: (fn) => {
      window.__tell = fn
      return () => {}
    },
  }
}

const browser = await launch()

async function makeSpace(page, name) {
  await page.waitForSelector('input[aria-label="Space name"]')
  await page.fill('input[aria-label="Space name"]', name)
  await page.click('button:has-text("New space")')
  await page.waitForSelector('.space-name')
  await page.waitForTimeout(1200)
}

const doingOf = (page) => page.$$eval('.rail-person .person-doing.game', (els) => els.map((e) => e.textContent.trim()))

async function seen(page, want, ms = 20_000) {
  return page
    .waitForFunction((w) => [...document.querySelectorAll('.rail-person .person-doing.game')].map((e) => e.textContent.trim()).join('|') === w, want, {
      timeout: ms,
    })
    .then(() => true, () => false)
}

try {
  const hostContext = await browser.newContext()
  await hostContext.addInitScript(SHELL)
  const host = await hostContext.newPage()
  await host.goto(APP_URL)
  await makeSpace(host, 'games')
  check('the page asks the shell to look for games', (await host.evaluate(() => window.__watching)) === true)

  const guest = await (await browser.newContext()).newPage()
  await guest.goto(host.url())
  await guest.waitForSelector('.space-name')
  await guest.waitForTimeout(1500)
  check('a browser has no shell, and shows no game', (await doingOf(guest)).length === 0)

  await host.evaluate(() => window.__tell({ name: 'Hades\u0007 II', since: Date.now() - 5 * 60_000 }))
  check('you see your own game under your name', await seen(host, 'Playing Hades II'))
  check('the others see it too', await seen(guest, 'Playing Hades II'), (await doingOf(guest)).join('|'))
  const title = await guest.$eval('.rail-person .person-doing.game', (el) => el.title)
  check('it says how long, by the time the shell gave', title === 'Playing Hades II for 5 minutes', title)
  check('the voice list has no game while nobody is in voice', (await guest.$$('.voice-game')).length === 0)

  await host.evaluate(() => window.__tell(null))
  check('the game goes when it stops', await seen(guest, ''))

  await host.evaluate(() => window.__tell({ name: 'Balatro', since: Date.now() }))
  check('a new game shows', await seen(guest, 'Playing Balatro'))
  await host.evaluate(async () => (await import('/src/net/playing.ts')).setShowsPlaying(false))
  check('turned off, the shell stops looking', (await host.evaluate(() => window.__watching)) === false)
  check('turned off, the others see no game', await seen(guest, ''))
  await host.evaluate(() => window.__tell({ name: 'Balatro', since: Date.now() }))
  await guest.waitForTimeout(1500)
  check('turned off, a new game stays hidden', (await doingOf(guest)).length === 0)
} catch (err) {
  stoppedEarly(err)
}

await browser.close()
finish()
