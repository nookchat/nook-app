import { setTimeout as wait } from 'node:timers/promises'
import { chromium } from 'playwright-core'

export const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/'
export const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const HEADLESS = process.env.HEADED !== '1'

export const FAKE_MEDIA = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
export const AUTOPLAY = '--autoplay-policy=no-user-gesture-required'

export { wait }

export async function poll(work, ms, every = 250) {
  const end = Date.now() + ms
  let last = null
  while (Date.now() < end) {
    last = await work()
    if (last) return last
    await wait(every)
  }
  return last
}

const results = []

export function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

export function stoppedEarly(err) {
  console.error('\nThe run stopped early:', err?.stack ?? err)
  process.exitCode = 1
}

export function finish() {
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed || process.exitCode ? 1 : 0)
}

export async function launch({ args = [], named = true, ...options } = {}) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: HEADLESS, args, ...options })
  return named ? nameEveryone(browser) : browser
}

export function nameEveryone(browser) {
  const newContext = browser.newContext.bind(browser)
  browser.newContext = async (...args) => {
    const context = await newContext(...args)
    await context.addInitScript((name) => {
      if (!localStorage.getItem('nook.name.v1')) localStorage.setItem('nook.name.v1', name)
    }, `Tester ${Math.random().toString(36).slice(2, 6)}`)
    return context
  }
  browser.newPage = async (...args) => (await browser.newContext(...args)).newPage()
  return browser
}

export async function hostAndShare(host) {
  await host.getByRole('button', { name: 'New space' }).click()
  await host.click('.voice-channel .rail-item:has-text("lounge")', { timeout: 15_000 })
  await host.waitForSelector('.voice-bar:not(.hidden)', { timeout: 15_000 })
  await host.click('button[aria-label="Share screen"]')
  await host.click('.space-title-button')
  await host.click('.menu-item:has-text("Invite")')
  const box = host.locator('.share-code')
  await box.waitFor({ timeout: 15_000 })
  const link = await box.getAttribute('data-link')
  await host.keyboard.press('Escape')
  return link
}

export async function joinAndWatch(viewer, link, timeoutMs = 30_000) {
  await viewer.goto(link, { waitUntil: 'domcontentloaded' })
  await viewer.waitForSelector('.stream-tab[data-watch="peer"]', { timeout: timeoutMs })
  await viewer.click('.stream-tab[data-watch="peer"]')
}
