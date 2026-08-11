/**
 * Checks the uplink estimator against made up statistics.
 *
 * The point is the behaviour, not the numbers: loss must pull the budget down,
 * spare capacity must only lift it while the encoders actually want more, and
 * neither must run away.
 *
 *   node test/uplink.mjs
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await (await browser.newContext()).newPage()
await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })

// The starting figure, against the connection hints a browser really reports.
const hintCases = [
  { name: 'no connection API falls back to the default', conn: null, expect: 6000 },
  { name: 'data saver starts small', conn: { saveData: true, effectiveType: '4g' }, expect: 1500 },
  { name: '2g starts at the floor', conn: { effectiveType: '2g' }, expect: 800 },
  { name: '3g starts low', conn: { effectiveType: '3g' }, expect: 2500 },
  { name: 'cellular starts below the usual figure', conn: { effectiveType: '4g', type: 'cellular' }, expect: 4000 },
  {
    // Chrome reports a low downlink on a fresh page even on a fast link. That
    // reading must not drag the budget down.
    name: 'an early low downlink reading is ignored',
    conn: { effectiveType: '4g', downlink: 1.45 },
    expect: 6000,
  },
]

const hintResults = []
for (const c of hintCases) {
  const probe = await (await browser.newContext()).newPage()
  await probe.addInitScript(`(() => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      get: () => ${c.conn === null ? 'undefined' : '(' + JSON.stringify(c.conn) + ')'},
    })
  })()`)
  await probe.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  const got = await probe.evaluate(async () => {
    const { initialUplink } = await import('/src/net/uplink.ts')
    return initialUplink().kbps
  })
  // Prove the override landed, or the case would pass for the wrong reason.
  const seen = await probe.evaluate(() => navigator.connection?.effectiveType ?? 'none')
  const wanted = c.conn?.effectiveType ?? 'none'
  hintResults.push({
    name: c.name,
    ok: got === c.expect && seen === wanted,
    value: `${got} kb/s, wanted ${c.expect} (browser saw ${seen})`,
  })
  await probe.close()
}

const results = await page.evaluate(async () => {
  const { UplinkMeter } = await import('/src/net/uplink.ts')
  const out = []
  const start = { kbps: 6000, source: 'browser-hint', note: 'start' }

  // Packet loss must pull the budget down towards what is actually sending.
  {
    const m = new UplinkMeter({ ...start })
    let now = 0
    for (let i = 0; i < 6; i++) {
      now += 2000
      m.observe({ demandKbps: 8000, sendingKbps: 5000, availableKbps: 5200, lossPct: 6 }, now)
    }
    out.push({ name: 'loss lowers the budget', ok: m.estimateKbps < 5000, value: m.estimateKbps })
    out.push({ name: 'loss marks it measured', ok: m.source === 'measured', value: m.source })
  }

  // Spare capacity lifts the budget, but only while the encoders want it.
  {
    const m = new UplinkMeter({ ...start })
    let now = 0
    for (let i = 0; i < 20; i++) {
      now += 2000
      m.observe({ demandKbps: 20000, sendingKbps: 6000, availableKbps: 18000, lossPct: 0.1 }, now)
    }
    out.push({ name: 'headroom lifts the budget', ok: m.estimateKbps > 9000, value: m.estimateKbps })
    out.push({ name: 'the lift stops at what is available', ok: m.estimateKbps <= 18000, value: m.estimateKbps })
  }

  // A small demand must not make Cathode go hunting for bandwidth it cannot use.
  {
    const m = new UplinkMeter({ ...start })
    let now = 0
    for (let i = 0; i < 20; i++) {
      now += 2000
      m.observe({ demandKbps: 1200, sendingKbps: 1200, availableKbps: 40000, lossPct: 0 }, now)
    }
    out.push({ name: 'a small stream does not probe for headroom', ok: m.estimateKbps === 6000, value: m.estimateKbps })
  }

  // Nothing flowing means nothing to learn.
  {
    const m = new UplinkMeter({ ...start })
    const moved = m.observe({ demandKbps: 9000, sendingKbps: 0, availableKbps: 0, lossPct: 0 }, 1000)
    out.push({ name: 'no traffic changes nothing', ok: moved === false && m.source === 'browser-hint', value: m.source })
  }

  // The floor and the ceiling both hold.
  {
    const m = new UplinkMeter({ ...start })
    let now = 0
    for (let i = 0; i < 40; i++) {
      now += 2000
      m.observe({ demandKbps: 200, sendingKbps: 100, availableKbps: 100, lossPct: 40 }, now)
    }
    out.push({ name: 'the budget never falls below the floor', ok: m.estimateKbps >= 800, value: m.estimateKbps })

    const big = new UplinkMeter({ ...start })
    now = 0
    for (let i = 0; i < 60; i++) {
      now += 2000
      big.observe({ demandKbps: 999000, sendingKbps: 50000, availableKbps: 999000, lossPct: 0 }, now)
    }
    out.push({ name: 'the budget never passes the ceiling', ok: big.estimateKbps <= 25000, value: big.estimateKbps })
  }

  return out
})

let failed = 0
for (const r of [...hintResults, ...results]) {
  if (!r.ok) failed++
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  — ${r.value}`)
}
const total = hintResults.length + results.length
console.log(`\n${total - failed} of ${total} checks passed.`)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
