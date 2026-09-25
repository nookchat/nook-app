import { APP_URL, check, finish, hostAndShare, joinAndWatch, launch, stoppedEarly } from './harness.mjs'

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

const hostBrowser = await launch({ args: ['--use-fake-ui-for-media-stream'] })
// A viewer with no HEVC at all, the way an older or a Linux machine looks.
const viewerBrowser = await launch({ args: ['--disable-features=PlatformHEVCDecoderSupport,WebRtcAllowH265Receive'] })

try {
  const host = await (await hostBrowser.newContext()).newPage()
  await host.addInitScript(GAME_SETTINGS)
  await host.addInitScript(STUB)
  await host.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  const link = await hostAndShare(host)

  const viewer = await (await viewerBrowser.newContext()).newPage()
  await joinAndWatch(viewer, link)

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

  const row = await viewer.evaluate(() => document.querySelector('.stage-tile')?.title ?? '')
  check('the stream falls back to a codec the viewer can decode', /VP9|VP8|H264|AV1/.test(row), row.trim())
} catch (err) {
  stoppedEarly(err)
} finally {
  await hostBrowser.close()
  await viewerBrowser.close()
}

finish()
