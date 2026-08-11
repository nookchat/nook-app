/** Captures the landing page and the host panel for a visual check. */
import { chromium } from 'playwright-core'
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const OUT = new URL('../test-output/', import.meta.url).pathname
const STUB = `(() => {
  const c = document.createElement('canvas'); c.width=1920; c.height=1080
  const x = c.getContext('2d'); let f=0
  setInterval(() => { f++; x.fillStyle='#0d1117'; x.fillRect(0,0,1920,1080)
    x.fillStyle='#e8ecf1'; x.font='40px monospace'; x.fillText('function cathode() { return frame '+f+' }', 60, 120)
    x.fillStyle='#00c2a8'; x.fillRect(60, 200, 700, 4) }, 33)
  const s = c.captureStream(30)
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(s.getVideoTracks())
})()`
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-ui-for-media-stream'] })
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme })
  const p = await ctx.newPage()
  await p.addInitScript(STUB)
  await p.goto(APP_URL)
  await p.waitForTimeout(700)
  await p.screenshot({ path: `${OUT}idle-${scheme}.png`, fullPage: true })
  await p.getByRole('button', { name: 'Choose what to share' }).click()
  await p.locator('input[aria-label="The link to share"]').waitFor({ timeout: 15000 })
  await p.locator('summary', { hasText: 'Fine tuning' }).click()
  await p.waitForTimeout(1200)
  await p.mouse.move(500, 400)
  await p.screenshot({ path: `${OUT}host-tuning-${scheme}.png`, fullPage: true })
  await p.getByRole('button', { name: 'Show a QR code' }).click()
  await p.waitForTimeout(500)
  await p.screenshot({ path: `${OUT}qr-${scheme}.png` })
  await p.keyboard.press('Escape')
  await ctx.close()
}
await browser.close()
console.log('shots written')
