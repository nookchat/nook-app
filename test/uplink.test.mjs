import { APP_URL, check, finish, launch, stoppedEarly } from './harness.mjs'

const hintCases = [
  { name: 'no connection API falls back to the default', conn: null, expect: 6000 },
  { name: 'data saver starts small', conn: { saveData: true, effectiveType: '4g' }, expect: 1500 },
  { name: '2g starts at the floor', conn: { effectiveType: '2g' }, expect: 800 },
  { name: '3g starts low', conn: { effectiveType: '3g' }, expect: 2500 },
  { name: 'cellular starts below the usual figure', conn: { effectiveType: '4g', type: 'cellular' }, expect: 4000 },
  {
    // Chrome reports a low downlink on a fresh page even on a fast link.
    name: 'an early low downlink reading is ignored',
    conn: { effectiveType: '4g', downlink: 1.45 },
    expect: 6000,
  },
]

const browser = await launch({ headless: true })
try {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })

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
    check(c.name, got === c.expect && seen === wanted, `${got} kb/s, wanted ${c.expect} (browser saw ${seen})`)
    await probe.close()
  }

  const results = await page.evaluate(async () => {
    const { UplinkMeter } = await import('/src/net/uplink.ts')
    const out = []
    const start = { kbps: 6000, source: 'browser-hint', note: 'start' }

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

    {
      const m = new UplinkMeter({ ...start })
      let now = 0
      for (let i = 0; i < 20; i++) {
        now += 2000
        m.observe({ demandKbps: 1200, sendingKbps: 1200, availableKbps: 40000, lossPct: 0 }, now)
      }
      out.push({ name: 'a small stream does not probe for headroom', ok: m.estimateKbps === 6000, value: m.estimateKbps })
    }

    {
      const m = new UplinkMeter({ ...start })
      const moved = m.observe({ demandKbps: 9000, sendingKbps: 0, availableKbps: 0, lossPct: 0 }, 1000)
      out.push({ name: 'no traffic changes nothing', ok: moved === false && m.source === 'browser-hint', value: m.source })
    }

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

  for (const r of results) check(r.name, r.ok, String(r.value))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
