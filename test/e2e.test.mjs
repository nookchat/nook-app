import { mkdirSync } from 'node:fs'
import { APP_URL, FAKE_MEDIA, check, finish, launch, stoppedEarly, wait } from './harness.mjs'

const SHOTS = new URL('../test-output/', import.meta.url).pathname

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
    ctx.fillText('NOOK TEST FRAME ' + frame, 40, 90)
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

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await wait(400)
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}. Last value: ${JSON.stringify(last)}`)
}

const errors = { host: [], viewer: [] }
function watch(page, who) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    errors[who].push(m.text())
  })
  page.on('pageerror', (e) => errors[who].push(String(e)))
}

const browser = await launch({ args: [...FAKE_MEDIA, '--allow-running-insecure-content'], named: false })

mkdirSync(SHOTS, { recursive: true })

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.grantPermissions(['microphone'], { origin: new URL(APP_URL).origin })

  const host = await context.newPage()
  watch(host, 'host')
  await host.addInitScript(DISPLAY_STUB)
  await host.goto(APP_URL, { waitUntil: 'domcontentloaded' })

  await host.waitForSelector('button:has-text("I have an account")', { timeout: 10_000 })
  await host.click('.welcome-step:not(.hidden) button.primary')
  await host.waitForSelector('input[aria-label="Your name"]', { timeout: 10_000 })
  const emptyStops = await host.evaluate(() => document.querySelector('.welcome-step:not(.hidden) .welcome-go')?.disabled === true)
  check('somebody new is asked for a name first, and cannot go on without one', emptyStops)
  await host.fill('input[aria-label="Your name"]', 'Hana Host')
  await host.keyboard.press('Enter')
  await host.getByRole('button', { name: 'New space' }).waitFor({ timeout: 10_000 })

  const opening = await host.evaluate(() => ({
    // The stylesheet draws section labels in capitals, and innerText reports what is drawn.
    list: document.body.innerText.toLowerCase().includes('your spaces'),
    make: !!Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('New space'),
    ),
  }))
  check('the app opens on your spaces', opening.list && opening.make)

  await host.getByRole('button', { name: 'New space' }).click()
  await host.click('.space-title-button')
  await host.click('.menu-item:has-text("Invite")')
  const codeBox = host.locator('.share-code')
  await codeBox.waitFor({ timeout: 15_000 })
  const link = await codeBox.getAttribute('data-link')
  check(
    'a new space has a code and a link',
    /#[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}@/.test(link),
    link,
  )

  // The channel rail can draw a frame after the invite code, so wait for it.
  const room = await waitFor(
    async () => {
      const seen = await host.evaluate(() => ({
        channels: Array.from(document.querySelectorAll('.rail-item')).map((b) =>
          b.textContent?.trim(),
        ),
        chat: !!document.querySelector('.chat-log'),
        composer: !document.querySelector('[aria-label="Write a message"]')?.disabled,
        video: !!document.querySelector('video'),
      }))
      return seen.channels.length > 0 ? seen : null
    },
    15_000,
    'the space to finish drawing itself',
  )
  check(
    'a space opens with channels and a working chat, with no stream',
    room.channels.some((c) => c?.includes('general')) && room.chat && room.composer && !room.video,
    `channels: ${room.channels.join(', ')}`,
  )

  const serverOpen = await waitFor(
    async () =>
      host.evaluate(() => {
        const text = document.querySelector('.status-bar')?.innerText ?? ''
        return /\d+ here/.test(text) && !text.includes('cannot reach') ? text : null
      }),
    30_000,
    'the server to report open',
  )
  check('the space is on its server', !!serverOpen, serverOpen ?? 'nothing')

  const gpu = await host.evaluate(async () => {
    const { probeHardwareEncoders } = await import('/src/rtc/hardware.ts')
    const { availableCodecs } = await import('/src/rtc/quality.ts')
    const probe = await probeHardwareEncoders(availableCodecs())
    return { hardware: probe.hardware, checked: probe.checked, note: probe.note }
  })
  check(
    'Nook probes for a hardware encoder and reports what it found',
    gpu.checked === true && Array.isArray(gpu.hardware) && gpu.note.length > 20,
    gpu.hardware.length ? `hardware: ${gpu.hardware.join(', ')}` : 'no hardware encoder here',
  )

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

  // A second profile, because two tabs of one profile are one person with two windows.
  const viewerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await viewerContext.grantPermissions(['microphone'], { origin: new URL(APP_URL).origin })
  const viewer = await viewerContext.newPage()
  watch(viewer, 'viewer')
  await viewer.goto(link, { waitUntil: 'domcontentloaded' })

  await viewer.waitForSelector('button:has-text("I have an account")', { timeout: 10_000 })
  const invitedTitle = await viewer.$eval('.welcome-title', (el) => el.textContent)
  await viewer.click('.welcome-step:not(.hidden) button.primary')
  await viewer.waitForSelector('input[aria-label="Your name"]', { timeout: 10_000 })
  const invitedWords = await viewer.evaluate(() => ({
    go: document.querySelector('.welcome-step:not(.hidden) .welcome-go')?.textContent ?? '',
  }))
  check('an invite asks for a name before joining', invitedTitle === 'You have been invited' && invitedWords.go === 'Join', JSON.stringify({ invitedTitle, ...invitedWords }))
  await viewer.fill('input[aria-label="Your name"]', 'Vic Viewer')
  await viewer.click('.welcome-step:not(.hidden) .welcome-go')
  await viewer.waitForSelector('.space-name', { timeout: 15_000 })
  check('and then drops you straight into the space', true)

  const meshUp = await waitFor(
    async () =>
      viewer.evaluate(() => {
        const text = document.querySelector('.status-bar')?.textContent ?? ''
        const m = text.match(/(\d+) here/)
        return m && Number(m[1]) >= 2 ? Number(m[1]) : null
      }),
    45_000,
    'the two people to see each other',
  )
  check('the two see each other with nobody sharing', meshUp >= 2, `${meshUp} here`)

  await host.click('.voice-channel .rail-item:has-text("lounge")')
  await host.waitForSelector('.voice-bar:not(.hidden)', { timeout: 15_000 })
  await host.click('button[aria-label="Share screen"]')

  const offered = await waitFor(
    async () =>
      viewer.evaluate(() => {
        const bar = document.querySelector('.stream-bar')
        if (!bar || bar.classList.contains('hidden')) return null
        const button = [...bar.querySelectorAll('.stream-tab')].find(
          (b) => b.dataset.watch === 'peer',
        )
        return button ? button.textContent.trim() : null
      }),
    30_000,
    'the viewer to be offered the stream',
  )
  check('a viewer is offered the stream rather than given it', !!offered, offered ?? 'no offer')

  const notYet = await viewer.evaluate(() => !document.querySelector('video'))
  check('and nothing is on their screen until they ask', notYet)

  await viewer.evaluate(() => {
    const button = [...document.querySelectorAll('.stream-tab')].find((b) => b.dataset.watch === 'peer')
    button?.click()
  })

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
  const sound = await (async () => {
    // The unmute attempt resolves a moment after the video arrives.
    await viewer.waitForTimeout(1500)
    const mutedNow = await viewer.evaluate(() => document.querySelector('video')?.muted)
    if (mutedNow === false) return { path: 'played with sound unasked' }
    const prompt = viewer.locator('.sound-prompt')
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
        const title = document.querySelector('.stage-tile')?.title ?? ''
        return /[1-9][\d.]* ?(kb\/s|Mb\/s)/.test(title) ? title : null
      }),
    30_000,
    'the viewer tile to report a real bitrate',
  )
  check('viewer stats report a bitrate', !!stats, stats ?? 'none')

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
        const tab = document.querySelector('.stream-tab[data-watch="self"]')
        const text = tab?.textContent ?? ''
        return /watching/.test(text) ? text.replace(/\s+/g, ' ').trim() : null
      }),
    30_000,
    'the stream bar to report a watcher',
  )
  check('the sharer sees who is watching', /1 watching/.test(sharingLine), sharingLine.slice(0, 90))

  const chatWorks = await waitFor(
    async () => viewer.evaluate(() => (document.querySelector('.chat-log') ? true : null)),
    10_000,
    'the chat panel to appear',
  )
  check('the viewer has a chat panel', chatWorks === true)

  const viewerName = await viewer.evaluate(
    () => document.querySelector('input[aria-label="Your name in the chat"]')?.value ?? '',
  )
  check('the viewer is called what they chose', viewerName === 'Vic Viewer', viewerName)
  const hostSeen = await waitFor(
    async () =>
      viewer.evaluate(() =>
        [...document.querySelectorAll('.rail-person')].some((r) => r.textContent.includes('Hana Host')) ? true : null,
      ),
    10_000,
    'the host to be listed by the name they chose',
  )
  check('and everybody else is too', hostSeen === true)

  await viewer.fill('[aria-label="Write a message"]', 'hello from the viewer')
  await viewer.press('[aria-label="Write a message"]', 'Enter')
  const hostGotLine = await waitFor(
    async () =>
      host.evaluate(() => {
        const text = document.querySelector('.chat-log')?.textContent ?? ''
        return text.includes('hello from the viewer') ? text : null
      }),
    15_000,
    'the host to receive the chat line',
  )
  check('a viewer line reaches the host', !!hostGotLine)

  await host.fill('[aria-label="Write a message"]', 'and hello back')
  await host.press('[aria-label="Write a message"]', 'Enter')
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

  const skewed = await viewerContext.newPage()
  watch(skewed, 'viewer')
  await skewed.addInitScript(SKEW_STUB)
  await skewed.goto(link, { waitUntil: 'domcontentloaded' })
  await waitFor(
    async () =>
      skewed.evaluate(() => {
        const button = [...document.querySelectorAll('.stream-tab')].find(
          (b) => b.dataset.watch === 'peer',
        )
        if (!button) return null
        button.click()
        return true
      }),
    30_000,
    'the skewed viewer to be offered the stream',
  )
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
        // The stage has a border, so the video sits a pixel inside it.
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

  await host.click('button[aria-label="Stop sharing"]')
  const stillThere = await waitFor(
    async () =>
      host.evaluate(() => {
        const chat = document.querySelector('.chat-log')?.textContent ?? ''
        return !document.querySelector('button[aria-label="Stop sharing"]') && chat.length > 0 ? chat : null
      }),
    15_000,
    'the space to carry on after the share stops',
  )
  check('the space carries on when the sharing stops', stillThere.length > 0)

  const buttonGone = await waitFor(
    async () =>
      viewer.evaluate(() => (document.querySelector('.stream-tab[data-watch="peer"]') ? null : true)),
    15_000,
    'the stream card to go with the stream',
  )
  check('the way in goes when the stream ends', buttonGone === true)
  await viewer.screenshot({ path: `${SHOTS}viewer-ended.png` })

  check('no console errors on the host', errors.host.length === 0, errors.host.join(' | '))
  check('no console errors on the viewer', errors.viewer.length === 0, errors.viewer.join(' | '))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

console.log(`Screenshots in ${SHOTS}`)
finish()
