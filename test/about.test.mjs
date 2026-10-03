import { readFileSync } from 'node:fs'
import { APP_URL, check, finish, launch, makeSpace, stoppedEarly } from './harness.mjs'

// Settings, About: the version, a check for a newer one, and the releases on GitHub.
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const browser = await launch()

async function about(desktop) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  if (desktop) {
    await context.addInitScript(() => {
      window.nookDesktop = {
        platform: 'win32',
        version: async () => '9.9.8',
        checkUpdate: async () => ({ state: 'ready', version: '9.9.9' }),
        installUpdate: () => (window.restarted = true),
        onUpdate: () => () => undefined,
      }
    })
  }
  const page = await context.newPage()
  await page.goto(APP_URL)
  await makeSpace(page, 'about')
  await page.waitForSelector('[aria-label="Write a message"]')
  await page.click('button[aria-label="Settings"]')
  await page.click('.settings-tab[data-tab="about"]')
  return page
}

try {
  const web = await about(false)
  const text = await web.locator('.settings-page').innerText()
  check('the page shows its version', text.includes(VERSION), text.slice(0, 80))
  const link = await web.getAttribute('a:has-text("Releases on GitHub")', 'href')
  check('and links to the releases', link === 'https://github.com/nookchat/nook-app/releases', link)
  check('with no desktop card in a browser', !text.includes('Desktop app\n'))
  await web.click('.settings-page button:text-is("Check for updates")')
  const said = await web
    .waitForFunction(() => {
      const t = document.querySelector('.settings-page')?.textContent ?? ''
      return /newest version|cannot update itself|did not get through|is ready/.test(t)
    }, null, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check('a check says how it went', said)

  const desk = await about(true)
  await desk.waitForFunction(() => document.querySelector('.settings-page')?.textContent?.includes('9.9.8'))
  check('the desktop app shows its own version', true)
  await desk.locator('.settings-page button:text-is("Check for updates")').nth(1).click()
  await desk.waitForSelector('button:text-is("Restart to update"):visible')
  check('a downloaded update offers a restart', (await desk.locator('.settings-page').innerText()).includes('9.9.9 has downloaded'))
  await desk.click('button:text-is("Restart to update")')
  check('which restarts into it', await desk.evaluate(() => window.restarted === true))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
