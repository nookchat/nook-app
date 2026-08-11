/**
 * Mesh load test.
 *
 * A mesh host encodes and sends the picture once per viewer, so upload and
 * processor time are the real viewer limit. This opens N viewers against one
 * host and prints what the host reports for each of them.
 *
 *   node test/mesh.mjs 8 [url]
 *
 * Every viewer runs in the same browser as the host here, so the numbers are
 * pessimistic on processor time and optimistic on network. Treat it as a
 * smoke test of the budget logic, not as a field measurement.
 */

import { chromium } from 'playwright-core'

const COUNT = Number(process.argv[2] ?? 8)
const APP_URL = process.argv[3] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const DISPLAY_STUB = `(() => {
  const canvas = document.createElement('canvas')
  canvas.width = 1920; canvas.height = 1080
  const ctx = canvas.getContext('2d')
  let frame = 0
  setInterval(() => {
    frame++
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, 1920, 1080)
    ctx.fillStyle = '#00c2a8'; ctx.fillRect((frame * 11) % 1800, 400, 120, 120)
    ctx.fillStyle = '#e8ecf1'; ctx.font = '48px monospace'
    ctx.fillText('MESH FRAME ' + frame, 60, 120)
  }, 33)
  const s = canvas.captureStream(30)
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(s.getVideoTracks())
})()`

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })

const host = await ctx.newPage()
await host.addInitScript(DISPLAY_STUB)
await host.goto(APP_URL)
await host.getByRole('button', { name: 'Choose what to share' }).click()
const linkBox = host.locator('.share-code')
await linkBox.waitFor({ timeout: 15_000 })
const link = await linkBox.getAttribute('data-link')
console.log(`host is live at ${link}`)
await host.waitForTimeout(4000)

const viewers = []
for (let i = 0; i < COUNT; i++) {
  const page = await ctx.newPage()
  await page.goto(link)
  viewers.push(page)
  console.log(`viewer ${i + 1} joined`)
  await page.waitForTimeout(1500)
}

console.log('\nsettling for 20 seconds ...')
await host.waitForTimeout(20_000)

const report = await host.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.viewer-row')).map((r) =>
    (r.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
  const plan = document.querySelector('.plan-line')?.textContent ?? ''
  return { rows, plan }
})

console.log('\nhost plan line:')
console.log('  ' + report.plan)
console.log(`\nhost sees ${report.rows.length} viewers:`)
for (const row of report.rows) console.log('  ' + row)

const totalKbps = report.rows
  .map((r) => {
    const mb = r.match(/([\d.]+) Mb\/s/)
    if (mb) return Number(mb[1]) * 1000
    const kb = r.match(/(\d+) kb\/s/)
    return kb ? Number(kb[1]) : 0
  })
  .reduce((a, b) => a + b, 0)

const connected = await Promise.all(
  viewers.map((p) =>
    p.evaluate(() => {
      const v = document.querySelector('video')
      return !!v && v.videoWidth > 0 && v.currentTime > 0
    }),
  ),
)

console.log(`\n${connected.filter(Boolean).length} of ${COUNT} viewers show live video.`)
console.log(`total outgoing video: ${(totalKbps / 1000).toFixed(2)} Mb/s`)
const limited = report.rows.filter((r) => /limited:/.test(r)).length
console.log(`viewers the encoder had to limit: ${limited}`)

await host.screenshot({ path: new URL('../test-output/mesh-host.png', import.meta.url).pathname })
await browser.close()
process.exit(connected.filter(Boolean).length === COUNT ? 0 : 1)
