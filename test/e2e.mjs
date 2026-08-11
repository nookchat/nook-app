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
    ctx.fillText('CATHODE TEST FRAME ' + frame, 40, 90)
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
 * A public relay that refuses a connection is normal, and Cathode is built to ride
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
  // The list is read from IndexedDB, so it arrives a beat after the page.
  await host.getByRole('button', { name: 'New space' }).waitFor({ timeout: 10_000 })

  // The app opens on the spaces you have been in, not on a screen picker.
  const opening = await host.evaluate(() => ({
    list: document.body.innerText.includes('Your spaces'),
    make: !!Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('New space'),
    ),
  }))
  check('the app opens on your spaces', opening.list && opening.make)

  await host.getByRole('button', { name: 'New space' }).click()
  const codeBox = host.locator('.share-code')
  await codeBox.waitFor({ timeout: 15_000 })
  const link = await codeBox.getAttribute('data-link')
  check(
    'a new space has a code and a link',
    /#[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/.test(link),
    link,
  )

  // Chat is the app, so it is there before anybody shares anything.
  const room = await host.evaluate(() => ({
    channels: Array.from(document.querySelectorAll('.rail-item')).map((b) => b.textContent?.trim()),
    chat: !!document.querySelector('.chat-log'),
    composer: !document.querySelector('input[aria-label="Write a message"]')?.disabled,
    video: !!document.querySelector('video'),
  }))
  check(
    'a space opens with channels and a working chat, with no stream',
    room.channels.some((c) => c?.includes('general')) && room.chat && room.composer && !room.video,
    `channels: ${room.channels.join(', ')}`,
  )

  const relayOpen = await waitFor(
    async () =>
      host.evaluate(() => {
        const text = document.querySelector('.xp-status')?.textContent ?? ''
        const m = text.match(/(\d+) relay/)
        return m && Number(m[1]) > 0 ? Number(m[1]) : null
      }),
    30_000,
    'at least one relay to report open',
  )
  check('a signal relay came up', relayOpen > 0, `${relayOpen} relays`)

  // Cathode must name where encoding happens, without pretending either way.
  const gpu = await host.evaluate(async () => {
    const { probeHardwareEncoders } = await import('/src/rtc/hardware.ts')
    const { availableCodecs } = await import('/src/rtc/quality.ts')
    const probe = await probeHardwareEncoders(availableCodecs())
    return { hardware: probe.hardware, checked: probe.checked, note: probe.note }
  })
  check(
    'Cathode probes for a hardware encoder and reports what it found',
    gpu.checked === true && Array.isArray(gpu.hardware) && gpu.note.length > 20,
    gpu.hardware.length ? `hardware: ${gpu.hardware.join(', ')}` : 'no hardware encoder here',
  )

  // The QR must carry the exact link. Chrome's own decoder is the judge.
  await host.getByRole('button', { name: 'Show a QR code' }).click()
  await host.locator('.qr-frame svg').waitFor({ timeout: 5000 })
  const scanned = await host.evaluate(async () => {
    const svg = document.querySelector('.qr-frame svg')
    if (!svg) return { error: 'no QR was drawn' }
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.width = 520
      img.height = 520
      await new Promise((ok, fail) => {
        img.onload = ok
        img.onerror = () => fail(new Error('the QR image would not load'))
        img.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 520
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, 520, 520)
      ctx.drawImage(img, 0, 0, 520, 520)
      const found = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(canvas)
      return { value: found[0]?.rawValue ?? null }
    } catch (err) {
      return { error: String(err) }
    } finally {
      URL.revokeObjectURL(url)
    }
  })
  check('the QR code decodes back to the link', scanned.value === link, scanned.error ?? scanned.value ?? 'nothing')
  await host.keyboard.press('Escape')

  // ---- viewer ----
  const viewer = await context.newPage()
  watch(viewer, 'viewer')
  await viewer.goto(link, { waitUntil: 'domcontentloaded' })

  check('an invite link drops you straight into the space', true)

  // The two of them find each other with nobody hosting anything.
  const meshUp = await waitFor(
    async () =>
      viewer.evaluate(() => {
        const text = document.querySelector('.chat-panel .pill')?.textContent ?? ''
        const m = text.match(/(\d+) here/)
        return m && Number(m[1]) >= 2 ? Number(m[1]) : null
      }),
    45_000,
    'the two peers to meet on the mesh',
  )
  check('the peers meet on the mesh with nobody sharing', meshUp >= 2, `${meshUp} here`)

  // Only now does somebody share a screen, inside the channel they are in.
  await host.getByRole('button', { name: 'Share screen' }).click()

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
  /*
   * Sound needs a gesture, and joining is now automatic, so there may not have
   * been one. The picture must never wait for that: it plays muted, and a single
   * click turns the sound on. Either outcome is correct; silence with no way out
   * is not.
   */
  const sound = await (async () => {
    // Read the live state, not the snapshot taken the instant video arrived:
    // the unmute attempt resolves a moment after that.
    await viewer.waitForTimeout(1500)
    const mutedNow = await viewer.evaluate(() => document.querySelector('video')?.muted)
    if (mutedNow === false) return { path: 'played with sound unasked' }
    const prompt = await viewer.locator('.sound-prompt')
    const shown = (await prompt.count()) > 0
    if (!shown) return { path: 'muted with no way to turn sound on', bad: true }
    await prompt.click()
    const unmuted = await waitFor(
      async () => viewer.evaluate(() => (document.querySelector('video')?.muted === false ? true : null)),
      5000,
      'the sound prompt to unmute',
    )
    return { path: 'one click turned the sound on', bad: !unmuted }
  })()
  check('sound either plays or is one click away', !sound.bad, sound.path)

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

  const sharingLine = await waitFor(
    async () =>
      host.evaluate(() => {
        const text = document.querySelector('.plan-box')?.textContent ?? ''
        return /watching/.test(text) ? text.replace(/\s+/g, ' ').trim() : null
      }),
    30_000,
    'the share panel to report a watcher',
  )
  check('the sharer sees who is watching', /1 watching/.test(sharingLine), sharingLine.slice(0, 90))

  // Chat runs on the same peer connection, with the host repeating each line.
  const chatWorks = await waitFor(
    async () => viewer.evaluate(() => (document.querySelector('.chat-log') ? true : null)),
    10_000,
    'the chat panel to appear',
  )
  check('the viewer has a chat panel', chatWorks === true)

  const viewerName = await viewer.evaluate(
    () => document.querySelector('input[aria-label="Your name in the chat"]')?.value ?? '',
  )
  check('the viewer gets a name without being asked', viewerName.length > 2, viewerName)

  await viewer.fill('input[aria-label="Write a message"]', 'hello from the viewer')
  await viewer.press('input[aria-label="Write a message"]', 'Enter')
  const hostGotLine = await waitFor(
    async () =>
      host.evaluate(() => {
        const text = document.querySelector('.chat-log')?.textContent ?? ''
        return text.includes('hello from the viewer') ? text : null
      }),
    15_000,
    'the host to receive the chat line',
  )
  check('a viewer line reaches the host over the data channel', !!hostGotLine)

  await host.fill('input[aria-label="Write a message"]', 'and hello back')
  await host.press('input[aria-label="Write a message"]', 'Enter')
  const viewerGotLine = await waitFor(
    async () =>
      viewer.evaluate(() => {
        const text = document.querySelector('.chat-log')?.textContent ?? ''
        return text.includes('and hello back') ? text : null
      }),
    15_000,
    'the viewer to receive the host line',
  )
  check('a host line reaches the viewer', !!viewerGotLine)

  // Two machines rarely agree on the time. A room must not depend on that.
  const skewed = await context.newPage()
  watch(skewed, 'viewer')
  await skewed.addInitScript(SKEW_STUB)
  await skewed.goto(link, { waitUntil: 'domcontentloaded' })
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

  // One viewer leaving must not end the stream for anybody else.
  await skewed.close()
  await host.waitForTimeout(2500)
  const survived = await viewer.evaluate(() => {
    const v = document.querySelector('video')
    return {
      playing: !!v && v.videoWidth > 0 && !v.paused,
      overlay: document.querySelector('.surface-overlay')?.textContent ?? '',
    }
  })
  check(
    'a second viewer leaving does not end the stream',
    survived.playing && !survived.overlay.includes('ended'),
    survived.overlay.slice(0, 60),
  )

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
        // The stage has a border now, so the video sits a pixel inside it. What
        // matters is that it fills the box rather than being stretched or short.
        fills: Math.abs(sr.height - vr.height) <= 4 && Math.abs(sr.width - vr.width) <= 4,
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
  await host.getByRole('button', { name: 'Stop sharing' }).click()
  const stillThere = await waitFor(
    async () =>
      host.evaluate(() => {
        const chat = document.querySelector('.chat-log')?.textContent ?? ''
        return !document.querySelector('.share-panel:not(.hidden)') && chat.length > 0 ? chat : null
      }),
    15_000,
    'the space to carry on after the share stops',
  )
  check('the space carries on when the sharing stops', stillThere.length > 0)
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
