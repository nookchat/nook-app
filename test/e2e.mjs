/**
 * End to end smoke test.
 *
 * Two real Chrome pages, the real public relays, and a real peer connection.
 * The only thing we fake is the operating system picker: getDisplayMedia gives
 * back a canvas stream plus a tone, so the test needs no screen permission and
 * stays the same on every machine.
 *
 *   node test/e2e.mjs [url]
 *
 * Run `npm run dev` first, or pass the URL of a built preview.
 */

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SHOTS = new URL('../test-output/', import.meta.url).pathname
const HEADLESS = process.env.HEADED !== '1'

const DISPLAY_STUB = `(() => {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  const ctx = canvas.getContext('2d')
  let frame = 0
  setInterval(() => {
    frame++
    ctx.fillStyle = '#0d1117'
    ctx.fillRect(0, 0, 1280, 720)
    ctx.fillStyle = '#00c2a8'
    ctx.fillRect((frame * 9) % 1180, 260, 100, 100)
    ctx.fillStyle = '#e8ecf1'
    ctx.font = '40px monospace'
    ctx.fillText('BEAM TEST FRAME ' + frame, 40, 90)
    ctx.font = '20px monospace'
    ctx.fillText('the quick brown fox jumps over the lazy dog 0123456789', 40, 620)
  }, 33)
  const canvasStream = canvas.captureStream(30)

  navigator.mediaDevices.getDisplayMedia = async () => {
    const ac = new AudioContext()
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    const dest = ac.createMediaStreamDestination()
    osc.frequency.value = 440
    gain.gain.value = 0.03
    osc.connect(gain)
    gain.connect(dest)
    osc.start()
    return new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()])
  }
})()`

