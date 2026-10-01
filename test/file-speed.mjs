import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { setTimeout as wait } from 'node:timers/promises'
import { AUTOPLAY, launch } from './harness.mjs'
import { startServer } from './pg.mjs'

// How long a video takes to go up, to come down whole, to stream, to show its first frame
// and to jump to the middle, on this machine and over a slow line (a proxy that adds
// LATENCY_MS each way and holds the line to MBPS). Each figure is the median of RUNS.
//
//   node test/file-speed.mjs                 writes test-output/file-speed.json
//   node test/file-speed.mjs --compare A.json B.json

const RUNS = Number(process.env.RUNS ?? 3)
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 20)
const MBPS = Number(process.env.MBPS ?? 100)
const PAGE_PORT = 5197
const APP = `http://localhost:${PAGE_PORT}/`
const OUT = new URL('../test-output/', import.meta.url).pathname
const VIDEO = `${OUT}speed-1080p.mp4`

if (process.argv[2] === '--compare') {
  const [before, after] = process.argv.slice(3).map((f) => JSON.parse(readFileSync(f, 'utf8')))
  console.log(`${'what'.padEnd(34)}${'before'.padStart(10)}${'after'.padStart(10)}${'change'.padStart(10)}`)
  for (const key of Object.keys(before)) {
    const a = before[key]
    const b = after[key]
    if (typeof a !== 'number' || typeof b !== 'number') continue
    const change = a ? `${Math.round(((b - a) / a) * 100)}%` : ''
    console.log(`${key.padEnd(34)}${String(a).padStart(10)}${String(b).padStart(10)}${change.padStart(10)}`)
  }
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
if (!existsSync(VIDEO)) {
  // 30 seconds of 1080p at about 10 Mbit/s, with its index at the front, as a phone sends it.
  const made = spawnSync('ffmpeg', [
    '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '10M', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', '+faststart', '-y', VIDEO,
  ], { stdio: 'inherit' })
  if (made.status !== 0) throw new Error('ffmpeg could not make the test video.')
}
const videoBytes = readFileSync(VIDEO)

// The video, for the page to fetch.
const source = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('content-type', 'video/mp4')
  res.end(videoBytes)
}).listen(5198)

/** One line, shared by every request through it, LATENCY_MS each way and MBPS at most. */
function slowLine(port, target) {
  let free = 0
  const pace = async (bytes) => {
    const now = Date.now()
    free = Math.max(free, now) + (bytes * 8) / (MBPS * 1000)
    if (free - now > 2) await wait(free - now)
  }
  // A side that goes stops the other, as a server stops sending when its socket closes.
  const carry = async (from, to) => {
    for await (const chunk of from) {
      if (to.destroyed) break
      await pace(chunk.length)
      if (!to.write(chunk)) await new Promise((ok) => to.once('drain', ok))
    }
    to.end()
  }
  return createServer(async (req, res) => {
    // LOG_LINE=1 prints each request on the line: when it came, what it asked, and what went back.
    if (process.env.LOG_LINE) {
      const t = Date.now()
      let sent = 0
      const write = res.write.bind(res)
      res.write = (chunk, ...rest) => ((sent += chunk.length), write(chunk, ...rest))
      res.on('close', () => console.log(`  line ${t % 100000} ${req.method} ${req.headers.range} ${Math.round(sent / 1024)} KB in ${Date.now() - t} ms${res.writableFinished ? '' : ', let go'}`))
    }
    await wait(LATENCY_MS)
    const out = request(
      { host: 'localhost', port: target, path: req.url, method: req.method, headers: req.headers },
      async (back) => {
        res.on('close', () => back.destroy())
        await wait(LATENCY_MS)
        res.writeHead(back.statusCode ?? 502, back.headers)
        void carry(back, res).catch(() => res.destroy())
      },
    )
    out.on('error', () => res.destroy())
    void carry(req, out).catch(() => out.destroy())
  }).listen(port)
}

const vite = spawn('npx', ['vite', '--port', String(PAGE_PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((ok) => vite.stdout.on('data', (b) => /ready in|Local:/.test(String(b)) && ok()))

const local = await startServer(8851, { NOOK_PUBLIC_URL: 'http://localhost:8851' })
const behind = await startServer(8853, { NOOK_PUBLIC_URL: 'http://localhost:8854' })
const proxy = slowLine(8854, 8853)
const browser = await launch({ args: [AUTOPLAY] })

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.floor(s.length / 2)])
}

async function person(name, server) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const page = await context.newPage()
  await page.goto(APP)
  await page.evaluate(
    ({ n, server }) => {
      localStorage.setItem('nook.name.v1', n)
      localStorage.setItem('nook.server.v1', server)
      localStorage.setItem('nook.servers.v1', JSON.stringify([server]))
    },
    { n: name, server },
  )
  await page.reload()
  return page
}

const filesOf = `
  const { spaces } = await import('/src/space/registry.ts')
  const { filesFor } = await import('/src/space/runtime.ts')
  const files = filesFor(spaces.all()[0])
`

