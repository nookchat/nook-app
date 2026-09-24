/**
 * Two people on two servers of one cluster, who can see and hear each other.
 *
 * Lines were always copied between servers; what is live was not, so Ada on
 * one server could read Ben on another and never see him arrive, or call him.
 *
 *   here       each sees the other in the list
 *   typing     what one is doing reaches the other
 *   voice      the two of them in the lounge hear each other
 *   leaving    a tab that closes on one server is gone on the other
 *   a server   one that stops takes everybody on it with it
 *
 *   node test/live-cluster-check.mjs
 */

import { chromium } from 'playwright-core'
import { startServer } from './pg.mjs'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const A = 'http://localhost:8805'
const B = 'http://localhost:8806'
const BOX = '[aria-label="Write a message"]'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms) {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    last = await fn().catch(() => null)
    if (last) return last
    await wait(300)
  }
  return null
}

const cluster = (self, peer) => ({ CATHODE_PUBLIC_URL: self, CATHODE_PEERS: peer, CATHODE_CLUSTER_SECRET: 'live-cluster-check-secret' })
const a = await startServer(8805, cluster(A, B))
const b = await startServer(8806, cluster(B, A))
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})

async function person(name, server) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await context.grantPermissions(['microphone'], { origin: new URL(APP_URL).origin })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate(
    ({ n, s }) => {
      localStorage.setItem('cathode.name.v1', n)
      localStorage.setItem('cathode.server.v1', s)
      localStorage.setItem('cathode.own.v1', JSON.stringify([s]))
      localStorage.setItem('cathode.servers.v1', JSON.stringify([s]))
      localStorage.setItem('cathode.clusters.v1', JSON.stringify({ [s]: [] }))
    },
    { n: name, s: server },
  )
  await page.reload()
  return page
}

const here = (page) => page.evaluate(() => [...document.querySelectorAll('.rail-person:not(.away)')].map((r) => r.querySelector('.truncate')?.textContent?.trim()))

const loudness = (page) =>
  page.evaluate(async () => {
    const sinks = [...document.querySelectorAll('audio.voice-sink')].filter((s) => s.srcObject)
    if (!sinks.length) return 0
    const ctx = new AudioContext()
    await ctx.resume()
    const an = ctx.createAnalyser()
    for (const s of sinks) ctx.createMediaStreamSource(s.srcObject).connect(an)
    const data = new Float32Array(an.fftSize)
    let peak = 0
    const end = performance.now() + 2000
    while (performance.now() < end) {
      an.getFloatTimeDomainData(data)
      for (const v of data) peak = Math.max(peak, Math.abs(v))
      await new Promise((r) => setTimeout(r, 50))
    }
    await ctx.close()
    return peak
  })

try {
  const ada = await person('Ada', A)
  await ada.waitForSelector('input[aria-label="Space name"]')
  await ada.fill('input[aria-label="Space name"]', 'split')
  await ada.click('button:has-text("New space")')
  await ada.waitForSelector(BOX)
  const code = new URL(ada.url()).hash.slice(1).split('@')[0]
  // Ben reaches the same space through the other server of the cluster.
  const ben = await person('Ben', B)
  await wait(2500)
  await ben.goto(`${APP_URL}#${code}@localhost:8806`)
  await ben.waitForSelector(BOX, { timeout: 20_000 })
  const onB = await ben.evaluate(() => document.querySelector('.status-bar')?.title ?? '')
  check('the two are on different servers', onB.includes('8806'), onB)

  const both = await waitFor(async () => {
    const [x, y] = [await here(ada), await here(ben)]
    return x.some((n) => n?.startsWith('Ben')) && y.some((n) => n?.startsWith('Ada')) ? `${x.join(', ')} | ${y.join(', ')}` : null
  }, 20_000)
  check('each sees the other as here, across the two servers', !!both, both ?? JSON.stringify([await here(ada), await here(ben)]))

  await ben.click(BOX)
  await ben.keyboard.type('typing across')
  const typing = await waitFor(() => ada.evaluate(() => {
    const line = document.querySelector('.chat-typing:not(.hidden)')
    return line?.textContent?.includes('Ben') ? line.textContent : null
  }), 10_000)
  check('and what one is doing reaches the other', !!typing, typing ?? 'not typing')
  await ben.keyboard.press('Enter')

  for (const page of [ada, ben]) {
    await page.click('.voice-channel .rail-item:has-text("lounge")')
    await page.waitForSelector('.voice-bar:not(.voice-dock):not(.hidden)', { timeout: 15_000 })
  }
  const heard = await waitFor(async () => ((await loudness(ada)) > 0.01 && (await loudness(ben)) > 0.01 ? true : null), 30_000)
  check('two people in the lounge on two servers hear each other', !!heard)

  // A third on B, and then B stops.
  const cat = await person('Cat', B)
  await cat.goto(`${APP_URL}#${code}@localhost:8806`)
  await cat.waitForSelector(BOX, { timeout: 20_000 })
  await waitFor(async () => ((await here(ada)).some((n) => n?.startsWith('Cat')) ? true : null), 20_000)

  await ben.context().close()
  const benGone = await waitFor(async () => (!(await here(ada)).some((n) => n?.startsWith('Ben')) ? true : null), 15_000)
  check('a tab closed on one server is gone on the other', !!benGone, (await here(ada)).join(', '))

  b.child.kill()
  const catGone = await waitFor(async () => (!(await here(ada)).some((n) => n?.startsWith('Cat')) ? true : null), 45_000)
  check('and a server that stops takes everybody on it with it', !!catGone, (await here(ada)).join(', '))
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
} finally {
  await browser.close()
  a.child.kill()
  b.child.kill()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
