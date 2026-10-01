import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { FAKE_MEDIA, answer, check, finish, launch, poll, stoppedEarly } from './harness.mjs'
import { startServer } from './pg.mjs'

// The built page, served with the headers vercel.json gives it, CSP and all: nothing the app
// does may break the policy. The other checks run on the dev server, which sends no policy.

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const PAGE_PORT = 5191
const SERVER_PORT = 8841
const BOX = '[aria-label="Write a message"]'

const built = spawnSync('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: ROOT, stdio: 'inherit' })
if (built.status !== 0) throw new Error('The page did not build.')

const rules = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')).headers.map((rule) => ({
  test: new RegExp(`^${rule.source}$`),
  headers: rule.headers,
}))
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }

const page = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0])
  let file = join(DIST, path === '/' ? 'index.html' : path)
  if (!file.startsWith(DIST) || !existsSync(file)) file = join(DIST, 'index.html')
  for (const rule of rules) if (rule.test.test(path)) for (const { key, value } of rule.headers) res.setHeader(key, value)
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream')
  res.end(readFileSync(file))
}).listen(PAGE_PORT)
const APP = `http://localhost:${PAGE_PORT}/`

const server = await startServer(SERVER_PORT)
const SERVER = `http://localhost:${SERVER_PORT}`
const browser = await launch({ args: FAKE_MEDIA })

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  // Every breach of the policy, as the page reports it.
  await context.addInitScript(() => {
    window.__breaches = []
    document.addEventListener('securitypolicyviolation', (e) => window.__breaches.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  const p = await context.newPage()
  await p.goto(APP)
  await p.evaluate(
    ({ n, server }) => {
      localStorage.setItem('nook.name.v1', n)
      localStorage.setItem('nook.server.v1', server)
      localStorage.setItem('nook.servers.v1', JSON.stringify([server]))
    },
    { n: name, server: SERVER },
  )
  await p.reload()
  return p
}

const breaches = (p) => p.evaluate(() => window.__breaches)

try {
  const alice = await person('Alice')
  const policy = await alice.evaluate(async () => (await fetch('/')).headers.get('content-security-policy'))
  check('the page goes out with a policy', /script-src 'self'/.test(policy ?? ''), policy ?? 'none')

  await alice.waitForSelector('input[aria-label="Space name"]')
  await alice.fill('input[aria-label="Space name"]', 'policy')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  // More than a worker's worth, so whoever joins checks them on the worker pool.
  for (let i = 1; i <= 60; i++) {
    await alice.fill(BOX, `line ${i}`)
    await alice.press(BOX, 'Enter')
  }
  await alice.waitForSelector('text=line 60')
  const link = alice.url()

  const bob = await person('Bob')
  await bob.goto(link)
  const seen = await poll(() => bob.locator('text=line 60').count(), 30_000)
  check('a newcomer opens sixty lines, checked on the workers', seen > 0)

  await alice.click('.voice-channel .rail-item:has-text("lounge")')
  const inVoice = await poll(() => alice.locator('.voice-bar:not(.hidden)').count(), 15_000)
  check('voice starts, with the noise filter', inVoice > 0)

  const svgRan = await alice.evaluate(async () => {
    const url = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>localStorage.setItem("svg-ran", "1")</script></svg>'], { type: 'image/svg+xml' }))
    const tab = window.open(url)
    await new Promise((done) => setTimeout(done, 1000))
    tab?.close()
    return { opened: !!tab, ran: localStorage.getItem('svg-ran') }
  })
  // With no policy it runs, as this page's origin: see test/hostile.test.mjs for why SVG is not a picture.
  check('script in an SVG opened from a blob does not run', svgRan.opened && svgRan.ran === null, JSON.stringify(svgRan))

  // A whiteboard loads tldraw, and its fonts from this page, not from another site.
  const fonts = []
  alice.on('request', (r) => r.url().includes('.woff2') && fonts.push(r.url()))
  await alice.click('button[aria-label="Make a whiteboard"]')
  await answer(alice, 'Sketch')
  await alice.waitForSelector('.whiteboard-view:not(.hidden) .tl-canvas', { timeout: 20_000 })
  const canvas = await alice.locator('.whiteboard-host .tl-canvas').boundingBox()
  await alice.mouse.click(canvas.x + 40, canvas.y + canvas.height / 2)
  await alice.keyboard.press('t')
  await alice.mouse.click(canvas.x + 300, canvas.y + 200)
  await alice.keyboard.type('Hello')
  await alice.keyboard.press('Escape')
  const fontsHere = await poll(() => fonts.length > 0 && fonts.every((url) => url.startsWith(APP)), 10_000)
  check('a whiteboard opens, and takes its fonts from this page', fontsHere, fonts.join(' | '))

  const found = [...(await breaches(alice)), ...(await breaches(bob))]
  check('nothing the app does breaks the policy', found.length === 0, found.join(' | '))

  // The worker sends every other address to the app: this page must come as itself.
  const kept = await alice.evaluate(() => !!navigator.serviceWorker.controller)
  await alice.goto(`${APP}how-it-works.html`)
  const howItWorks = await alice.evaluate(() => ({
    title: document.title,
    themed: document.querySelector('meta[name="theme-color"]')?.content,
    app: !!document.querySelector('#app, .space-name, input[aria-label="Space name"]'),
  }))
  check(
    'How Nook works opens as its own page, through the worker, with its theme',
    kept && howItWorks.title === 'How Nook works' && !howItWorks.app && /^#/.test(howItWorks.themed ?? ''),
    JSON.stringify(howItWorks),
  )
  const pageBreaches = await breaches(alice)
  check('and breaks no policy', pageBreaches.length === 0, pageBreaches.join(' | '))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  server.child.kill()
  page.close()
  finish()
}
