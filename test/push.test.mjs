import { createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { APP_URL, check, finish, HOME, launch, makeSpace, poll, stoppedEarly, wait } from './harness.mjs'

// A notification for somebody whose Nook is closed. Their device says in the space where it
// takes them; whoever writes seals one for that browser; the server signs and passes it on to
// the push service, here a fake one, which gets bytes only that browser can open.
const SERVER = process.env.NOOK_SERVER ?? 'http://localhost:8787'
const BOX = '[aria-label="Write a message"]'
const browser = await launch()

// The fake push service, and the key pair of Bob's browser.
const received = []
const service = createServer((req, res) => {
  const parts = []
  req.on('data', (b) => parts.push(b))
  req.on('end', () => {
    received.push({ path: req.url, headers: req.headers, body: Buffer.concat(parts) })
    res.writeHead(201).end()
  })
})
await new Promise((done) => service.listen(0, done))
const endpoint = `http://localhost:${service.address().port}/push/bob`
const bobBrowser = createECDH('prime256v1')
bobBrowser.generateKeys()
const uaPublic = bobBrowser.getPublicKey()
const authSecret = randomBytes(16)

/** RFC 8291, as a browser opens it. */
function open(body) {
  const salt = body.subarray(0, 16)
  const idLength = body[20]
  const asPublic = body.subarray(21, 21 + idLength)
  const sealed = body.subarray(21 + idLength)
  const shared = bobBrowser.computeSecret(asPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, info, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  let end = plain.length - 1
  while (end > 0 && plain[end] === 0) end--
  if (plain[end] !== 2) throw new Error('no padding delimiter')
  return JSON.parse(plain.subarray(0, end).toString('utf8'))
}

/** RFC 8292: the server signed it with the key it hands out. */
function signedBy(header, key) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header ?? '')
  if (!match || match[2] !== key) return false
  const [head, claims, signature] = match[1].split('.')
  const raw = Buffer.from(key, 'base64url')
  const pub = createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
  })
  const ok = verify('sha256', Buffer.from(`${head}.${claims}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  const aud = JSON.parse(Buffer.from(claims, 'base64url').toString()).aud
  return ok && aud === new URL(endpoint).origin
}

async function person(name, context) {
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector(HOME)
  return page
}

const spaceOf = (page, work, arg) =>
  page.evaluate(
    async ({ work, arg }) => {
      const { spaces } = await import('/src/space/registry.ts')
      const space = spaces.all()[0]
      return new Function('space', 'arg', `return (${work})(space, arg)`)(space, arg)
    },
    { work: work.toString(), arg },
  )

try {
  const key = (await (await fetch(`${SERVER}/api/v1/push`)).json()).key
  check('the server hands out its push key', /^[A-Za-z0-9_-]{87}$/.test(key))
  const refused = await fetch(`${SERVER}/api/v1/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://example.com/steal', body: randomBytes(120).toString('base64url') }),
  })
  check('and passes a push only to a push service', refused.status === 400)

  const alice = await person('Alice', await browser.newContext())
  await makeSpace(alice, 'pushy')
  await alice.waitForSelector(BOX)
  const link = alice.url()

  // Bob's browser has notifications on. Headless Chrome has no push service, so this stands in for it.
  const bobContext = await browser.newContext()
  await bobContext.grantPermissions(['notifications'], { origin: new URL(APP_URL).origin })
  await bobContext.addInitScript(
    ({ endpoint, p256dh, auth }) => {
      localStorage.setItem('nook.notify.v1', 'on')
      const made = { endpoint, options: { applicationServerKey: null }, toJSON: () => ({ endpoint, keys: { p256dh, auth } }), unsubscribe: async () => true }
      let held = null
      PushManager.prototype.getSubscription = async () => held
      PushManager.prototype.subscribe = async (options) => {
        made.options.applicationServerKey = options.applicationServerKey
        held = made
        return made
      }
    },
    { endpoint, p256dh: uaPublic.toString('base64url'), auth: authSecret.toString('base64url') },
  )
  const bob = await person('Bob', bobContext)
  await bob.goto(link)
  await bob.waitForSelector(BOX)
  const bobKey = await spaceOf(bob, (space) => space.chat.me)
  const told = await poll(
    () => spaceOf(alice, (space, key) => (space.chat.log.pushTargets().get(key) ?? []).length, bobKey),
    20_000,
  )
  check("Bob's device says where it takes notifications, with no click", told === 1)
  const target = await spaceOf(alice, (space, key) => space.chat.log.pushTargets().get(key)[0], bobKey)
  check('it names the server that signs for it', target?.via === SERVER && target?.endpoint === endpoint)

  // Bob closes Nook.
  await bob.close()
  await poll(() => spaceOf(alice, (space, key) => !space.mesh.peers().some((p) => p.key === key), bobKey), 20_000)

  await spaceOf(alice, (space) => space.chat.say('@Bob are you there?', 'general'))
  const came = await poll(() => received.length > 0, 15_000)
  check('a mention reaches the push service', came)
  const first = received[0]
  check('signed by the server, with the key it hands out', first && signedBy(first.headers.authorization, key))
  check('as aes128gcm', first?.headers['content-encoding'] === 'aes128gcm')
  let opened = null
  try {
    opened = open(first.body)
  } catch (err) {
    console.log(err)
  }
  check('and only his browser opens it: who, where and what', opened?.t === 'Alice (#general, pushy)' && opened?.b === '@Bob are you there?', JSON.stringify(opened))
  check('with the space and the channel to open', opened?.ch === 'general' && /^[0-9a-f]{32}$/.test(opened?.room ?? ''))

  await spaceOf(alice, (space) => space.chat.say('just talking to myself', 'general'))
  await wait(2500)
  check('a message that is not for him sends nothing', received.length === 1)

  await spaceOf(alice, (space, key) => space.chat.sayDirect(key, 'a secret for Bob'), bobKey)
  await poll(() => received.length > 1, 15_000)
  const dm = received[1] ? open(received[1].body) : null
  check('a direct message does', dm?.t === 'Alice' && dm?.b === 'a secret for Bob' && dm?.dm, JSON.stringify(dm))

  // Bob is back: his page shows its own notifications, so no push goes.
  const bobAgain = await bobContext.newPage()
  await bobAgain.goto(link)
  await bobAgain.waitForSelector(BOX)
  await poll(() => spaceOf(alice, (space, key) => space.mesh.peers().some((p) => p.key === key), bobKey), 20_000)
  const before = received.length
  await spaceOf(alice, (space) => space.chat.say('@Bob welcome back', 'general'))
  await wait(2500)
  check('somebody with Nook open gets no push', received.length === before)

  // The service worker shows what comes in.
  const cdp = await bobContext.newCDPSession(bobAgain)
  const registrations = []
  cdp.on('ServiceWorker.workerRegistrationUpdated', (ev) => registrations.push(...ev.registrations))
  await cdp.send('ServiceWorker.enable')
  const reg = await poll(() => registrations.find((r) => r.scopeURL.startsWith(new URL(APP_URL).origin)), 10_000)
  if (reg) {
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: new URL(APP_URL).origin,
      registrationId: reg.registrationId,
      data: JSON.stringify({ t: 'Alice (#general, pushy)', b: 'hello from the worker', tag: 'abc', room: '0'.repeat(32), ch: 'general' }),
    })
  }
  const shown = await poll(
    async () => {
      const list = await bobAgain.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => `${n.title}|${n.body}`))
      return list.length ? list : null
    },
    10_000,
  )
  check('the service worker shows it as a notification', shown?.includes('Alice (#general, pushy)|hello from the worker'), JSON.stringify(shown))

  // Notifications off: the device says so, and no push goes to it any more.
  await bobAgain.evaluate(async () => (await import('/src/ui/notify.ts')).stopNotify())
  const gone = await poll(() => spaceOf(alice, (space, key) => !space.chat.log.pushTargets().has(key), bobKey), 20_000)
  check('turned off, the device takes its address back', gone)
} catch (err) {
  stoppedEarly(err)
} finally {
  service.close()
  await browser.close()
  finish()
}
