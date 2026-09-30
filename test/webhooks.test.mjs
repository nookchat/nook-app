import { spawn } from 'node:child_process'
import { check, finish, launch, openSpaceSettings, poll, stoppedEarly, wait } from './harness.mjs'
import { startServer } from './pg.mjs'

// Webhooks, as Discord has them: a link made in the space settings, that another app posts to.
// What it posts shows in its channel for everybody, under the name it gives, with its embeds.
// Removing somebody stops it, and a new link starts it again.

const PORT = 8797
const PAGE_PORT = 5182
const APP_URL = `http://localhost:${PAGE_PORT}/`

const server = await startServer(PORT)
const vite = spawn('npx', ['vite', '--port', String(PAGE_PORT), '--strictPort'], {
  env: { ...process.env, VITE_NOOK_SERVER: server.url },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
await new Promise((ready, fail) => {
  const late = setTimeout(() => fail(new Error('Vite did not start')), 30_000)
  vite.stdout.on('data', (b) => {
    if (!/ready in/.test(String(b))) return
    clearTimeout(late)
    ready()
  })
})

const browser = await launch()
const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const send = (url, body, type = 'application/json') =>
  fetch(url, { method: 'POST', headers: { 'content-type': type }, body: type === 'application/json' ? JSON.stringify(body) : body })
const lines = (page, text) => page.locator(`.chat-line:has-text("${text}")`).count()

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'Hooks')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  await wait(1000)

  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await wait(1500)

  // A webhook, made in the space settings. Its link is copied at once.
  await openSpaceSettings(alice, 'webhooks')
  const rules = await alice.locator('.hook-rules').first().textContent()
  check('the page says that removing somebody stops every webhook', /Removing or banning somebody stops every webhook/.test(rules))
  check('and that joining or leaving changes nothing', (await alice.locator('.hook-rules').first().textContent()).includes('join the space, or leave it by themselves'))
  await alice.fill('.hook-name', 'CI')
  await alice.click('button:has-text("New webhook")')
  await alice.waitForSelector('.hook-row')
  const url = await alice.evaluate(() => navigator.clipboard.readText())
  check('a new webhook copies its link', /\/api\/webhooks\/[1-9][0-9]{17}\/[A-Za-z0-9_-]{150,}$/.test(url), url.slice(0, 60))
  await alice.screenshot({ path: 'test-output/webhooks-settings.png' })
  await alice.click('.settings-close')
  await alice.waitForSelector(BOX)

  // Posted as Discord takes it, with ?wait=true for the message back.
  const posted = await send(`${url}?wait=true`, {
    content: 'Build passed on **main**',
    username: 'GitHub',
    embeds: [{ title: 'Run 42', description: 'All green', color: 0x2ecc71, fields: [{ name: 'Tests', value: '40', inline: true }] }],
  })
  const message = await posted.json()
  check('a post with wait=true answers with the message', posted.status === 200 && /^[0-9a-f]{64}$/.test(message.id), `${posted.status} ${JSON.stringify(message).slice(0, 80)}`)
  check('in the webhook’s channel, from a bot', message.channel_id === 'general' && message.author?.bot === true && message.webhook_id === url.split('/').at(-2))

  const shown = await poll(async () => (await lines(alice, 'Build passed')) === 1, 15_000)
  check('it shows in the channel', shown)
  const row = alice.locator('.chat-line:has-text("Build passed")')
  check('under the name it gave, marked as a webhook', (await row.locator('.chat-name').textContent()) === 'GitHub' && (await row.locator('.chat-hook-mark').count()) === 1)
  check('with its embed', (await row.locator('.embed-card .link-card-title').textContent()) === 'Run 42' && (await row.locator('.embed-field-name').textContent()) === 'Tests')
  check('and its words formatted', (await row.locator('.chat-text strong').count()) === 1)
  await alice.screenshot({ path: 'test-output/webhooks-message.png' })
  check('everybody in the space sees it', await poll(async () => (await lines(bob, 'Build passed')) === 1, 15_000))
  await openSpaceSettings(alice, 'members')
  const members = await alice.locator('.member-row').allTextContents()
  check('a webhook is not a member', members.length === 2 && !members.some((m) => m.includes('GitHub')), members.join(' | '))
  await alice.click('.settings-close')
  await alice.waitForSelector(BOX)

  // Without wait, and as a form: both are what Discord takes.
  const plain = await send(url, { content: 'quiet one' })
  check('a post without wait answers 204', plain.status === 204, String(plain.status))
  const form = await send(url, 'content=from+a+form', 'application/x-www-form-urlencoded')
  check('a form post works too', form.status === 204 && (await poll(async () => (await lines(alice, 'from a form')) === 1, 10_000)))

  // Changed, as Discord's PATCH does.
  const edited = await fetch(`${url}/messages/${message.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'Build fixed on main' }),
  })
  check('the webhook can change what it posted', edited.status === 200 && (await poll(async () => (await lines(alice, 'Build fixed')) === 1, 10_000)))

  // Mistakes answer as Discord's do.
  const empty = await (await send(url, { content: '  ' })).json()
  check('an empty message is refused as Discord refuses it', empty.code === 50006, JSON.stringify(empty))
  await wait(2100)
  const long = await send(url, { content: 'x'.repeat(2001) })
  check('more than 2000 characters is refused', long.status === 400)
  const wrong = await send(url.replace(/\/webhooks\/\d+/, '/webhooks/123456789012345678'), { content: 'nope' })
  check('a token with the wrong id is refused', wrong.status === 401)
  const about = await (await fetch(url)).json()
  check('GET gives the webhook', about.type === 1 && about.id === url.split('/').at(-2) && about.channel_id === 'general')
  await wait(2100)
  const burst = await Promise.all(Array.from({ length: 7 }, (_, i) => send(url, { content: `burst ${i}` })))
  const slowed = burst.find((r) => r.status === 429)
  check('too many at once are slowed down, with retry_after', !!slowed && typeof (await slowed.json()).retry_after === 'number')

  // A webhook never gets a copy of the space's key: its link would open the whole space.
  const keyed = await alice.evaluate(async () => {
    const { RoomLog } = await import('/src/store/log.ts')
    const key = (n) => String(n).repeat(64).slice(0, 64)
    const OWNER = key(1)
    const HOOK = key(2)
    let n = 0
    const ev = (author, kind, body) => ({ id: `${++n}`.padStart(64, '0'), room: 'r', author, lamport: n, kind, at: 1, body, sig: 'x'.repeat(128) })
    const log = new RoomLog('r')
    log.founder = OWNER
    log.add(ev(OWNER, 'hook', { id: '123456789012345678', name: 'CI', channel: 'general', pub: HOOK, key: 'A'.repeat(43) + '=', seed: 'a'.repeat(64) }))
    log.add(ev(HOOK, 'said', { text: 'hi', channel: 'general' }))
    return { members: log.keyMembers(), hooks: log.hooks().length }
  })
  check('a webhook is never given the space key', keyed.hooks === 1 && keyed.members.length === 1, JSON.stringify(keyed))

  // Removing somebody stops the webhook: the space has a new key.
  await openSpaceSettings(alice, 'members')
  let asked = ''
  alice.once('dialog', (d) => {
    asked = d.message()
    void d.accept()
  })
  await alice.click('.member-row:has-text("Bob") button:has-text("Remove")')
  check('the question before a removal says it stops the webhook', asked.includes('webhook'), asked.split('\n').at(-1))
  await alice.click('.settings-tab[data-tab="webhooks"]')
  const warned = await poll(async () => (await alice.locator('.hook-warning').count()) === 1, 15_000)
  check('the webhooks page says it stopped, at the top', warned)
  await alice.screenshot({ path: 'test-output/webhooks-stopped.png' })
  await alice.click('.settings-close')
  await alice.waitForSelector(BOX)
  await wait(2100)
  await send(url, { content: 'after the removal' })
  await wait(3000)
  check('what the old link posts is not shown', (await lines(alice, 'after the removal')) === 0)

  // A new link, and it works again.
  await openSpaceSettings(alice, 'webhooks')
  await alice.click('.hook-row button:has-text("Make a new link")')
  await poll(async () => (await alice.locator('.hook-warning').count()) === 0, 10_000)
  const fresh = await alice.evaluate(() => navigator.clipboard.readText())
  check('a stopped webhook gets a new link', fresh !== url && fresh.includes('/api/webhooks/'))
  await alice.click('.settings-close')
  await alice.waitForSelector(BOX)
  await send(fresh, { content: 'back again' })
  check('and the new link posts', await poll(async () => (await lines(alice, 'back again')) === 1, 15_000))

  // Deleted through the API, as Discord allows: the link stops.
  const gone = await fetch(fresh, { method: 'DELETE' })
  check('the link can delete its own webhook', gone.status === 204)
  await wait(2100)
  await send(fresh, { content: 'after it went' })
  await wait(3000)
  check('and what it posts after that is not shown', (await lines(alice, 'after it went')) === 0)
  check('what it posted before stays', (await lines(alice, 'back again')) === 1)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  try {
    process.kill(-vite.pid, 'SIGTERM')
  } catch {
    vite.kill()
  }
  server.child.kill()
}

finish()
