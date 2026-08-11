/** Ad hoc debugging run. Prints what both pages see, then leaves. */
import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const DISPLAY_STUB = `(() => {
  const canvas = document.createElement('canvas')
  canvas.width = 1280; canvas.height = 720
  const ctx = canvas.getContext('2d')
  let frame = 0
  setInterval(() => {
    frame++
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, 1280, 720)
    ctx.fillStyle = '#00c2a8'; ctx.fillRect((frame * 9) % 1180, 260, 100, 100)
    ctx.fillStyle = '#fff'; ctx.font = '40px monospace'
    ctx.fillText('FRAME ' + frame, 40, 90)
  }, 33)
  const s = canvas.captureStream(30)
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(s.getVideoTracks())
})()`

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })

const log = (who) => (m) => console.log(`[${who}:${m.type()}] ${m.text()}`)

const host = await ctx.newPage()
host.on('console', log('host'))
host.on('pageerror', (e) => console.log('[host:pageerror]', String(e)))
await host.addInitScript(DISPLAY_STUB)
await host.goto(APP_URL)
await host.getByRole('button', { name: 'New space' }).click()
  await host.getByRole('button', { name: 'Share screen' }).click()
await host.locator('.share-code').waitFor({ timeout: 15000 })
const link = await host.locator('.share-code').getAttribute('data-link')
console.log('LINK', link)

await host.waitForTimeout(6000)
console.log(
  'HOST relays:',
  await host.evaluate(() =>
    Array.from(document.querySelectorAll('.card')).map((c) => c.textContent?.replace(/\s+/g, ' ').slice(0, 200)),
  ),
)

const viewer = await ctx.newPage()
viewer.on('console', log('viewer'))
viewer.on('pageerror', (e) => console.log('[viewer:pageerror]', String(e)))
await viewer.goto(link)

for (let i = 0; i < 8; i++) {
  await viewer.waitForTimeout(3000)
  const state = await viewer.evaluate(() => {
    const v = document.querySelector('video')
    return {
      overlay: document.querySelector('.surface-overlay')?.textContent?.replace(/\s+/g, ' ').slice(0, 160),
      videoW: v?.videoWidth,
      ready: v?.readyState,
      badges: Array.from(document.querySelectorAll('.surface-badges .pill')).map((p) => p.textContent),
    }
  })
  const hostState = await host.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.viewer-row')).map((r) =>
      r.textContent?.replace(/\s+/g, ' ').slice(0, 120),
    )
    return { rows }
  })
  console.log(`t=${(i + 1) * 3}s`, JSON.stringify(state), JSON.stringify(hostState))
}

await browser.close()
