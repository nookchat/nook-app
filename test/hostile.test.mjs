import { APP_URL, check, finish, launch, stoppedEarly } from './harness.mjs'

// Lines a member, a removed member, or a server could write to hurt everybody else. Each is
// checked against the app's own code, in the page.

const browser = await launch()
const page = await browser.newPage()

try {
  await page.goto(APP_URL)

  const poison = await page.evaluate(async () => {
    const { RoomLog, makeEvent, openEvent } = await import('/src/store/log.ts')
    const { loadIdentity } = await import('/src/store/identity.ts')
    const me = loadIdentity().pubkey
    const room = 'a'.repeat(32)
    const wire = (e) => JSON.parse(JSON.stringify(e))

    const log = new RoomLog(room)
    log.me = me
    log.founder = me
    const fine = await openEvent(wire(await makeEvent(room, me, 1, 'profile', { name: 'Ada' })), room)
    log.add(fine)

    const bad = []
    for (const body of [
      { subject: { toString: 0 }, role: 'admin' },
      { subject: { valueOf: 1, toString: 2 }, role: 'admin' },
      { name: [{ toString: 'x' }] },
      { id: { __proto__: null, toString: 'x' } },
    ]) {
      const opened = await openEvent(wire(await makeEvent(room, me, 2, 'role', body)), room)
      bad.push(opened)
      // As a device would: whatever opens goes in the log.
      if (opened) log.add(opened)
    }
    // Twelve thousand deep: JSON.parse takes it, JSON.stringify and a worker do not.
    const deep = JSON.parse(`{"body":${'{"a":'.repeat(12_000)}1${'}'.repeat(12_000)}}`)
    let threw = ''
    let deepOpened = 'not tried'
    try {
      deepOpened = await openEvent({ ...wire(fine), ...deep }, room)
    } catch (err) {
      threw = String(err)
    }
    let foldThrew = ''
    try {
      log.authority()
      log.messages()
      log.channels()
    } catch (err) {
      foldThrew = String(err)
    }
    return {
      fineOpened: !!fine,
      badDropped: bad.every((e) => e === null),
      deepDropped: deepOpened === null && !threw,
      foldThrew,
      name: log.names().get(me),
    }
  })
  check('a plain event still opens', poison.fineOpened)
  check('an event whose body turns into no string is dropped', poison.badDropped)
  check('an event nested twelve thousand deep is dropped, and nothing throws', poison.deepDropped)
  check('the log still folds', !poison.foldThrew && poison.name === 'Ada', poison.foldThrew)

  const page60 = await page.evaluate(async () => {
    const { makeEvent } = await import('/src/store/log.ts')
    const { openEvents } = await import('/src/store/verify-pool.ts')
    const { loadIdentity } = await import('/src/store/identity.ts')
    const me = loadIdentity().pubkey
    const room = 'b'.repeat(32)
    const lines = []
    for (let i = 0; i < 60; i++) lines.push(JSON.parse(JSON.stringify(await makeEvent(room, me, i + 1, 'said', { text: `hi ${i}` }))))
    // One in the middle of a page that goes to the workers: structured clone fails on it.
    lines[30] = { ...lines[30], ...JSON.parse(`{"body":${'{"a":'.repeat(12_000)}1${'}'.repeat(12_000)}}`) }
    const out = await openEvents(lines, room)
    return { length: out.length, good: out.filter(Boolean).length, dropped: out[30] === null }
  })
  check(
    'a page with one too deep for a worker loses only that one',
    page60.length === 60 && page60.good === 59 && page60.dropped,
    JSON.stringify(page60),
  )

  const hooks = await page.evaluate(async () => {
    const { RoomLog, makeEvent, openEvent } = await import('/src/store/log.ts')
    const { loadIdentity } = await import('/src/store/identity.ts')
    const { makeHook } = await import('/src/space/webhook.ts')
    const me = loadIdentity().pubkey
    const room = 'c'.repeat(32)
    const log = new RoomLog(room)
    log.me = me
    log.founder = me
    let lamport = 1
    const add = async (kind, body) => log.add(await openEvent(JSON.parse(JSON.stringify(await makeEvent(room, me, lamport++, kind, body))), room))
    await add('profile', { name: 'Owner' })

    const real = await makeHook()
    await add('hook', { id: real.id, pub: real.pub, seed: real.seed, key: real.key, channel: 'general', name: 'Real' })
    // A manager names the owner's own key as a webhook's, with a seed that does not make it.
    const fake = await makeHook()
    await add('hook', { id: fake.id, pub: me, seed: fake.seed, key: fake.key, channel: 'general', name: 'Fake' })
    await add('react', { target: 'f'.repeat(64), emoji: '👍' })
    const listed = log.hooks().map((h) => h.name)
    return { listed, ownerStillOwner: log.authority().levelOf(me).id === 'owner', name: log.names().get(me) }
  })
  check('a webhook whose seed makes its key is a webhook', hooks.listed.includes('Real'), JSON.stringify(hooks.listed))
  check('a webhook named with somebody else\'s key is not', !hooks.listed.includes('Fake'))
  check('and that person keeps their events', hooks.name === 'Owner' && hooks.ownerStillOwner)

  const keyed = await page.evaluate(async () => {
    const { SpaceKeys } = await import('/src/space/keys.ts')
    const { makeHook } = await import('/src/space/webhook.ts')
    const { fromBase64, toHex } = await import('/src/bytes.ts')
    const base = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const keys = new SpaceKeys(base)
    const hook = await makeHook()
    await keys.learnHooks([{ key: hook.key, pub: hook.pub }])
    // The tag of a key: see idOf in src/space/keys.ts.
    const raw = fromBase64(hook.key)
    const bytes = new Uint8Array(raw.length + 16)
    bytes.set(new TextEncoder().encode('nook-space-key-1'), 0)
    bytes.set(raw, 16)
    const tag = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 32)
    const someone = 'd'.repeat(64)
    return {
      opensLines: !!keys.key(tag),
      post: keys.mayStand(tag, { author: hook.pub, kind: 'said' }),
      gone: keys.mayStand(tag, { author: hook.pub, kind: 'hook' }),
      asSomebodyElse: keys.mayStand(tag, { author: someone, kind: 'said' }),
      push: keys.mayStand(tag, { author: hook.pub, kind: 'push' }),
      role: keys.mayStand(tag, { author: hook.pub, kind: 'role' }),
      spaceKey: keys.mayStand('', { author: someone, kind: 'role' }),
      signal: keys.signalKey(tag) === undefined,
    }
  })
  check('a webhook key opens the webhook\'s posts', keyed.opensLines && keyed.post && keyed.gone)
  check('a line under a webhook key from anybody else is dropped', !keyed.asSomebodyElse)
  check('a webhook key cannot carry anything but a post', !keyed.push && !keyed.role)
  check('the space key still opens anything', keyed.spaceKey)
  check('a signal under a webhook key is not heard', keyed.signal)

  const pushed = await page.evaluate(async () => {
    const { RoomLog, openEvent } = await import('/src/store/log.ts')
    const { loadIdentity } = await import('/src/store/identity.ts')
    const { makeHook } = await import('/src/space/webhook.ts')
    const { schnorr } = await import('/node_modules/@noble/curves/esm/secp256k1.js')
    const { fromHex, toHex } = await import('/src/bytes.ts')
    const me = loadIdentity().pubkey
    const room = 'e'.repeat(32)
    const log = new RoomLog(room)
    log.me = me
    log.founder = me
    const { makeEvent } = await import('/src/store/log.ts')
    const add = async (e) => log.add(await openEvent(JSON.parse(JSON.stringify(e)), room))
    const hook = await makeHook()
    await add(await makeEvent(room, me, 1, 'hook', { id: hook.id, pub: hook.pub, seed: hook.seed, key: hook.key, channel: 'general', name: 'Hook' }))
    // Anybody can sign as a webhook: its seed is in the log. A push target signed so is not its own.
    const asHook = async (lamport, kind, body) => {
      const base = { room, author: hook.pub, lamport, kind, at: Date.now(), body }
      const bytes = new TextEncoder().encode(JSON.stringify([base.room, base.author, base.lamport, base.kind, base.at, base.body]))
      const id = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      return { ...base, id, sig: toHex(schnorr.sign(fromHex(id), fromHex(hook.seed))) }
    }
    await add(await asHook(2, 'push', { id: 'device', endpoint: 'https://fcm.googleapis.com/x', p256dh: 'x', auth: 'x', what: 'all', text: true }))
    await add(await asHook(3, 'said', { text: 'from the hook', channel: 'general' }))
    return {
      pushTargets: log.pushTargets().size,
      posted: log.messages('general').some((m) => m.text === 'from the hook'),
    }
  })
  check('a push target signed as a webhook is not counted', pushed.pushTargets === 0, `${pushed.pushTargets}`)
  check('a post by the webhook still shows', pushed.posted)

  const types = await page.evaluate(async () => {
    const { blobType } = await import('/src/net/files.ts')
    return ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'image/png', 'video/mp4', 'audio/ogg', 'IMAGE/SVG+XML'].map(blobType)
  })
  check(
    'a file a member says is SVG, HTML or XML is opened as plain bytes',
    types.slice(0, 4).every((t) => t === 'application/octet-stream') && types[7] === 'application/octet-stream',
    types.join(', '),
  )
  check('a picture, a video and a sound keep their type', types[4] === 'image/png' && types[5] === 'video/mp4' && types[6] === 'audio/ogg')

  // Removals and lower levels that a place picked by hand cannot undo. Each event is signed by
  // its own person, and comes in at a place among the lines that the check gives it.
  const order = await page.evaluate(async () => {
    const { RoomLog, openEvent } = await import('/src/store/log.ts')
    const { schnorr } = await import('/node_modules/@noble/curves/esm/secp256k1.js')
    const { fromHex, toHex } = await import('/src/bytes.ts')
    const room = '9'.repeat(32)
    const people = {}
    for (const name of ['owner', 'ada', 'kim', 'max', 'xia']) {
      const secret = toHex(schnorr.utils.randomSecretKey())
      people[name] = { secret, key: toHex(schnorr.getPublicKey(fromHex(secret))) }
    }
    const signed = async (who, lamport, kind, body) => {
      const base = { room, author: people[who].key, lamport, kind, at: lamport, body }
      const bytes = new TextEncoder().encode(JSON.stringify([base.room, base.author, base.lamport, base.kind, base.at, base.body]))
      const id = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      return openEvent({ ...base, id, sig: toHex(schnorr.sign(fromHex(id), fromHex(people[who].secret))) }, room)
    }
    const fresh = async (lines) => {
      const log = new RoomLog(room)
      log.founder = people.owner.key
      log.me = people.owner.key
      let place = 0
      for (const [who, lamport, kind, body] of lines) log.add(await signed(who, lamport, kind, body), place++)
      return log
    }
    const role = (subject, r, more = {}) => ({ subject: people[subject].key, role: r, ...more })
    const start = [
      ['owner', 1, 'role', role('owner', 'admin')],
      ['owner', 2, 'role', role('ada', 'admin')],
      ['owner', 3, 'role', role('kim', 'admin')],
    ]
    const roleOf = (log, who) => log.roleOf(people[who].key)

    // Ada removes Kim. Kim then signs a removal of Ada, placed just before.
    const counter = await fresh([...start, ['ada', 100, 'role', role('kim', 'kicked')], ['kim', 99, 'role', role('ada', 'kicked')]])
    // The same two, but Kim's came first: Kim really did act first.
    const first = await fresh([...start, ['kim', 99, 'role', role('ada', 'kicked')], ['ada', 100, 'role', role('kim', 'kicked')]])
    // Max is removed, then signs a post placed before it; and one he wrote before, that came before.
    const posts = await fresh([
      ...start,
      ['max', 50, 'said', { text: 'before', channel: 'general' }],
      ['owner', 200, 'role', role('max', 'kicked')],
      ['max', 150, 'said', { text: 'backdated', channel: 'general' }],
    ])
    // Ada is put back on Member, then signs a rise for Xia placed before it.
    const demoted = await fresh([...start, ['owner', 300, 'role', role('ada', 'member')], ['ada', 290, 'role', role('xia', 'admin')]])
    // A member's removal of Ada, which they may not make, with a place far ahead: Ada still acts after it.
    const ahead = Date.now() + 20 * 24 * 60 * 60 * 1000
    const fake = await fresh([...start, ['max', ahead, 'role', role('ada', 'kicked')], ['ada', 400, 'role', role('xia', 'mod')]])
    // A place far past any clock would stay the newest in its channel for ever.
    const farAhead = await signed('max', 1e15, 'said', { text: 'from the future', channel: 'general' })
    // Nothing placed by hand: as it always was.
    const plain = await fresh([...start, ['ada', 10, 'role', role('xia', 'mod')], ['owner', 20, 'role', role('kim', 'member')], ['ada', 30, 'role', role('max', 'kicked')]])
    // A new key for a removal this device was never sent.
    const held = await fresh([...start, ['ada', 500, 'key', { id: 'a'.repeat(32), new: true, after: 499, boxes: {} }]])
    const withKick = await fresh([...start, ['ada', 499, 'role', role('max', 'kicked')], ['ada', 500, 'key', { id: 'a'.repeat(32), new: true, after: 499, boxes: {} }]])
    // A Helper may change levels only. Hal is one, and puts Xia on Moderator, which may remove people.
    const helper = await fresh([
      ...start,
      ['owner', 10, 'level', { id: 'helper', name: 'Helper', rank: 60, can: ['levels'] }],
      ['owner', 11, 'role', role('max', 'helper')],
      ['max', 12, 'role', role('xia', 'mod')],
    ])
    // Ada makes a key, and is put on Member later: her key is still the space's.
    const kept = await fresh([...start, ['ada', 20, 'key', { id: 'b'.repeat(32), new: true, after: 0, boxes: {} }], ['owner', 30, 'role', role('ada', 'member')]])
    // Ada makes a key with a copy for Kim. Max, who has no copy, writes one for Xia that opens to nothing.
    const copies = await fresh([
      ...start,
      ['ada', 40, 'key', { id: 'c'.repeat(32), new: true, after: 0, boxes: { [people.kim.key]: 'AAAA' } }],
      ['max', 41, 'key', { id: 'c'.repeat(32), boxes: { [people.xia.key]: 'AAAA' } }],
    ])
    const holders = copies.keyHolders('c'.repeat(32))
    return {
      farAhead: farAhead === null,
      helper: roleOf(helper, 'xia'),
      kept: kept.keyEpochs().map((e) => e.id[0]).join(''),
      holders: [holders.has(people.kim.key), holders.has(people.xia.key)],
      counter: [roleOf(counter, 'ada'), roleOf(counter, 'kim')],
      first: [roleOf(first, 'ada'), roleOf(first, 'kim')],
      posts: posts.messages('general').map((m) => m.text),
      demoted: roleOf(demoted, 'xia'),
      fake: roleOf(fake, 'xia'),
      plain: [roleOf(plain, 'xia'), roleOf(plain, 'kim'), roleOf(plain, 'max')],
      held: [held.holdsRemovalFor('a'.repeat(32)), withKick.holdsRemovalFor('a'.repeat(32))],
    }
  })
  check('a removal stands against a removal signed after it with an earlier place', order.counter.join() === 'admin,kicked', order.counter.join())
  check('one that really came first still stands', order.first.join() === 'kicked,admin', order.first.join())
  check('a removed person cannot post with a place before their removal', order.posts.join() === 'before', order.posts.join())
  check('somebody put on a lower level cannot raise anybody from before it', order.demoted === 'member', order.demoted)
  check('a removal nobody may make holds back nothing', order.fake === 'mod', order.fake)
  check('with no place picked by hand, levels come out as before', order.plain.join() === 'mod,member,kicked', order.plain.join())
  check('a new key is passed on only once its removal is here', order.held.join() === 'false,true', order.held.join())
  check('an event placed far past any clock is not taken', order.farAhead)
  check('nobody puts anybody on a level that can do more than they can', order.helper === 'member', order.helper)
  check('a key stays the space\'s when its maker is put on a lower level later', order.kept === 'b', order.kept)
  check('a copy from somebody without the key is not counted', order.holders.join() === 'true,false', order.holders.join())
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
