/** One screenshot per skin, live, so the differences are visible at a glance. */
import { chromium } from 'playwright-core'
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const OUT = new URL('../test-output/', import.meta.url).pathname
const STUB = `(() => {
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080
  const x = c.getContext('2d'); let f = 0
  setInterval(() => { f++
    x.fillStyle = '#0d1117'; x.fillRect(0,0,1920,1080)
    x.fillStyle = '#e8ecf1'; x.font = '44px monospace'
    x.fillText('function cathode() { return frame ' + f + ' }', 60, 120)
    x.fillStyle = '#00c2a8'; x.fillRect(60, 190, 700, 5) }, 33)
  const s = c.captureStream(30)
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(s.getVideoTracks())
})()`
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-ui-for-media-stream'] })
for (const theme of ['xp', 'winamp', 'discord', 'skype', 'plain']) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const p = await ctx.newPage()
  await p.addInitScript(`localStorage.setItem('cathode.theme.v1', ${JSON.stringify(theme)})`)
  await p.addInitScript(STUB)
  await p.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await p.getByRole('button', { name: 'New space' }).click()
  await p.getByRole('button', { name: 'Share screen' }).click()
  await p.locator('.share-code').waitFor({ timeout: 15000 })
  await p.fill('input[aria-label="Write a message"]', 'anyone about?')
  await p.press('input[aria-label="Write a message"]', 'Enter')
  await p.waitForTimeout(1200)
  await p.mouse.move(400, 400)
  await p.screenshot({ path: `${OUT}theme-${theme}.png` })
  await ctx.close()
}
await browser.close()
console.log('theme shots written')
