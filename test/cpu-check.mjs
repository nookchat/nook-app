/**
 * Does the encoder cost the processor, or the GPU?
 *
 * `totalEncodeTime` cannot answer this. It measures the wall clock of the encode
 * call, and a hardware encoder still takes time to hand a frame back, so a
 * hardware encode and a software encode can report the same milliseconds while
 * costing wildly different amounts of processor.
 *
 * So this measures the thing that actually matters: processor seconds burned by
 * the host browser, per wall clock second, with and without a share running.
 * The difference is what encoding costs. The host runs in its own browser so the
 * viewer's decoding never lands in the number.
 *
 *   node test/cpu-check.mjs [fps]
 *
 * Run it headed. Headless Chrome does not use the real GPU.
 */

import { chromium } from 'playwright-core'

const FPS = Number(process.argv[2] ?? 60)
const APP_URL = process.argv[3] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const CODECS = ['auto', 'H265', 'VP9', 'H264', 'AV1']
const SETTLE_MS = 10_000
const SAMPLE_MS = 20_000

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
      x.fillRect(
        (Math.sin((f + i * 17) / 21) * 0.5 + 0.5) * 1800,
        (Math.cos((f + i * 11) / 17) * 0.5 + 0.5) * 980,
        110,
        90,
      )
    }
    requestAnimationFrame(draw)
  }
  draw()
  const stream = c.captureStream(${fps})
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(stream.getVideoTracks())
})()`

const settingsFor = (codec, fps) =>
  `localStorage.setItem('beam.settings.v1', ${JSON.stringify(
    JSON.stringify({
      presetId: 'custom',
      mode: 'motion',
      maxHeight: 1080,
      fps: 30,
      bitrateScale: 1.3,
      budgetKbps: 20000,
      budgetAuto: false,
      maxViewers: 10,
      approve: false,
      codec: 'auto',
      shareSystemAudio: false,
    }),
  )}.replace('"fps":30', '"fps":${fps}').replace('"codec":"auto"', '"codec":"${codec}"'))`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Chrome reports processor seconds for every process it owns, which is exactly
 * the number wanted and needs no help from ps.
 */
async function cpuSeconds(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
  return processInfo.reduce((sum, p) => sum + (p.cpuTime ?? 0), 0)
}

async function coresUsed(cdp, ms) {
  const before = await cpuSeconds(cdp)
  const t0 = Date.now()
  await sleep(ms)
  const after = await cpuSeconds(cdp)
  return (after - before) / ((Date.now() - t0) / 1000)
}

console.log(`1920x1080 at ${FPS} fps, one viewer. Cores used by the host browser.\n`)
const rows = []

for (const codec of CODECS) {
  // The host gets its own browser, so only its work is measured.
  const hostBrowser = await chromium.launch({
    executablePath: CHROME,
    headless: process.env.HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream'],
  })
  const viewerBrowser = await chromium.launch({
    executablePath: CHROME,
    headless: process.env.HEADED !== '1',
  })
  const hostCdp = await hostBrowser.newBrowserCDPSession()

  const host = await (await hostBrowser.newContext()).newPage()
  await host.addInitScript(settingsFor(codec, FPS))
  await host.addInitScript(displayStub(FPS))
  await host.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await sleep(4000)

  // Baseline: the page is open and the canvas is animating, nothing is encoded.
  const idleCores = await coresUsed(hostCdp, 8000)

  await host.getByRole('button', { name: 'Choose what to share' }).click()
  const box = host.locator('input[aria-label="The link to share"]')
  await box.waitFor({ timeout: 15_000 })
  const link = await box.inputValue()

  const viewer = await (await viewerBrowser.newContext()).newPage()
  await viewer.goto(link, { waitUntil: 'domcontentloaded' })
  await viewer.getByRole('button', { name: 'Join the stream' }).click()

  await sleep(SETTLE_MS)
  const liveCores = await coresUsed(hostCdp, SAMPLE_MS)

  const shot = await host.evaluate(() => {
    const text = Array.from(document.querySelectorAll('.viewer-row .pill')).map(
      (p) => p.textContent ?? '',
    )
    return text.join(' ')
  })

  const row = { codec, idleCores, liveCores, encodeCores: liveCores - idleCores, shot }
  rows.push(row)
  console.log(
    `${codec.padEnd(5)} idle ${idleCores.toFixed(2)} → live ${liveCores.toFixed(2)} cores` +
      `   encoding costs ${row.encodeCores.toFixed(2)} cores   [${shot.trim()}]`,
  )

  await viewerBrowser.close()
  await hostBrowser.close()
}

const best = [...rows].sort((a, b) => a.encodeCores - b.encodeCores)[0]
console.log(`\nCheapest on the processor: ${best.codec}, ${best.encodeCores.toFixed(2)} cores.`)
console.log(
  'A codec that encodes on the GPU should sit far below the software ones. If they all\n' +
    'cluster together, this machine is encoding on the processor whatever the codec.',
)