async function measure(label, server) {
  const sender = await person('Sender', server)
  await sender.waitForSelector('input[aria-label="Space name"]')
  await sender.fill('input[aria-label="Space name"]', 'speed')
  await sender.click('button:has-text("New space")')
  await sender.waitForSelector('button[aria-label="Attach files"]:not(.hidden)', { timeout: 20_000 })
  const reader = await person('Reader', server)
  await reader.goto(sender.url())
  await reader.waitForSelector('.space-name', { timeout: 20_000 })
  await reader.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10_000 }).catch(() => reader.reload())
  await reader.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10_000 })

  const send = () =>
    sender.evaluate(async (code) => {
      const run = new Function(`return (async () => { ${code}
        const bytes = await (await fetch('http://localhost:5198/v.mp4')).arrayBuffer()
        const file = new File([bytes], 'speed.mp4', { type: 'video/mp4' })
        const t = performance.now()
        const attachment = await files.send(file, () => undefined, new AbortController().signal)
        return { attachment, ms: performance.now() - t }
      })()`)
      return run()
    }, filesOf)

  const up = []
  const first = []
  const seek = []
  const stream = []
  const whole = []
  for (let i = 0; i < RUNS; i++) {
    const a = await send()
    const b = await send()
    const c = await send()
    up.push(a.ms, b.ms, c.ms)
    const played = await reader.evaluate(
      async ({ code, file }) =>
        new Function('file', `return (async () => { ${code}
          const url = files.streamUrl(file)
          if (!url) throw new Error('no stream')
          const video = document.createElement('video')
          video.muted = true
          document.body.append(video)
          const t = performance.now()
          video.src = url
          await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = () => fail(new Error('did not play')) })
          const first = performance.now() - t
          const s = performance.now()
          video.currentTime = video.duration * 0.6
          await new Promise((ok) => (video.onseeked = ok))
          const seek = performance.now() - s
          video.remove()
          return { first, seek }
        })()`)(file),
      { code: filesOf, file: a.attachment },
    )
    first.push(played.first)
    seek.push(played.seek)
    stream.push(
      await reader.evaluate(
        ({ code, file }) =>
          new Function('file', `return (async () => { ${code}
            const t = performance.now()
            const res = await fetch(files.streamUrl(file))
            const reader = res.body.getReader()
            let n = 0
            for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length }
            if (n !== file.size) throw new Error('streamed ' + n + ' of ' + file.size)
            return performance.now() - t
          })()`)(file),
        { code: filesOf, file: b.attachment },
      ),
    )
    whole.push(
      await reader.evaluate(
        ({ code, file }) =>
          new Function('file', `return (async () => { ${code}
            const t = performance.now()
            const blob = await files.open(file)
            if (blob.size !== file.size) throw new Error('opened ' + blob.size)
            return performance.now() - t
          })()`)(file),
        { code: filesOf, file: c.attachment },
      ),
    )
  }
  await sender.context().close()
  await reader.context().close()
  return {
    [`${label} upload ms`]: median(up),
    [`${label} first frame ms`]: median(first),
    [`${label} seek to 60% ms`]: median(seek),
    [`${label} stream all ms`]: median(stream),
    [`${label} open whole ms`]: median(whole),
  }
}

/** The ceiling: AES-GCM alone on the same bytes, in the page, one piece after another. */
async function cryptoOnly() {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP)
  const ms = await page.evaluate(async (size) => {
    const plain = crypto.getRandomValues(new Uint8Array(65536))
    const data = new Uint8Array(size)
    for (let at = 0; at < size; at += 65536) data.set(plain.subarray(0, Math.min(65536, size - at)), at)
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const iv = new Uint8Array(12)
    const piece = 256 * 1024
    const t = performance.now()
    const boxes = []
    for (let at = 0; at < size; at += piece) boxes.push(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data.subarray(at, at + piece)))
    const sealed = performance.now() - t
    const o = performance.now()
    for (const box of boxes) await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, box)
    return { sealed, opened: performance.now() - o }
  }, videoBytes.length)
  await page.context().close()
  return { 'AES-GCM seal only ms': Math.round(ms.sealed), 'AES-GCM open only ms': Math.round(ms.opened) }
}

const results = { 'video MB': Math.round(videoBytes.length / 1024 / 1024) }
try {
  Object.assign(results, await cryptoOnly())
  Object.assign(results, await measure('local', local.url))
  Object.assign(results, await measure(`${LATENCY_MS * 2}ms ${MBPS}Mbit`, 'http://localhost:8854'))
  for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(34)}${String(v).padStart(8)}`)
  const out = process.env.OUT ?? `${OUT}file-speed.json`
  writeFileSync(out, JSON.stringify(results, null, 2))
  console.log(`\nwritten to ${out}`)
} finally {
  await browser.close()
  local.child.kill()
  behind.child.kill()
  proxy.close()
  source.close()
  vite.kill()
}
process.exit(0)
