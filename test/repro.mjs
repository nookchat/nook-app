/**
 * Reproduction runs for "the viewer is stuck looking for the host".
 *
 *   node test/repro.mjs skew     viewer clock is five minutes ahead
 *   node test/repro.mjs delay    viewer joins 100 seconds later, host tab hidden
 *   node test/repro.mjs reload   host tab is reloaded, then a viewer arrives
 */

import { chromium } from 'playwright-core'

const CASE = process.argv[2] ?? 'skew'
const APP_URL = process.argv[3] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const DISPLAY_STUB = `(() => {
  const c = document.createElement('canvas')
  c.width = 1280; c.height = 720
  const ctx = c.getContext('2d')
  let f = 0
  setInterval(() => { f++; ctx.fillStyle = '#0d1117'; ctx.fillRect(0,0,1280,720)
    ctx.fillStyle = '#00c2a8'; ctx.fillRect((f*9)%1180, 260, 100, 100) }, 33)
  const s = c.captureStream(30)
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(s.getVideoTracks())
})()`

const SKEW_STUB = `(() => {
  const offset = 5 * 60 * 1000
  const RealDate = Date
  const now = Date.now
  Date.now = () => now() + offset
  window.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [now() + offset])) }
    static now() { return now() + offset }
  }
})()`

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })

const host = await ctx.newPage()
await host.addInitScript(DISPLAY_STUB)
await host.goto(APP_URL)
await host.getByRole('button', { name: 'Choose what to share' }).click()
const box = host.locator('.share-code')
await box.waitFor({ timeout: 15_000 })
const link = await box.getAttribute('data-link')
console.log(`case=${CASE}  host live`)

if (CASE === 'reload') {
  await host.waitForTimeout(3000)
  await host.reload()
  console.log('host reloaded, so the stream should be gone')
}

const viewer = await ctx.newPage()
if (CASE === 'skew') await viewer.addInitScript(SKEW_STUB)

if (CASE === 'delay') {
  console.log('waiting 100 s with the host tab hidden ...')
  await viewer.goto('about:blank')
  await viewer.bringToFront()
  await viewer.waitForTimeout(100_000)
}

await viewer.goto(link)
await viewer.bringToFront()

for (let i = 1; i <= 10; i++) {
  await viewer.waitForTimeout(3000)
  const v = await viewer.evaluate(() => ({
    overlay: document.querySelector('.surface-overlay')?.textContent?.replace(/\s+/g, ' ').slice(0, 70),
    w: document.querySelector('video')?.videoWidth ?? 0,
  }))
  const hostRows = await host.evaluate(
    () => document.querySelectorAll('.viewer-row').length,
  )
  console.log(`t=${i * 3}s  viewerVideo=${v.w}  hostViewers=${hostRows}  "${v.overlay ?? 'none'}"`)
  if (v.w > 0) break
}

await browser.close()