/** Puts a page five minutes ahead of the host, the way two real machines drift. */
const SKEW_STUB = `(() => {
  const RealDate = Date
  const real = Date.now
  const offset = 5 * 60 * 1000
  Date.now = () => real() + offset
  window.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [real() + offset])) }
    static now() { return real() + offset }
  }
})()`

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}. Last value: ${JSON.stringify(last)}`)
}

const errors = { host: [], viewer: [] }
const relayNoise = { host: 0, viewer: 0 }

/**
 * A public relay that refuses a connection is normal, and Beam is built to ride
 * it out on another relay. The browser still logs it, so we count it apart from
 * a real application error.
 */
const isRelayNoise = (text) => /WebSocket connection to '(wss|ws):/.test(text)

function watch(page, who) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    if (isRelayNoise(m.text())) relayNoise[who] += 1
    else errors[who].push(m.text())
  })
  page.on('pageerror', (e) => errors[who].push(String(e)))
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-running-insecure-content',
  ],
})

mkdirSync(SHOTS, { recursive: true })
let exitCode = 0

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.grantPermissions(['microphone'], { origin: new URL(APP_URL).origin })

  // ---- host ----
  const host = await context.newPage()
  watch(host, 'host')
  await host.addInitScript(DISPLAY_STUB)
  await host.goto(APP_URL, { waitUntil: 'domcontentloaded' })

  await host.getByRole('button', { name: 'Share my screen' }).click()
  const linkInput = host.locator('input[aria-label="The link to share"]')
  await linkInput.waitFor({ timeout: 15_000 })
  const link = await linkInput.inputValue()
  check('host starts and shows a link', /#r=[A-Za-z0-9_-]{20,}/.test(link), link)

  const relayOpen = await waitFor(
    async () => host.evaluate(() => document.querySelectorAll('.pill.relay.good').length || null),
    25_000,
    'at least one relay to report open',
  )
  check('a signal relay came up', relayOpen > 0, `${relayOpen} good pills`)

  // ---- viewer ----
  const viewer = await context.newPage()
  watch(viewer, 'viewer')
  await viewer.goto(link, { waitUntil: 'domcontentloaded' })
  await viewer.getByRole('button', { name: 'Join the stream' }).click()
  check('viewer shows the join screen', true)

  const playing = await waitFor(
    async () =>
      viewer.evaluate(() => {
        const v = document.querySelector('video')
        if (!v) return null
        return v.videoWidth > 0 && v.readyState >= 2 && v.currentTime > 0
          ? { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, muted: v.muted }
          : null
      }),
    60_000,
    'the viewer video to play',
  )
  check('viewer receives live video', playing.w > 0, `${playing.w}x${playing.h}`)
  check('viewer audio is not muted', playing.muted === false)

  const stats = await waitFor(
    async () =>
      viewer.evaluate(() => {
        const text = Array.from(document.querySelectorAll('.surface-badges .pill')).map(
          (p) => p.textContent ?? '',
        )
        const kb = text.find((t) => /kb\/s|Mb\/s/.test(t))
        return kb && !/^0\b/.test(kb) ? text : null
      }),
    30_000,
    'the viewer stats badges to show a real bitrate',
  )
  check('viewer stats report a bitrate', true, stats.join(' | '))

  const audioFlowing = await waitFor(
    async () =>
      viewer.evaluate(async () => {
        const v = document.querySelector('video')
        const stream = v?.srcObject
        if (!stream) return null
        const track = stream.getAudioTracks()[0]
        return track && track.readyState === 'live' ? { label: track.label } : null
      }),
    15_000,
    'an inbound audio track',
  )
  check('viewer receives an audio track', !!audioFlowing)

  const hostSees = await waitFor(
    async () =>
      host.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.viewer-row'))
        const text = rows.map((r) => r.textContent ?? '').join(' ')
        return /kb\/s|Mb\/s/.test(text) ? text.replace(/\s+/g, ' ').trim() : null
      }),
    30_000,
    'the host viewer list to show live stats',
  )
  check('host lists the viewer with live stats', true, hostSees.slice(0, 140))

  // Two machines rarely agree on the time. A room must not depend on that.
  const skewed = await context.newPage()
  watch(skewed, 'viewer')
  await skewed.addInitScript(SKEW_STUB)
  await skewed.goto(link, { waitUntil: 'domcontentloaded' })
  await skewed.getByRole('button', { name: 'Join the stream' }).click()
  const skewOk = await waitFor(
    async () =>
      skewed.evaluate(() => {
        const v = document.querySelector('video')
        return v && v.videoWidth > 0 && v.currentTime > 0 ? v.videoWidth : null
      }),
    45_000,
    'a viewer whose clock is five minutes ahead to receive video',
  )
  check('a five minute clock difference still connects', skewOk > 0, `${skewOk} px wide`)
  await skewed.close()
  await host.waitForTimeout(1500)

  // The picture must fill the surface at every window size, and never stretch.
  const geometryAt = async (page, width, height) => {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(600)
    return page.evaluate(() => {
      const s = document.querySelector('.surface')
      const v = document.querySelector('video')
      if (!s || !v) return null
      const sr = s.getBoundingClientRect()
      const vr = v.getBoundingClientRect()
      return {
        fills: Math.abs(sr.height - vr.height) < 2 && Math.abs(sr.width - vr.width) < 2,
        surface: [Math.round(sr.width), Math.round(sr.height)],
        sideScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      }
    })
  }

  for (const [label, w, hh] of [
    ['phone portrait', 390, 844],
    ['phone landscape', 844, 390],
    ['tablet', 820, 1180],
    ['desktop', 1440, 900],
    ['4K', 3840, 2160],
  ]) {
    const g = await geometryAt(viewer, w, hh)
    check(`viewer surface fills the window at ${label}`, g?.fills === true, `surface ${g?.surface}`)
    check(`viewer has no sideways scroll at ${label}`, g?.sideScroll === false)
  }

  await viewer.setViewportSize({ width: 390, height: 844 })
  await viewer.waitForTimeout(500)
  await viewer.screenshot({ path: `${SHOTS}viewer-phone.png` })

  await viewer.setViewportSize({ width: 1440, height: 900 })
  await viewer.waitForTimeout(400)
  await viewer.screenshot({ path: `${SHOTS}viewer-desktop.png` })
  await host.screenshot({ path: `${SHOTS}host-desktop.png` })

  await host.setViewportSize({ width: 820, height: 1180 })
  await host.waitForTimeout(400)
  await host.screenshot({ path: `${SHOTS}host-tablet.png` })
  await host.setViewportSize({ width: 1440, height: 900 })

  // ---- the host stops, the viewer must be told ----
  await host.getByRole('button', { name: 'Stop the stream' }).click()
  const ended = await waitFor(
    async () => viewer.evaluate(() => document.body.innerText.includes('The stream ended')),
    20_000,
    'the viewer to see the end of the stream',
  )
  check('viewer is told when the host stops', ended)
  await viewer.screenshot({ path: `${SHOTS}viewer-ended.png` })

  check('no console errors on the host', errors.host.length === 0, errors.host.join(' | '))
  check('no console errors on the viewer', errors.viewer.length === 0, errors.viewer.join(' | '))
  console.log(
    `note: ${relayNoise.host + relayNoise.viewer} relay connection attempts were refused and retried elsewhere.`,
  )
} catch (err) {
  console.error('\nThe run stopped early:', err.message)
  exitCode = 1
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`)
console.log(`Screenshots in ${SHOTS}`)
process.exit(failed.length > 0 || exitCode ? 1 : 0)
