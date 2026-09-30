import { readFileSync } from 'node:fs'
import { APP_URL, check, finish, launch, openSpaceSettings, stoppedEarly } from './harness.mjs'

// In the desktop app, the channel's name, search and the people button sit up in the title bar,
// so the messages get that height. The bar is the desktop shell's own; here it is made the same
// way, with the same CSS, from desktop/preload.cjs.
const preload = readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8')
const CSS = /const CSS = `([\s\S]*?)`/.exec(preload)[1].replace(/\$\{BAR_HEIGHT\}/g, '32')

const SHELL = (css) => {
  window.nookDesktop = { platform: 'darwin', onUpdate: () => () => {}, installUpdate: () => {} }
  const mount = () => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    document.documentElement.classList.add('nook-mac')
    const bar = document.createElement('div')
    bar.id = 'nook-titlebar'
    const brand = document.createElement('div')
    brand.className = 'brand'
    const title = document.createElement('div')
    title.className = 'title'
    title.innerHTML = '<span class="title-face" id="nook-title-face"></span><span class="title-words">Nook</span>'
    bar.append(brand, title)
    document.body.prepend(bar)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
}

const browser = await launch()
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addInitScript(SHELL, CSS)
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.fill('input[aria-label="Space name"]', 'Bar')
  await page.click('button:has-text("New space")')
  await page.waitForSelector('[aria-label="Write a message"]')

  const up = await page.evaluate(() => ({
    inBar: !!document.querySelector('#nook-titlebar .space-head .channel-name'),
    search: !!document.querySelector('#nook-titlebar .space-head .search-wrap'),
    people: !!document.querySelector('#nook-titlebar .space-head .people-button'),
    below: document.querySelectorAll('.space-main > .space-head').length,
    barHeight: document.getElementById('nook-titlebar').getBoundingClientRect().height,
  }))
  check('the channel name, search and the people button are in the title bar', up.inBar && up.search && up.people && up.below === 0, JSON.stringify(up))
  check('and the bar stays its own height', up.barHeight === 32, String(up.barHeight))
  await page.screenshot({ path: 'test-output/titlebar.png' })

  await page.click('#nook-titlebar .people-button')
  check('its buttons work from up there', await page.evaluate(() => document.querySelector('#nook-titlebar .people-button')?.getAttribute('aria-pressed') === 'false'))
  await page.click('#nook-titlebar .people-button')

  await openSpaceSettings(page)
  await page.waitForSelector('.settings')
  check('with settings open, they are not in the title bar', (await page.locator('#nook-titlebar .space-head').count()) === 0)
  await page.click('.settings-close')
  await page.waitForSelector('[aria-label="Write a message"]')
  check('and they come back when settings close', (await page.locator('#nook-titlebar .space-head').count()) === 1)

  await page.click('button[aria-label="Switch space"]')
  await page.click('.menu.switcher .menu-item:has-text("Home")')
  await page.waitForSelector('input[aria-label="Room code"]')
  check('home has no channel in the title bar', (await page.locator('#nook-titlebar .space-head').count()) === 0)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
