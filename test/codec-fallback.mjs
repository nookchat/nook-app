/**
 * A viewer without the hardware codec must still get a picture.
 *
 * Cathode asks for a hardware codec first on moving pictures, and on an Apple
 * machine that is HEVC. Plenty of viewers cannot decode HEVC: older Chrome,
 * most Linux machines, Firefox. Codec preferences only order the offer, so the
 * answer decides, and this proves that path rather than trusting it.
 *
 *   node test/codec-fallback.mjs
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const STUB = `(() => {
  const c = document.createElement('canvas')
  c.width = 1920; c.height = 1080
  const x = c.getContext('2d')
  let f = 0
  const d = () => {
    f++
    x.fillStyle = '#123'; x.fillRect(0, 0, 1920, 1080)
    for (let i = 0; i < 60; i++) {
      x.fillStyle = 'hsl(' + ((f * 3 + i * 6) % 360) + ' 80% 55%)'
      x.fillRect((Math.sin((f + i * 17) / 21) * .5 + .5) * 1800, (Math.cos((f + i * 11) / 17) * .5 + .5) * 980, 120, 100)
    }
    requestAnimationFrame(d)
  }
  d()
  const s = c.captureStream(60)
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(s.getVideoTracks())
})()`

const GAME_SETTINGS = `localStorage.setItem('cathode.settings.v1', ${JSON.stringify(
  JSON.stringify({
    presetId: 'game',
    mode: 'motion',
    maxHeight: 1080,
    fps: 60,
    bitrateScale: 1.3,
    budgetKbps: 20000,
    budgetAuto: false,
    maxViewers: 10,
    approve: false,
    codec: 'auto',
    shareSystemAudio: false,
  }),
)})`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const hostBrowser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream'],
})
// A viewer with no HEVC at all, the way an older or a Linux machine looks.
const viewerBrowser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--disable-features=PlatformHEVCDecoderSupport,WebRtcAllowH265Receive'],
})

try {
  const host = await (await hostBrowser.newContext()).newPage()
  await host.addInitScript(GAME_SETTINGS)
  await host.addInitScript(STUB)
  await host.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await host.getByRole('button', { name: 'New space' }).click()
  await host.getByRole('button', { name: 'Share screen' }).click()
  const link = await host.locator('.share-code').getAttribute('data-link')

  const viewer = await (await viewerBrowser.newContext()).newPage()
  await viewer.goto(link, { waitUntil: 'domcontentloaded' })

  const receives = await viewer.evaluate(() =>
    (RTCRtpReceiver.getCapabilities('video')?.codecs ?? []).map((c) => c.mimeType),
  )
  check(
    'the test viewer really has no HEVC decoder',
    !receives.some((m) => /265/i.test(m)),
    receives.filter((m) => !/rtx|red|ulpfec|flexfec/i.test(m)).join(', '),
  )

  await host.waitForTimeout(14_000)

  const playing = await viewer.evaluate(() => {
    const el = document.querySelector('video')
    return { w: el?.videoWidth ?? 0, live: !!el && !el.paused && el.currentTime > 0 }
  })
  check('a viewer without HEVC still receives a picture', playing.live && playing.w > 0, `${playing.w} px wide`)

  const row = await host.evaluate(() =>
    Array.from(document.querySelectorAll('.viewer-row .pill'))
      .map((p) => p.textContent ?? '')
      .join(' '),
  )
  check('the stream falls back to a codec the viewer can decode', /VP9|VP8|H264|AV1/.test(row), row.trim())
  check('Cathode does not claim the GPU when it fell back', !/on GPU/.test(row))
} finally {
  await hostBrowser.close()
  await viewerBrowser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} of ${results.length} checks passed.`)
process.exit(failed === 0 ? 0 : 1)
