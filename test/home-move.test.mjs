import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webkit } from 'playwright-core'
import { APP_URL, check, finish, launch, makeSpace, stoppedEarly, wait } from './harness.mjs'

// The home site moved from cathode.video to nookchat.app (public/boot-move.js, public/move.js).
// Chrome opens the page under both names here, as two sites, each with its own storage, so an
// account kept on the old one is brought to the new one, once, with nothing to click. Chrome
// takes .app only over HTTPS, so a proxy with a certificate made here stands in front of Vite.
// MOVE_ENGINE=webkit runs it in WebKit, Safari's engine, which cannot map a name to this computer:
// there each request for the two names is answered from Vite by the check itself. WebKit lets no
// HTTPS page call the server on http://localhost, so there it checks storage and addresses only.

const dir = mkdtempSync(join(tmpdir(), 'nook-move-'))
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=nook-test',
  '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
const page5173 = new URL(APP_URL)
const proxy = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
  const out = request({ host: page5173.hostname, port: page5173.port, path: req.url, method: req.method, headers: req.headers }, (back) => {
    res.writeHead(back.statusCode ?? 502, back.headers)
    back.pipe(res)
  })
  out.on('error', () => res.destroy())
  req.pipe(out)
})
await new Promise((done) => proxy.listen(0, '127.0.0.1', done))
const port = proxy.address().port

const NEW = `https://www.nookchat.app:${port}/`
const OLD = `https://www.cathode.video:${port}/`

const WEBKIT = process.env.MOVE_ENGINE === 'webkit'
const browser = WEBKIT
  ? await webkit.launch()
  : await launch({
      named: false,
      args: ['--host-resolver-rules=MAP www.nookchat.app 127.0.0.1, MAP www.cathode.video 127.0.0.1', '--ignore-certificate-errors'],
    })
/** Home, or the space the account was last in. */
const OPEN = '.space-name, button.new-space'
/** Vite's answer to a request for one of the two names, as the proxy gives it. Asked again once if it hangs. */
const fromVite = (url, method, headers, again = true) =>
  new Promise((done, fail) => {
    const out = request(
      { host: page5173.hostname, port: page5173.port, path: url.pathname + url.search, method, headers: { ...headers, host: url.host }, agent: false },
      (back) => {
        const parts = []
        back.on('data', (part) => parts.push(part))
        back.on('end', () => done({ status: back.statusCode ?? 502, headers: back.headers, body: Buffer.concat(parts) }))
        back.on('error', fail)
      },
    )
    out.setTimeout(8000, () => {
      out.destroy()
      if (process.env.MOVE_DEBUG) console.log('hung', url.href)
      if (again) fromVite(url, method, headers, false).then(done, fail)
      else fail(new Error('Vite did not answer'))
    })
    out.on('error', (err) => !out.destroyed && fail(err))
    out.end()
  })

/** Waits for the page to settle: for the screen in Chrome, for what storage says in WebKit. */
async function settled(page, screen, storage, arg) {
  if (!WEBKIT) return page.waitForSelector(screen, { timeout: 20_000 })
  await page.waitForFunction(storage, arg, { timeout: 20_000 })
  await page.waitForLoadState('load')
}
// The old site has the same key: only the new one, loaded, counts.
const hasKey = (key) => location.host.startsWith('www.nookchat.app') && document.readyState === 'complete' && localStorage.getItem('nook.identity.v1') === key
const tripDone = () => location.host.startsWith('www.nookchat.app') && document.readyState === 'complete' && localStorage.getItem('nook.moved.v1') === 'done'
const WELCOME = 'button:has-text("I have an account")'

async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, ignoreHTTPSErrors: true })
  if (WEBKIT) {
    await context.route(/^https:\/\/www\.(nookchat\.app|cathode\.video):\d+\//, async (route) => {
      const req = route.request()
      const asked = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => !k.startsWith(':')))
      const began = Date.now()
      const got = await fromVite(new URL(req.url()), req.method(), asked).catch((err) => {
        console.log('not answered:', req.url(), err.message)
        return null
      })
      if (process.env.MOVE_DEBUG && Date.now() - began > 2000) console.log('slow', Date.now() - began, req.url())
      if (!got) return route.abort()
      const headers = Object.fromEntries(
        Object.entries(got.headers)
          .filter(([k]) => k !== 'transfer-encoding' && k !== 'content-length' && k !== 'connection')
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
      )
      await route.fulfill({ status: got.status, headers, body: got.body }).catch((err) => process.env.MOVE_DEBUG && console.log('fulfil failed', req.url(), err.message.split('\n')[0]))
    })
  }
  return context
}

/** What Nook keeps in a page's storage. */
const kept = (page) =>
  page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('nook.')).map((k) => [k, localStorage.getItem(k)])))

