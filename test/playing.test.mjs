import { APP_URL, check, finish, HOME, launch, makeSpace, stoppedEarly } from './harness.mjs'

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
    onUpdate: (fn) => {
      window.__offer = fn
      return () => {}
    },
    installUpdate: () => {
      window.__installed = true
    },
  }
}

const browser = await launch()

async function newSpace(page, name) {
  await page.waitForSelector(HOME)
  await makeSpace(page, name)
  await page.waitForSelector('.space-name')
  await page.waitForTimeout(1200)
}

const doingOf = (page) => page.$$eval('.rail-person .person-doing.game', (els) => els.map((e) => e.textContent.trim()))

async function openCard(page) {
  await page.click('.rail-person.has-menu:has-text("Playing")')
  await page.waitForSelector('.menu-game', { timeout: 5000 })
  return page.$eval('.menu-game', (el) => ({ art: el.querySelector('img')?.src ?? null, words: el.textContent }))
}

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
  await newSpace(host, 'games')
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

  check('a game from outside Steam has no picture', (await openCard(guest)).art === null)
  await guest.keyboard.press('Escape')

  await host.evaluate(() => window.__tell({ name: 'Counter-Strike 2', steam: 730, since: Date.now() }))
  check('a Steam game shows', await seen(guest, 'Playing Counter-Strike 2'))
  const card = await openCard(guest)
  check('its card in their menu has Steam\'s picture', card.art?.endsWith('/apps/730/header.jpg') === true, card.art)
  check('and says what and how long', card.words.includes('Counter-Strike 2') && card.words.includes('for 1 minute'), card.words)
  await guest.keyboard.press('Escape')

  await host.evaluate(() => window.__tell(null))
  check('the game goes when it stops', await seen(guest, ''))

  await host.evaluate(() => window.__tell({ name: 'Balatro', since: Date.now() }))
  check('a new game shows', await seen(guest, 'Playing Balatro'))
  await host.evaluate(() => window.__offer({ version: '9.9.9', ready: true }))
  const offer = await host.waitForSelector('.update-pop', { timeout: 5000 }).then((el) => el.textContent(), () => '')
  check('a new desktop app that has downloaded is offered', offer.includes('Nook 9.9.9 is ready'), offer)
  await host.click('.update-pop button:has-text("Update now")')
  // Restart first notes the call and puts the new web version in charge, then asks.
  const installed = await host.waitForFunction(() => window.__installed === true, null, { timeout: 8000 }).then(() => true, () => false)
  check('and Update now asks the shell to install it', installed)
  await host.evaluate(() => document.querySelector('.update-pop')?.remove())

  const old = await (await browser.newContext()).newPage()
  await old.addInitScript(() => (window.nookDesktop = { platform: 'win32' }))
  await old.goto(APP_URL)
  const oldOffer = await old.waitForSelector('.update-pop', { timeout: 8000 }).then((el) => el.textContent(), () => '')
  check('a desktop app that cannot update itself is offered the download', oldOffer.includes('A new Nook desktop app is out'), oldOffer)
  await old.reload()
  await old.waitForTimeout(1500)
  check('but only once a day', (await old.$('.update-pop')) === null)

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
