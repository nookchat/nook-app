/** Prints which relays each page actually has open, on both sides. */
import { chromium } from 'playwright-core'
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const STUB = `(() => {
  const c=document.createElement('canvas'); c.width=1280; c.height=720
  const x=c.getContext('2d'); let f=0
  setInterval(()=>{f++;x.fillStyle='#111';x.fillRect(0,0,1280,720);x.fillStyle='#0c8';x.fillRect((f*9)%1180,260,100,100)},33)
  const s=c.captureStream(30)
  navigator.mediaDevices.getDisplayMedia=async()=>new MediaStream(s.getVideoTracks())
})()`
const relayState = () =>
  Array.from(document.querySelectorAll('.pill.relay')).map(
    (p) => `${p.textContent}:${p.classList.contains('good') ? 'open' : p.classList.contains('bad') ? 'FAILED' : 'trying'}`,
  )
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-ui-for-media-stream'] })
const ctx = await browser.newContext()
const host = await ctx.newPage()
await host.addInitScript(STUB)
await host.goto(APP_URL)
await host.getByRole('button', { name: 'Choose what to share' }).click()
await host.locator('.share-code').waitFor({ timeout: 15000 })
const link = await host.locator('.share-code').getAttribute('data-link')
await host.waitForTimeout(8000)
console.log('HOST relays  :', await host.evaluate(relayState))

const viewer = await ctx.newPage()
viewer.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection/.test(m.text())) console.log('[viewer]', m.text()) })
await viewer.goto(link)
await viewer.waitForTimeout(9000)
console.log('VIEWER relays:', await viewer.evaluate(() =>
  Array.from(document.querySelectorAll('.surface-overlay .pill')).map((p) => `${p.textContent}:${p.classList.contains('good') ? 'open' : p.classList.contains('bad') ? 'FAILED' : 'trying'}`)))
console.log('viewer traffic:', await viewer.evaluate(() => ({
  overlay: document.querySelector('.surface-overlay')?.textContent?.slice(0, 60),
  video: document.querySelector('video')?.videoWidth,
})))
console.log('HOST relays  :', await host.evaluate(relayState))
console.log('host viewers :', await host.evaluate(() => document.querySelectorAll('.viewer-row').length))
await browser.close()