/** Puts an account in the old site's storage, as somebody who used Nook there before the move has it. */
async function onOldSite(context, account) {
  const page = await context.newPage()
  // A file with no script, so the page does not send the tab on to the new site first.
  await page.goto(`${OLD}manifest.webmanifest`)
  await page.evaluate((all) => {
    for (const [k, v] of Object.entries(all)) localStorage.setItem(k, v)
  }, account)
  await page.close()
}

const spaceNames = (page) =>
  page
    .waitForFunction(() => {
      const rows = [...document.querySelectorAll('.space-row .space-row-name')].map((e) => e.textContent)
      return rows.length ? rows : null
    }, null, { timeout: 20_000 })
    .then((h) => h.jsonValue())
    .catch(() => [])

try {
  // Somebody with an account and a space, made where the page is now.
  const maker = await (await fresh()).newPage()
  await maker.goto(APP_URL)
  await maker.click('.welcome-step:not(.hidden) button.primary')
  await maker.click('.tour-skip')
  await maker.fill('input[aria-label="Your name"]', 'Mo')
  await maker.keyboard.press('Enter')
  await makeSpace(maker, 'old home')
  await maker.waitForSelector('.space-name', { timeout: 15_000 })
  const invite = new URL(maker.url()).hash
  await wait(1500)
  const account = await kept(maker)
  check('a made account is a key and a name in storage', /^[0-9a-f]{64}$/.test(account['nook.identity.v1'] ?? '') && account['nook.name.v1'] === 'Mo')

  // 1. The new site, in a browser that used the old one: the account comes over, with no welcome.
  const one = await fresh()
  await onOldSite(one, account)
  const page = await one.newPage()
  const trips = []
  page.on('request', (req) => req.isNavigationRequest() && trips.push(new URL(req.url()).host))
  if (process.env.MOVE_DEBUG) page.on('console', (m) => m.type() === 'error' && console.log('console', m.text().slice(0, 160)))
  await page.goto(NEW)
  await settled(page, OPEN, hasKey, account['nook.identity.v1'])
  const moved = await kept(page)
  check('the new site takes the account from the old one: the same key and name', moved['nook.identity.v1'] === account['nook.identity.v1'] && moved['nook.name.v1'] === 'Mo', JSON.stringify({ name: moved['nook.name.v1'] }))
  check('it went to the old site and back once', trips.filter((h) => h.startsWith('www.cathode.video')).length === 1, trips.join(' → '))
  if (!WEBKIT) check('and asked for no name: no welcome', (await page.$('.welcome')) === null)
  if (!WEBKIT) {
    check('it opens where the old site was last: the space', (await page.textContent('.space-name')) === 'old home')
    await page.goto(NEW)
    await page.click('button[aria-label="Switch space"]')
    await page.click('.menu.switcher .menu-item:has-text("Home")')
    const names = await spaceNames(page)
    check('with the spaces of the account', names.includes('old home'), names.join(', '))
  }
  check('and left no code in the address', !page.url().includes('moved=') && !page.url().includes('to='), page.url())
  trips.length = 0
  await page.reload()
  await settled(page, OPEN, hasKey, account['nook.identity.v1'])
  check('a reload stays on the new site', !trips.some((h) => h.startsWith('www.cathode.video')), trips.join(' → '))

  // 2. A browser that never used the old site goes there once, comes back with nothing, and is welcomed.
  const two = await (await fresh()).newPage()
  const twoTrips = []
  two.on('request', (req) => req.isNavigationRequest() && twoTrips.push(new URL(req.url()).host))
  await two.goto(NEW)
  await settled(two, WELCOME, tripDone)
  check('a browser new to both sites gets the welcome', true, twoTrips.join(' → '))
  twoTrips.length = 0
  await two.reload()
  await settled(two, WELCOME, tripDone)
  await wait(500)
  check('and never goes to the old site again', !twoTrips.some((h) => h.startsWith('www.cathode.video')), twoTrips.join(' → '))

  // 3. An invite to the new site, in a browser with the old account: it opens as that account.
  const three = await fresh()
  await onOldSite(three, account)
  const invited = await three.newPage()
  await invited.goto(NEW + invite)
  if (WEBKIT) {
    // The page starts with the code in its address: it is the key that says the trip is over.
    await invited.waitForFunction(hasKey, account['nook.identity.v1'], { timeout: 20_000 }).catch(() => undefined)
    await invited.waitForLoadState('load')
    const asThree = await kept(invited)
    check('an invite keeps its code through the trip, as the old account', asThree['nook.identity.v1'] === account['nook.identity.v1'] && new URL(invited.url()).hash === invite, invited.url())
  } else {
    await invited.waitForSelector('.space-name', { timeout: 20_000 })
    const asThree = await kept(invited)
    check('an invite keeps its code through the trip, and opens the space as the old account', asThree['nook.identity.v1'] === account['nook.identity.v1'] && (await invited.textContent('.space-name')) === 'old home')
  }

  // 4. An old link in a tab goes on to the same place on the new site, and brings the account.
  const four = await fresh()
  await onOldSite(four, account)
  const oldLink = await four.newPage()
  await oldLink.goto(OLD + invite)
  if (WEBKIT) await oldLink.waitForFunction(hasKey, account['nook.identity.v1'], { timeout: 20_000 }).catch(() => undefined)
  else await oldLink.waitForSelector('.space-name', { timeout: 20_000 })
  check('an old link opens on the new site, with its code, as the old account', new URL(oldLink.url()).host.startsWith('www.nookchat.app') && (await kept(oldLink))['nook.identity.v1'] === account['nook.identity.v1'], oldLink.url())

  // 5. A made-up answer that this page did not ask for is ignored.
  const five = await (await fresh()).newPage()
  await five.goto(`${NEW}#moved=AAAA.BBBB.CCCC`)
  await settled(five, WELCOME, () => !location.hash.includes('moved='))
  const forged = await kept(five)
  const chosen = forged['nook.name.v1'] && forged['nook.name.v1'] !== forged['nook.name.auto.v1']
  check('an answer this page did not ask for is thrown away: still welcomed, with no name', !chosen && !five.url().includes('moved='), five.url())

  // 7. A browser that kept a lot on the old site still brings the account: the address stays short.
  const seven = await fresh()
  await onOldSite(seven, { ...account, 'nook.gifstars.v1': 'x'.repeat(150_000), 'nook.emoji.v1': 'y'.repeat(250_000) })
  const big = await seven.newPage()
  await big.goto(NEW)
  await settled(big, OPEN, hasKey, account['nook.identity.v1'])
  const bigKept = await kept(big)
  const tooBig = Object.entries(bigKept).filter(([, v]) => (v ?? '').length > 100_000).map(([k]) => k)
  check('with a lot kept on the old site, the account still comes, and what is too big stays behind', bigKept['nook.identity.v1'] === account['nook.identity.v1'] && bigKept['nook.name.v1'] === 'Mo' && tooBig.length === 0, JSON.stringify(tooBig))

  // 8. A trip that never came back, as on a network that failed, is made again, but not for ever.
  const setNew = async (context, value) => {
    const page = await context.newPage()
    await page.goto(`${NEW}manifest.webmanifest`)
    await page.evaluate((v) => localStorage.setItem('nook.moved.v1', v), value)
    await page.close()
  }
  const eight = await fresh()
  await onOldSite(eight, account)
  await setNew(eight, 'tried:1')
  const again = await eight.newPage()
  await again.goto(NEW)
  await again.waitForFunction(hasKey, account['nook.identity.v1'], { timeout: 20_000 }).catch(() => undefined)
  check('after a trip that failed, the next visit goes again, and brings the account', (await kept(again))['nook.identity.v1'] === account['nook.identity.v1'])
  const nine = await fresh()
  await onOldSite(nine, account)
  await setNew(nine, 'tried:3')
  const tired = await nine.newPage()
  const tiredTrips = []
  tired.on('request', (req) => req.isNavigationRequest() && tiredTrips.push(new URL(req.url()).host))
  await tired.goto(NEW)
  await settled(tired, WELCOME, () => document.readyState === 'complete')
  await wait(1000)
  check('after three that failed, it goes no more', !tiredTrips.some((h) => h.startsWith('www.cathode.video')), tiredTrips.join(' → '))

  // 6. The desktop app stays on the old site, where its account is.
  const six = await fresh()
  await six.addInitScript(() => {
    if (location.host.startsWith('www.cathode.video')) window.nookDesktop = { platform: 'darwin' }
  })
  await onOldSite(six, account)
  const desk = await six.newPage()
  await desk.goto(OLD)
  await settled(desk, OPEN, () => document.readyState === 'complete')
  await wait(1000)
  check('the desktop app stays on the old site', new URL(desk.url()).host.startsWith('www.cathode.video'), desk.url())
} catch (err) {
  if (process.env.MOVE_DEBUG) {
    for (const context of browser.contexts()) {
      for (const open of context.pages()) {
        const words = await open.evaluate(() => document.body?.innerText.slice(0, 120) ?? '').catch(() => '?')
        console.log('page', open.url(), JSON.stringify(words))
      }
    }
  }
  stoppedEarly(err)
} finally {
  await browser.close()
  proxy.close()
}

finish()
