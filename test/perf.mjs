import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { HOME, launch } from './harness.mjs'
import { sql, startServer } from './pg.mjs'

/**
 * How fast the page is, the same way every time, so a change can be held up against what came
 * before. It builds the app as it ships, fills a space with a long history, and times what people
 * do in it on a processor slowed four times, as a cheap laptop or a phone would be.
 *
 *   npm run perf                      this tree, against test/perf-baseline.json
 *   npm run perf -- --against main    this tree and main, built and run turn about
 *   npm run perf -- --save            this tree's numbers become the baseline
 *   npm run perf -- --profile         where the time goes: a CPU profile of each scene, unminified
 *   --rounds 5  --messages 2000  --cpu 4  --limit 10 (per cent a number may grow by)
 *
 * It ends with 1 when something is slower by more than the limit, so it can stand in a check.
 */

const ROOT = new URL('..', import.meta.url).pathname
const OUT = join(ROOT, 'test-output/perf')
const BASELINE = join(ROOT, 'test/perf-baseline.json')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const AGAINST = option('against', '')
const ROUNDS = Number(option('rounds', 5))
const MESSAGES = Number(option('messages', 2000))
const CPU = Number(option('cpu', 4))
const LIMIT = Number(option('limit', 10)) / 100
const SAVE = args.includes('--save')
/** One round, unminified, with the functions that took the most time in each scene. Saves no numbers. */
const PROFILE = args.includes('--profile')

const SERVER_PORT = 8797
const SEED_PORT = 5197
const PORTS = { now: 5198, then: 5199 }

/** What is timed, in the order it is shown. Less is better for every one. */
const METRICS = [
  { key: 'start', label: 'Home on screen', unit: 'ms', floor: 5 },
  { key: 'startJs', label: 'JS loaded for Home', unit: 'KB', floor: 1 },
  { key: 'startEmoji', label: 'Emoji pictures loaded for Home', unit: '', floor: 2 },
  { key: 'openCold', label: 'Open a big space, first time', unit: 'ms', floor: 5 },
  { key: 'openWarm', label: 'Open it again', unit: 'ms', floor: 5 },
  { key: 'switch', label: 'Switch channel', unit: 'ms', floor: 3 },
  { key: 'send', label: 'A sent message on screen', unit: 'ms', floor: 3 },
  { key: 'picker', label: 'Open the emoji picker, first time', unit: 'ms', floor: 3 },
  { key: 'drawCpu', label: 'Processor time per side bar draw', unit: 'ms', floor: 1 },
  { key: 'drawMade', label: 'Elements made anew per draw', unit: '', floor: 0.5 },
  { key: 'scroll', label: '40 frames of scrolling up', unit: 'ms', floor: 10 },
  { key: 'worstFrame', label: 'Longest frame in that scroll', unit: 'ms', floor: 5 },
  { key: 'heap', label: 'JS heap at the end', unit: 'MB', floor: 0.5 },
  { key: 'nodes', label: 'Elements on the page', unit: '', floor: 20 },
  { key: 'bundle', label: 'All JS in the build', unit: 'KB', floor: 1 },
]

const median = (xs) => {
  const sorted = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (sorted.length === 0) return Number.NaN
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function git(...rest) {
  return execFileSync('git', rest, { cwd: ROOT, encoding: 'utf8' }).trim()
}

async function until(url, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await wait(150)
  }
  throw new Error(`${url} did not answer`)
}

function vite(cwd, rest, env = {}) {
  return spawn('npx', ['vite', ...rest], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] })
}

function build(src, out, server) {
  const minify = PROFILE ? ['--minify', 'false'] : []
  execFileSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error', ...minify], {
    cwd: src,
    env: { ...process.env, VITE_NOOK_SERVER: server },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const assets = join(out, 'assets')
  const js = readdirSync(assets).filter((f) => f.endsWith('.js')).reduce((sum, f) => sum + statSync(join(assets, f)).size, 0)
  return js / 1024
}

/** The last message of #general, which a channel shows once it is drawn to its end. */
const lastGeneral = (() => {
  let i = MESSAGES - 1
  while (i % 3 === 0) i--
  return `Message number ${i},`
})()

