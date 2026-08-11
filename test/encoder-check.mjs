/**
 * Which encoder does each codec actually get, and is it on the GPU?
 *
 * WebRTC reports `encoderImplementation` and `powerEfficientEncoder` on the
 * outbound stream. Those two fields are the difference between a share that
 * costs a game a few frames and one that costs it half its frame rate, so this
 * asks the browser rather than guessing.
 *
 *   node test/encoder-check.mjs [fps]
 *
 * The source is a 1920x1080 canvas driven as hard as the page allows, which is
 * the closest a test can get to a game without one running.
 */

import { chromium } from 'playwright-core'

const FPS = Number(process.argv[2] ?? 60)
const APP_URL = process.argv[3] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const CODECS = ['H265', 'VP9', 'H264']

/** A busy 1080p source: lots of movement, so nothing can be skipped as static. */
const displayStub = (fps) => `(() => {
  const c = document.createElement('canvas')
  c.width = 1920
  c.height = 1080
  const x = c.getContext('2d')
  let f = 0
  const draw = () => {
    f++
    x.fillStyle = '#08111f'
    x.fillRect(0, 0, 1920, 1080)
    for (let i = 0; i < 90; i++) {
      x.fillStyle = 'hsl(' + ((f * 3 + i * 4) % 360) + ' 80% 55%)'
      const px = (Math.sin((f + i * 17) / 21) * 0.5 + 0.5) * 1800
      const py = (Math.cos((f + i * 11) / 17) * 0.5 + 0.5) * 980
      x.fillRect(px, py, 110, 90)
    }
    x.fillStyle = '#fff'
    x.font = '54px monospace'
    x.fillText('FRAME ' + f, 40, 80)
    requestAnimationFrame(draw)
  }
  draw()
  const stream = c.captureStream(${fps})
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(stream.getVideoTracks())
})()`

/** Keeps every peer connection the page makes, so the test can read its stats. */
const PC_SPY = `(() => {
  const Original = window.RTCPeerConnection
  window.__pcs = []
  const Wrapped = function (...args) {
    const pc = new Original(...args)
    window.__pcs.push(pc)
    return pc
  }
  Wrapped.prototype = Original.prototype
  Object.setPrototypeOf(Wrapped, Original)
  window.RTCPeerConnection = Wrapped
})()`

const settingsFor = (codec, fps) => `(() => {
  localStorage.setItem('cathode.settings.v1', ${JSON.stringify(
    JSON.stringify({
      presetId: 'custom',
      mode: 'motion',
      maxHeight: 1080,
      fps: 0, // replaced below
      bitrateScale: 1,
      budgetKbps: 20000,
      budgetAuto: false,
      maxViewers: 10,
      approve: false,
      codec: 'auto',
      shareSystemAudio: false,
    }),
  )}.replace('"fps":0', '"fps":${fps}').replace('"codec":"auto"', '"codec":"${codec}"'))
})()`

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})

const rows = []

for (const codec of CODECS) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const host = await context.newPage()
  await host.addInitScript(settingsFor(codec, FPS))
  await host.addInitScript(displayStub(FPS))
  await host.addInitScript(PC_SPY)
  await host.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await host.getByRole('button', { name: 'Choose what to share' }).click()
  const box = host.locator('.share-code')
  await box.waitFor({ timeout: 15_000 })
  const link = await box.getAttribute('data-link')

  const viewer = await context.newPage()
  await viewer.addInitScript(PC_SPY)
  await viewer.goto(link, { waitUntil: 'domcontentloaded' })

  // Let the encoder settle and the bandwidth estimate open up.
  await host.waitForTimeout(22_000)

  const stats = await host.evaluate(async () => {
    for (const pc of window.__pcs ?? []) {
      const report = await pc.getStats()
      let out = null
      report.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') out = s
      })
      if (out && out.bytesSent > 0) {
        let codecName = ''
        report.forEach((s) => {
          if (s.type === 'codec' && s.id === out.codecId) codecName = s.mimeType
        })
        return {
          encoder: out.encoderImplementation ?? 'unreported',
          powerEfficient: out.powerEfficientEncoder ?? null,
          codec: codecName,
          fps: Math.round(out.framesPerSecond ?? 0),
          width: out.frameWidth ?? 0,
          height: out.frameHeight ?? 0,
          limitation: out.qualityLimitationReason ?? '',
          sent: out.framesSent ?? 0,
          encodeMsPerFrame:
            out.framesEncoded > 0
              ? Math.round(((out.totalEncodeTime ?? 0) / out.framesEncoded) * 1000 * 100) / 100
              : 0,
        }
      }
    }
    return null
  })

  const decode = await viewer.evaluate(async () => {
    const pcs = window.__pcs ?? []
    for (const pc of pcs) {
      const report = await pc.getStats()
      let inb = null
      report.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s
      })
      if (inb && inb.bytesReceived > 0) {
        return {
          decoder: inb.decoderImplementation ?? 'unreported',
          powerEfficient: inb.powerEfficientDecoder ?? null,
          fps: Math.round(inb.framesPerSecond ?? 0),
          dropped: inb.framesDropped ?? 0,
          decodeMsPerFrame:
            inb.framesDecoded > 0
              ? Math.round(((inb.totalDecodeTime ?? 0) / inb.framesDecoded) * 1000 * 100) / 100
              : 0,
        }
      }
    }
    return null
  })

  rows.push({ codec, stats, decode })
  console.log(
    stats
      ? `${codec.padEnd(5)} → ${String(stats.codec).padEnd(10)} ${stats.encoder.padEnd(28)} ` +
          `gpu=${stats.powerEfficient === null ? '?' : stats.powerEfficient} ` +
          `${stats.width}x${stats.height} @${stats.fps}fps  ` +
          `encode ${stats.encodeMsPerFrame}ms/frame  limited=${stats.limitation}` +
          (decode ? `  |  decode ${decode.decodeMsPerFrame}ms/frame @${decode.fps}fps` : '')
      : `${codec.padEnd(5)} → no outbound stream`,
  )

  await context.close()
}

console.log('\nSummary')
for (const r of rows) {
  if (!r.stats) continue
  const gpu = r.stats.powerEfficient
  console.log(
    `  ${r.codec.padEnd(5)} ${gpu === true ? 'hardware' : gpu === false ? 'software' : 'unknown '} ` +
      `${r.stats.encoder}`,
  )
}

await browser.close()