/** A space with a long history, many channels and some voice channels. Made through the source, on its own page. */
async function seed(browser, server) {
  const seeder = vite(ROOT, ['--port', String(SEED_PORT), '--strictPort'], { VITE_NOOK_SERVER: server })
  try {
    await until(`http://localhost:${SEED_PORT}/`)
    const page = await browser.newPage()
    await page.goto(`http://localhost:${SEED_PORT}/`)
    await page.waitForSelector(HOME, { timeout: 60_000 })
    const link = await page.evaluate(async (count) => {
      const room = await import('/src/room.ts')
      const log = await import('/src/store/log.ts')
      const id = await import('/src/store/identity.ts')
      const { sealEvent } = await import('/src/net/server-api.ts')
      const { defaultServer } = await import('/src/backend.ts')
      const secret = room.newSecret()
      const r = await room.deriveRoom(secret)
      const me = id.loadIdentity().pubkey
      const events = []
      let lamport = Date.now() - count - 100
      const add = async (kind, body) => events.push(await log.makeEvent(r.id, me, lamport++, kind, body))
      await add('role', { subject: me, role: 'admin' })
      await add('space', { name: 'Heavy' })
      await add('channel', { name: 'other' })
      for (let i = 1; i <= 12; i++) await add('channel', { name: `room-${i}` })
      for (let i = 1; i <= 4; i++) await add('channel', { name: `voice-${i}`, voice: true })
      for (let i = 0; i < count; i++) {
        await add('said', {
          text: `Message number ${i}, with **some** words in it and a link https://example.org/${i}`,
          channel: i % 3 === 0 ? 'other' : 'general',
        })
      }
      const server = defaultServer()
      const lines = await Promise.all(events.map((e) => sealEvent(r.key, e)))
      for (let i = 0; i < lines.length; i += 300) {
        const res = await fetch(`${server}/api/v1/spaces/${r.id}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-nook-write': r.write },
          body: JSON.stringify(lines.slice(i, i + 300)),
        })
        if (!res.ok) throw new Error(`the server refused the seed: ${res.status}`)
      }
      return room.roomLink(secret, false, server)
    }, MESSAGES)
    await page.close()
    return link.slice(link.indexOf('#'))
  } finally {
    seeder.kill()
  }
}

/** Notes the time each thing first shows, from the page's own clock, so the waiting here adds nothing. */
const MARKS = (want) => `(() => {
  const marks = (window.__marks = {})
  const texts = document.getElementsByClassName('chat-text')
  const look = () => {
    if (!marks.home && document.querySelector(${JSON.stringify(HOME)})) marks.home = performance.now()
    if (texts.length && texts[texts.length - 1].textContent.includes(${JSON.stringify(want)})) {
      marks.chat = performance.now()
      return
    }
    requestAnimationFrame(look)
  }
  requestAnimationFrame(look)
})()`

/** Samples the processor through a scene, saves the profile, and prints where its time went. */
function profiler(cdp) {
  const split = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics')
    const of = (name) => (metrics.find((m) => m.name === name)?.value ?? 0) * 1000
    return { script: of('ScriptDuration'), style: of('RecalcStyleDuration'), layout: of('LayoutDuration') }
  }
  let before = null
  let traced = []
  cdp.on('Tracing.dataCollected', ({ value }) => traced.push(...value))
  return {
    async start() {
      traced = []
      // The time each CSS selector takes to match, as the Selector stats of DevTools show it.
      await cdp.send('Tracing.start', { categories: 'disabled-by-default-blink.debug', transferMode: 'ReportEvents' })
      before = await split()
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.send('Profiler.start')
    },
    async stop(scene) {
      const { profile } = await cdp.send('Profiler.stop')
      const after = await split()
      const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
      await cdp.send('Tracing.end')
      await done
      const selectors = new Map()
      for (const event of traced) {
        for (const t of event.args?.selector_stats?.selector_timings ?? []) {
          const held = selectors.get(t.selector) ?? { us: 0, tries: 0, matches: 0 }
          held.us += t['elapsed (us)'] ?? 0
          held.tries += t.match_attempts ?? 0
          held.matches += t.match_count ?? 0
          selectors.set(t.selector, held)
        }
      }
      const file = join(OUT, `${scene.replaceAll(' ', '-')}.cpuprofile`)
      writeFileSync(file, JSON.stringify(profile))
      const byId = new Map(profile.nodes.map((n) => [n.id, n]))
      const self = new Map()
      let total = 0
      profile.samples.forEach((id, i) => {
        const ms = (profile.timeDeltas[i] ?? 0) / 1000
        const { functionName, url, lineNumber } = byId.get(id).callFrame
        const name = `${functionName || '(anonymous)'}  ${url.split('/').pop()}:${lineNumber + 1}`
        if (functionName === '(idle)' || functionName === '(program)') return
        total += ms
        self.set(name, (self.get(name) ?? 0) + ms)
      })
      console.log(`\n${scene}: ${total.toFixed(0)} ms busy (slowed ${CPU}x), saved in ${file.slice(ROOT.length)}`)
      const part = (key) => `${(after[key] - before[key]).toFixed(0)} ms ${key}`
      console.log(`  ${part('script')}, ${part('style')}, ${part('layout')}`)
      for (const [name, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
        console.log(`  ${ms.toFixed(1).padStart(7)} ms  ${name}`)
      }
      if (selectors.size) console.log('  slowest CSS selectors:')
      for (const [selector, t] of [...selectors].sort((a, b) => b[1].us - a[1].us).slice(0, 12)) {
        console.log(`  ${(t.us / 1000).toFixed(1).padStart(7)} ms  ${String(t.tries).padStart(8)} tries ${String(t.matches).padStart(7)} hits  ${selector}`)
      }
    },
  }
}

/** One person's visit on one build: every scene once, in a browser of their own. */
async function visit(browser, origin, hash) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(MARKS(lastGeneral))
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  await cdp.send('Performance.enable')
  const busy = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics')
    const of = (name) => metrics.find((m) => m.name === name)?.value ?? 0
    return (of('ScriptDuration') + of('LayoutDuration') + of('RecalcStyleDuration')) * 1000
  }
  const frames = (n) => page.evaluate((count) => new Promise((done) => {
    let left = count
    const next = () => (--left <= 0 ? done() : requestAnimationFrame(next))
    requestAnimationFrame(next)
  }), n)
  const out = {}
  const profile = PROFILE ? profiler(cdp) : null
  try {
    await profile?.start()
    await page.goto(origin)
    await page.waitForFunction(() => window.__marks.home, null, { timeout: 60_000 })
    out.start = await page.evaluate(() => window.__marks.home)
    await profile?.stop('home')
    // What Home loads while nobody does anything, once it is idle.
    await wait(2500)
    out.startEmoji = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.name.includes('/emoji/')).length)
    out.startJs = await page.evaluate(
      () => performance.getEntriesByType('resource').filter((r) => r.name.endsWith('.js')).reduce((sum, r) => sum + r.encodedBodySize, 0) / 1024,
    )

    await page.goto('about:blank')
    await profile?.start()
    await page.goto(`${origin}${hash}`)
    await page.waitForFunction(() => window.__marks.chat, null, { timeout: 120_000 })
    out.openCold = await page.evaluate(() => window.__marks.chat)
    await profile?.stop('open a big space')
    await wait(1000)
    await page.reload()
    await page.waitForFunction(() => window.__marks.chat, null, { timeout: 120_000 })
    out.openWarm = await page.evaluate(() => window.__marks.chat)
    await wait(1500)

    await profile?.start()
    const switches = []
    for (let i = 0; i < 6; i++) {
      const name = i % 2 === 0 ? 'other' : 'general'
      switches.push(
        await page.evaluate(async (to) => {
          const button = [...document.querySelectorAll('.rail-left .rail-item')].find((b) => b.textContent.trim() === to)
          const start = performance.now()
          button.click()
          while (!document.querySelector('.channel-name')?.textContent.includes(to)) {
            if (performance.now() - start > 10_000) return Number.NaN
            await new Promise((r) => requestAnimationFrame(r))
          }
          // Painted: the frame after the one that drew it.
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
          return performance.now() - start
        }, name),
      )
    }
    out.switch = median(switches)
    await profile?.stop('switch channel')

    // Sent in a channel of their own, so #general ends with the same message on every visit.
    const open = (to) =>
      page.evaluate(async (name) => {
        ;[...document.querySelectorAll('.rail-left .rail-item')].find((b) => b.textContent.trim() === name).click()
        while (!document.querySelector('.channel-name')?.textContent.includes(name)) await new Promise((r) => requestAnimationFrame(r))
      }, to)
    await open('room-12')
    const sends = []
    for (let i = 0; i < 5; i++) {
      const words = `perf ${Date.now()} ${i}`
      await page.click('[aria-label="Write a message"]')
      await page.keyboard.type(words)
      sends.push(
        await page.evaluate(async (want) => {
          const box = document.querySelector('[aria-label="Write a message"]')
          const start = performance.now()
          box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          const texts = document.getElementsByClassName('chat-text')
          while (texts[texts.length - 1]?.textContent !== want) {
            if (performance.now() - start > 10_000) return Number.NaN
            await new Promise((r) => requestAnimationFrame(r))
          }
          return performance.now() - start
        }, words),
      )
    }
    out.send = median(sends)

    await profile?.start()
    out.picker = await page.evaluate(async () => {
      const start = performance.now()
      document.querySelector('.compose-box button[aria-label="Emoji"]').click()
      while (!document.querySelector('.emoji-pop .emoji-cell')) {
        if (performance.now() - start > 10_000) return Number.NaN
        await new Promise((r) => requestAnimationFrame(r))
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return performance.now() - start
    })
    await profile?.stop('emoji picker')
    await page.keyboard.press('Escape')
    await frames(5)
    await open('general')
    await wait(1000)

    // The side bars, drawn again as they are on every change in the space.
    const DRAWS = 60
    await profile?.start()
    const before = await busy()
    out.drawMade = await page.evaluate(async (n) => {
      let made = 0
      const watch = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) made++
      })
      watch.observe(document.body, { childList: true, subtree: true })
      for (let i = 0; i < n; i++) {
        window.dispatchEvent(new Event('nook:playing'))
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      }
      watch.disconnect()
      return made / n
    }, DRAWS)
    out.drawCpu = ((await busy()) - before) / DRAWS
    await profile?.stop('side bar draws')

    // Up through the history, a screen at a time, as fast as frames come.
    await page.evaluate(() => {
      const log = document.querySelector('.chat-log')
      log.scrollTop = log.scrollHeight
    })
    await frames(10)
    await profile?.start()
    const scrolled = await page.evaluate(async () => {
      const log = document.querySelector('.chat-log')
      let last = performance.now()
      let worst = 0
      const start = last
      for (let i = 0; i < 40; i++) {
        log.scrollTop -= 600
        await new Promise((r) => requestAnimationFrame(r))
        const now = performance.now()
        worst = Math.max(worst, now - last)
        last = now
      }
      return { total: last - start, worst }
    })
    out.scroll = scrolled.total
    out.worstFrame = scrolled.worst
    await profile?.stop('scroll up')

    await cdp.send('HeapProfiler.collectGarbage')
    out.heap = (await cdp.send('Runtime.getHeapUsage')).usedSize / 1e6
    out.nodes = await page.evaluate(() => document.getElementsByTagName('*').length)
    return out
  } finally {
    await context.close()
  }
}

function fmt(value, unit) {
  if (!Number.isFinite(value)) return '-'
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`
}

/** Each number against the one before it. Slower by more than the limit and the floor is worse. */
function compare(now, then, thenName) {
  const rows = [['What', thenName, 'Now', 'Change', '']]
  let worse = 0
  for (const m of METRICS) {
    const a = then?.[m.key]
    const b = now[m.key]
    let change = ''
    let verdict = ''
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const diff = b - a
      change = a === 0 ? (diff === 0 ? '0%' : 'new') : `${diff >= 0 ? '+' : ''}${((diff / a) * 100).toFixed(1)}%`
      const big = Math.abs(diff) > m.floor && (a === 0 || Math.abs(diff / a) > LIMIT)
      verdict = !big ? '' : diff > 0 ? 'WORSE' : 'better'
      if (verdict === 'WORSE') worse++
    }
    rows.push([m.label, fmt(a, m.unit), fmt(b, m.unit), change, verdict])
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  for (const [i, row] of rows.entries()) {
    console.log(row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join('   ').trimEnd())
    if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('   '))
  }
  return worse
}

mkdirSync(OUT, { recursive: true })
const children = []
let server = null
let worktree = ''
let browser = null
let failed = false
try {
  server = await startServer(SERVER_PORT)
  const builds = [{ name: 'now', src: ROOT }]
  if (AGAINST) {
    const sha = git('rev-parse', '--verify', `${AGAINST}^{commit}`)
    worktree = join(OUT, `src-${sha.slice(0, 8)}`)
    if (existsSync(worktree)) git('worktree', 'remove', '--force', worktree)
    git('worktree', 'add', '--detach', worktree, sha)
    symlinkSync(join(ROOT, 'node_modules'), join(worktree, 'node_modules'))
    builds.push({ name: 'then', src: worktree, label: `${AGAINST} (${sha.slice(0, 8)})` })
  }

  console.log(`building ${builds.map((b) => b.label ?? 'this tree').join(' and ')}`)
  for (const b of builds) {
    const dist = join(OUT, `dist-${b.name}`)
    b.bundle = build(b.src, dist, server.url)
    b.origin = `http://localhost:${PORTS[b.name]}/`
    const preview = vite(b.src, ['preview', '--outDir', dist, '--port', String(PORTS[b.name]), '--strictPort'])
    children.push(preview)
    await until(b.origin)
    b.runs = []
  }

  browser = await launch()
  console.log(`filling a space with ${MESSAGES} messages`)
  const hash = await seed(browser, server.url)

  // One round more than asked, first, to warm the disk and the browser: it is not counted.
  for (let round = 0; round <= ROUNDS; round++) {
    // Turn about, and the other way round each time, so a machine that slows down slows both.
    const order = round % 2 ? [...builds].reverse() : builds
    for (const b of order) {
      if (PROFILE && round < ROUNDS) continue
      const run = await visit(browser, b.origin, hash)
      if (round > 0) b.runs.push(run)
    }
    if (!PROFILE) console.log(round === 0 ? 'warmed up' : `round ${round} of ${ROUNDS}`)
  }

  if (PROFILE) {
    console.log('\nThe numbers from a profiled, unminified build are not kept.')
  } else {
    const summary = (b) => {
      const out = { bundle: b.bundle }
      for (const m of METRICS) if (m.key !== 'bundle') out[m.key] = median(b.runs.map((r) => r[m.key]))
      for (const key of Object.keys(out)) out[key] = Number(out[key].toFixed(2))
      return out
    }
    const now = summary(builds[0])
    const record = {
      commit: git('rev-parse', 'HEAD'),
      changed: git('status', '--porcelain', '--untracked-files=no') !== '',
      at: new Date().toISOString(),
      machine: cpus()[0]?.model ?? 'unknown',
      cpu: CPU,
      messages: MESSAGES,
      rounds: ROUNDS,
      metrics: now,
    }
    appendFileSync(join(OUT, 'history.jsonl'), `${JSON.stringify(record)}\n`)

    console.log('')
    console.log(`processor slowed ${CPU}x, ${MESSAGES} messages, median of ${ROUNDS} rounds`)
    let worse = 0
    if (AGAINST) {
      worse = compare(now, summary(builds[1]), builds[1].label)
    } else if (existsSync(BASELINE)) {
      const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
      if (base.machine !== record.machine || base.cpu !== CPU || base.messages !== MESSAGES) {
        console.log(`The baseline was taken on ${base.machine}, ${base.cpu}x, ${base.messages} messages: the times are not alike.`)
      }
      worse = compare(now, base.metrics, `baseline ${base.commit.slice(0, 8)}`)
    } else {
      compare(now, null, 'baseline')
      console.log('There is no baseline yet. Make one with --save.')
    }

    if (SAVE) {
      writeFileSync(BASELINE, `${JSON.stringify(record, null, 2)}\n`)
      console.log(`\nSaved as the baseline in test/perf-baseline.json.`)
    } else if (worse) {
      console.log(`\n${worse} slower by more than ${LIMIT * 100}%. Run it again to be sure: a busy machine is slower too.`)
      failed = true
    }
  }
} catch (err) {
  console.log(`The run stopped: ${err?.stack ?? err}`)
  failed = true
} finally {
  await browser?.close()
  for (const child of children) child.kill()
  server?.child.kill()
  // Its database goes too: the checks leave theirs, and they fill the disk.
  if (server) {
    await wait(300)
    const admin = server.database.replace(/\/[^/]+$/, '/nook')
    const name = server.database.slice(server.database.lastIndexOf('/') + 1)
    await sql(admin, `drop database if exists ${name} with (force)`).catch(() => {})
  }
  if (worktree) {
    try {
      git('worktree', 'remove', '--force', worktree)
    } catch {}
  }
  rmSync(join(OUT, 'dist-now'), { recursive: true, force: true })
  rmSync(join(OUT, 'dist-then'), { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
