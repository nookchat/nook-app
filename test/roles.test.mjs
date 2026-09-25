import { APP_URL, check, finish, launch, stoppedEarly } from './harness.mjs'

const browser = await launch()
const page = await browser.newPage()

try {
  await page.goto(APP_URL)
  const keys = await page.evaluate(async () => {
    const { deriveRoom, newSecret, parseSecret } = await import('/src/room.ts')
    const secret = newSecret()
    const plain = await deriveRoom(secret)
    const locked = await deriveRoom(secret, 'hunter2')
    const wrong = await deriveRoom(secret, 'hunter3')

    // Crockford has no I, L, O or U, so 'Z' is always a swap.
    const near = secret.slice(0, -1) + (secret.at(-1) === 'Z' ? 'Y' : 'Z')
    const neighbour = await deriveRoom(near)

    return {
      length: parseSecret(secret)?.length,
      idLength: plain.id.length,
      passwordMoves: plain.id !== locked.id,
      wrongPassword: locked.id !== wrong.id,
      neighbour: plain.id !== neighbour.id,
      stable: (await deriveRoom(secret)).id === plain.id,
    }
  })
  check('a code is twelve symbols', keys.length === 12, `${keys.length}`)
  check('the topic gives nothing away', keys.idLength === 32, `${keys.idLength} hex`)
  check('a password moves the space somewhere else', keys.passwordMoves)
  check('a wrong password lands somewhere else again', keys.wrongPassword)
  check('one symbol out is a different space', keys.neighbour)
  check('the same code always derives the same space', keys.stable)

  // Wall clock says more about the machine than the code, so measure against a timed baseline.
  const cost = await page.evaluate(async () => {
    const { deriveRoom, newSecret } = await import('/src/room.ts')
    const secret = newSecret()

    const once = async (iterations) => {
      const material = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        'PBKDF2',
        false,
        ['deriveBits'],
      )
      const start = performance.now()
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations },
        material,
        256,
      )
      return performance.now() - start
    }

    // One sample of something this quick is mostly noise.
    let baseline = Infinity
    for (let i = 0; i < 5; i++) baseline = Math.min(baseline, await once(10_000))

    let real = Infinity
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      await deriveRoom(secret)
      real = Math.min(real, performance.now() - start)
    }

    return { rounds: Math.round((real / baseline) * 10_000) }
  })
  check(
    'a code is stretched before it is used as a key',
    cost.rounds > 100_000,
    `about ${cost.rounds.toLocaleString()} PBKDF2 rounds`,
  )

  const roles = await page.evaluate(async () => {
    const { RoomLog } = await import('/src/store/log.ts')

    const key = (n) => String(n).repeat(64).slice(0, 64)
    const FOUNDER = key(1)
    const MEMBER = key(2)
    const THIRD = key(3)

    // Unsigned on purpose: a hostile peer signs under its own key anyway, and this is about who the log obeys.
    let n = 0
    const ev = (author, kind, body) => ({
      id: `${++n}`.padStart(64, '0'),
      room: 'r',
      author,
      lamport: n,
      kind,
      at: 1,
      body,
      sig: 'x'.repeat(128),
    })

    const build = (events) => {
      const log = new RoomLog('r')
      log.founder = FOUNDER
      for (const e of events) log.add(e)
      return log
    }

    const named = build([ev(FOUNDER, 'space', { name: 'Book club' })])
    const stolenName = build([ev(MEMBER, 'space', { name: 'Mine now' })])

    const grabbed = build([ev(MEMBER, 'role', { subject: MEMBER, role: 'admin' })])
    const promoted = build([ev(FOUNDER, 'role', { subject: MEMBER, role: 'admin' })])

    const chain = build([
      ev(FOUNDER, 'role', { subject: MEMBER, role: 'admin' }),
      ev(MEMBER, 'role', { subject: THIRD, role: 'admin' }),
    ])

    const coup = build([
      ev(FOUNDER, 'role', { subject: MEMBER, role: 'admin' }),
      ev(MEMBER, 'role', { subject: FOUNDER, role: 'kicked' }),
    ])

    const channels = build([
      ev(FOUNDER, 'channel', { name: 'plans' }),
      ev(MEMBER, 'channel', { name: 'spam' }),
    ]).channels()

    const spoken = build([
      ev(FOUNDER, 'said', { text: 'hello', channel: 'plans' }),
      ev(MEMBER, 'said', { text: 'hello', channel: 'spam' }),
    ]).channels()

    return {
      nameOk: named.spaceName() === 'Book club',
      nameStaysPut: stolenName.spaceName() !== 'Mine now',
      founderIsOwner: named.roleOf(FOUNDER) === 'owner',
      grabRefused: grabbed.roleOf(MEMBER) !== 'admin',
      promoteWorks: promoted.roleOf(MEMBER) === 'admin',
      chainWorks: chain.roleOf(THIRD) === 'admin',
      founderSurvives: coup.roleOf(FOUNDER) === 'owner',
      adminChannel: channels.includes('plans'),
      memberChannel: channels.includes('spam') === false,
      adminSaidChannel: spoken.includes('plans'),
      memberSaidChannel: spoken.includes('spam') === false,
    }
  })
  check('the founder names the space', roles.nameOk)
  check('a member cannot rename it', roles.nameStaysPut)
  check('the founder is its owner', roles.founderIsOwner)
  check('a member cannot promote themselves', roles.grabRefused)
  check('an admin can promote somebody else', roles.promoteWorks)
  check('and the new admin can promote a third', roles.chainWorks)
  check('but nobody can depose the founder', roles.founderSurvives)
  check('an admin makes a channel', roles.adminChannel)
  check('a member does not', roles.memberChannel)
  check('an admin talking in a channel keeps it listed', roles.adminSaidChannel)
  check('a member talking in one does not conjure it', roles.memberSaidChannel)

  const levels = await page.evaluate(async () => {
    const { RoomLog } = await import('/src/store/log.ts')
    const key = (n) => String(n).repeat(64).slice(0, 64)
    const OWNER = key(1)
    const ADMIN = key(2)
    const HELPER = key(3)
    const MEMBER = key(4)
    const MSG = key(7)

    let n = 0
    const ev = (author, kind, body) => ({
      id: `${++n}`.padStart(64, '0'),
      room: 'r',
      author,
      lamport: n,
      kind,
      at: 1,
      body,
      sig: 'x'.repeat(128),
    })
    const build = (events) => {
      const log = new RoomLog('r')
      log.founder = OWNER
      for (const e of events) log.add(e)
      return log
    }
    const helpers = (author, extra = {}) =>
      ev(author, 'level', { id: 'helpers', name: 'Helpers', colour: '#2ec4b6', rank: 30, can: ['pin'], ...extra })

    const start = build([])
    const made = build([helpers(OWNER), ev(OWNER, 'role', { subject: HELPER, role: 'helpers' })])
    const byMember = build([helpers(MEMBER)])
    const pinned = build([
      helpers(OWNER),
      ev(OWNER, 'role', { subject: HELPER, role: 'helpers' }),
      ev(HELPER, 'pin', { target: MSG, on: true }),
    ])

    const admin = ev(OWNER, 'role', { subject: ADMIN, role: 'admin' })
    const ownLevel = build([admin, ev(ADMIN, 'level', { id: 'admin', name: 'Kings', colour: '#ffffff', rank: 100, can: [] })])
    const above = build([admin, ev(ADMIN, 'level', { id: 'high', name: 'High', colour: '', rank: 500, can: [] })])
    const crowned = build([admin, ev(ADMIN, 'role', { subject: MEMBER, role: 'owner' })])
    const deposed = build([admin, ev(ADMIN, 'role', { subject: OWNER, role: 'member' })])

    const lent = build([
      helpers(OWNER, { can: ['pin', 'levels'] }),
      ev(OWNER, 'role', { subject: HELPER, role: 'helpers' }),
      ev(HELPER, 'level', { id: 'sub', name: 'Sub', colour: '', rank: 10, can: ['pin', 'space'] }),
    ])

    const dropped = build([
      helpers(OWNER),
      ev(OWNER, 'role', { subject: HELPER, role: 'helpers' }),
      ev(OWNER, 'level', { id: 'helpers', gone: true }),
    ])
    const badColour = build([helpers(OWNER, { colour: 'red' })])

    const mod = ev(OWNER, 'role', { subject: HELPER, role: 'mod' })
    const kicks = build([admin, mod, ev(HELPER, 'role', { subject: MEMBER, role: 'kicked' }), ev(HELPER, 'role', { subject: ADMIN, role: 'kicked' })])

    return {
      starts: start.authority().list().map((l) => l.id).join(','),
      placed: made.authority().levelOf(HELPER).colour,
      memberMade: byMember.authority().level('helpers') === undefined,
      canPin: pinned.pinned().has(MSG),
      ownLevel: ownLevel.authority().level('admin')?.name,
      above: above.authority().level('high') === undefined,
      crowned: crowned.roleOf(MEMBER),
      deposed: deposed.roleOf(OWNER),
      lent: lent.authority().level('sub')?.can.join(','),
      dropped: dropped.roleOf(HELPER),
      badColour: badColour.authority().level('helpers')?.colour,
      memberKicked: kicks.roleOf(MEMBER),
      adminKicked: kicks.roleOf(ADMIN),
    }
  })
  check('a space starts with owner, admin, moderator and member', levels.starts === 'owner,admin,mod,member', levels.starts)
  check('the owner makes a level and puts somebody on it, in its colour', levels.placed === '#2ec4b6', levels.placed)
  check('a member cannot make a level', levels.memberMade)
  check('what a level may do counts: its people can pin', levels.canPin)
  check('an admin cannot change their own level', levels.ownLevel === 'Admin', levels.ownLevel)
  check('or make one above it', levels.above)
  check('or make somebody the owner', levels.crowned === 'member', levels.crowned)
  check('or move the owner', levels.deposed === 'owner', levels.deposed)
  check('nobody gives a power they do not have', levels.lent === 'pin', levels.lent)
  check('a deleted level sends its people back to member', levels.dropped === 'member', levels.dropped)
  check('a colour has to be a colour', levels.badColour === '', JSON.stringify(levels.badColour))
  check('a moderator can remove a member', levels.memberKicked === 'kicked', levels.memberKicked)
  check('but not an admin, who is above them', levels.adminKicked === 'admin', levels.adminKicked)

  const order = await page.evaluate(async () => {
    const { RoomLog, makeEvent } = await import('/src/store/log.ts')
    const wait = () => new Promise((r) => setTimeout(r, 20))
    const write = async (log, who, text) => {
      const e = await makeEvent('r', who, log.nextLamport(), 'said', { text })
      log.add(e)
      return e
    }
    const alice = new RoomLog('r')
    const bob = new RoomLog('r')
    const A = 'a'.repeat(64)
    const B = 'b'.repeat(64)

    const a1 = await write(alice, A, 'alice 1')
    await wait()
    const a2 = await write(alice, A, 'alice 2')
    await wait()
    const b1 = await write(bob, B, 'bob 1') // bob only turns up now, log empty
    await wait()
    const a3 = await write(alice, A, 'alice 3')

    const merged = new RoomLog('r')
    for (const e of [a1, a2, b1, a3]) merged.add(e)

    const late = new RoomLog('r')
    late.add(a3)
    const reply = await write(late, B, 'bob replies')

    return {
      merged: merged.messages().map((m) => m.text),
      causal: reply.lamport > a3.lamport,
    }
  })
  check(
    'a late arrival does not land at the top of the history',
    JSON.stringify(order.merged) === JSON.stringify(['alice 1', 'alice 2', 'bob 1', 'alice 3']),
    order.merged.join(' | '),
  )
  check('and a reply still sorts after what it replies to', order.causal)

  const outbound = await page.evaluate(async () => {
    const { RoomChat } = await import('/src/store/room-chat.ts')
    const chat = new RoomChat('outbound-test-room', 'K7M29QPTVB2W')
    const sent = []
    chat.onLocal = (e) => sent.push(e.kind)
    await chat.announceName('Alice')
    await chat.say('hello', 'general')
    await chat.makeChannel('plans')
    await chat.setSpaceName('Book club')
    await chat.claimFounder()
    return sent
  })
  for (const kind of ['profile', 'said', 'channel', 'space', 'role']) {
    check(`a ${kind} event is handed to the other people`, outbound.includes(kind), outbound.join(','))
  }

  const pins = await page.evaluate(async () => {
    const { RoomLog } = await import('/src/store/log.ts')
    const key = (n) => String(n).repeat(64).slice(0, 64)
    const FOUNDER = key(1)
    const MEMBER = key(2)
    const MSG = key(7)
    const OTHER = key(8)

    let n = 0
    const ev = (author, kind, body) => ({
      id: `${++n}`.padStart(64, '0'),
      room: 'r',
      author,
      lamport: n,
      kind,
      at: 1,
      body,
      sig: 'x'.repeat(128),
    })
    const build = (events) => {
      const log = new RoomLog('r')
      log.founder = FOUNDER
      for (const e of events) log.add(e)
      return log
    }

    const byAdmin = build([ev(FOUNDER, 'pin', { target: MSG, on: true })])
    const byMember = build([ev(MEMBER, 'pin', { target: MSG, on: true })])
    const unpinned = build([
      ev(FOUNDER, 'pin', { target: MSG, on: true }),
      ev(FOUNDER, 'pin', { target: MSG, on: false }),
    ])
    const two = build([
      ev(FOUNDER, 'pin', { target: MSG, on: true }),
      ev(FOUNDER, 'pin', { target: OTHER, on: true }),
    ])

    return {
      admin: byAdmin.pinned().has(MSG),
      member: byMember.pinned().has(MSG),
      undone: unpinned.pinned().has(MSG),
      several: two.pinned().size,
    }
  })
  check('an admin can pin a message', pins.admin)
  check('a member cannot', pins.member === false)
  check('and a pin can be taken back', pins.undone === false)
  check('a channel can hold more than one', pins.several === 2, `${pins.several}`)

  const polls = await page.evaluate(async () => {
    const { RoomLog } = await import('/src/store/log.ts')
    const key = (n) => String(n).repeat(64).slice(0, 64)
    const A = key(1)
    const B = key(2)
    const C = key(3)

    let n = 0
    const ev = (author, kind, body) => ({
      id: `${++n}`.padStart(64, '0'),
      room: 'r',
      author,
      lamport: n,
      kind,
      at: 1,
      body,
      sig: 'x'.repeat(128),
    })
    const build = (events, me = A) => {
      const log = new RoomLog('r')
      log.founder = A
      log.me = me
      for (const e of events) log.add(e)
      return log
    }

    const ask = ev(A, 'poll', { question: 'Pizza?', options: ['Yes', 'No'], channel: 'general' })
    const thin = ev(A, 'poll', { question: 'One?', options: ['Only'], channel: 'general' })

    const votes = build([ask, ev(B, 'vote', { target: ask.id, choice: 0 }), ev(C, 'vote', { target: ask.id, choice: 1 })])
    const poll = votes.messages('general')[0]?.poll

    const moved = build([
      ask,
      ev(B, 'vote', { target: ask.id, choice: 0 }),
      ev(B, 'vote', { target: ask.id, choice: 1 }),
    ])
    const after = moved.messages('general')[0]?.poll

    const silly = build([ask, ev(B, 'vote', { target: ask.id, choice: 99 })])
    const sillyPoll = silly.messages('general')[0]?.poll

    const mine = build([ask, ev(B, 'vote', { target: ask.id, choice: 1 })], B)
    const minePoll = mine.messages('general')[0]?.poll

    return {
      asked: poll?.question === 'Pizza?' && poll.options.length === 2,
      counted: poll?.total === 2,
      split: [poll?.votes.get(0)?.size ?? 0, poll?.votes.get(1)?.size ?? 0],
      movedTotal: after?.total,
      movedTo: after?.votes.get(1)?.size ?? 0,
      sillyTotal: sillyPoll?.total,
      mine: minePoll?.mine,
      thin: build([thin]).messages('general').length,
    }
  })
  check('a poll is a question with answers', polls.asked)
  check('and the answers are counted', polls.counted && polls.split[0] === 1 && polls.split[1] === 1, polls.split.join(' vs '))
  check('changing your mind moves your vote rather than adding one', polls.movedTotal === 1 && polls.movedTo === 1)
  check('a vote for an answer that does not exist is ignored', polls.sillyTotal === 0)
  check('and you can see which one you picked', polls.mine === 1, `${polls.mine}`)
  check('a poll with one answer is not a poll', polls.thin === 0)

  const reset = await page.evaluate(async () => {
    const { RoomLog } = await import('/src/store/log.ts')
    const key = (n) => String(n).repeat(64).slice(0, 64)
    const A = key(1)
    const B = key(2)

    let n = 0
    const ev = (author, kind, body) => ({
      id: `${++n}`.padStart(64, '0'),
      room: 'r',
      author,
      lamport: n,
      kind,
      at: 1,
      body,
      sig: 'x'.repeat(128),
    })

    const old1 = ev(A, 'said', { text: 'before', channel: 'general' })
    const old2 = ev(B, 'said', { text: 'also before', channel: 'general' })
    const named = ev(A, 'space', { name: 'The place' })
    const madeChannel = ev(A, 'channel', { name: 'plans' })
    const promoted = ev(A, 'role', { subject: B, role: 'admin' })
    const profile = ev(B, 'profile', { name: 'Bob' })
    const line = ev(A, 'reset', { before: 100 })
    const fresh = { ...ev(A, 'said', { text: 'after', channel: 'general' }), lamport: 200 }
    const byMember = ev(B, 'reset', { before: 300 })

    const build = (events) => {
      const log = new RoomLog('r')
      log.founder = A
      for (const e of events) log.add(e)
      return log
    }

    const all = [old1, old2, named, madeChannel, promoted, profile, line, fresh]
    const after = build(all)
    const texts = after.messages('general').map((m) => m.text)

    const ignored = build([old1, byMember]).messages('general').map((m) => m.text)

    return {
      texts,
      name: after.spaceName(),
      channels: after.channels(),
      stillAdmin: after.roleOf(B) === 'admin',
      names: [...after.names().values()],
      ignored,
    }
  })
  check('a reset clears what was said before it', reset.texts.join() === 'after', reset.texts.join(' | ') || '(nothing)')
  check('the space keeps its name', reset.name === 'The place', reset.name)
  check('and its channels', reset.channels.includes('plans'), reset.channels.join())
  check('and who runs it', reset.stillAdmin)
  check('and what people are called', reset.names.includes('Bob'), reset.names.join())
  check('a member cannot clear the room', reset.ignored.join() === 'before', reset.ignored.join(' | '))

  const pics = await page.evaluate(async () => {
    const { imageLinks } = await import('/src/ui/chat-panel.ts')
    return {
      gif: imageLinks('look https://example.com/cat.gif'),
      query: imageLinks('https://media.example.com/a/b.gif?width=200'),
      png: imageLinks('https://example.com/shot.png and https://example.com/x.webp'),
      plain: imageLinks('https://example.com/article'),
      insecure: imageLinks('http://example.com/cat.gif'),
      capped: imageLinks(
        [1, 2, 3, 4, 5, 6].map((n) => `https://example.com/${n}.gif`).join(' '),
      ).length,
      tricked: imageLinks('https://example.com/cat.gif.exe'),
    }
  })
  check('a GIF link becomes a GIF', pics.gif.length === 1, pics.gif.join())
  check('and one with a query string still does', pics.query.length === 1)
  check('so do the other picture kinds', pics.png.length === 2)
  check('an ordinary link is left as a link', pics.plain.length === 0)
  check('an insecure link is never fetched', pics.insecure.length === 0)
  check('and one message cannot post a wall of them', pics.capped === 4, `${pics.capped}`)
  check('something dressed up as a picture is not one', pics.tricked.length === 0)

  const mic = await page.evaluate(async () => {
    const { micConstraints, micSettings, setMicSettings } = await import('/src/net/mic.ts')
    const before = micConstraints()
    setMicSettings({ ...micSettings(), denoise: false })
    const after = micConstraints()
    setMicSettings({ echo: true, denoise: true, gain: true })
    return { before, after }
  })
  check(
    'the microphone is cleaned up by default',
    mic.before.noiseSuppression === true && mic.before.echoCancellation === true,
    JSON.stringify(mic.before),
  )
  check('and the cleaning can be turned off for music', mic.after.noiseSuppression === false)

  const sounds = await page.evaluate(async () => {
    const { isNews, soundsOn, setSounds } = await import('/src/ui/sounds.ts')
    const on = soundsOn()
    setSounds(false)
    const off = soundsOn() === false
    setSounds(on)
    return {
      backfillIsQuiet: isNews(Date.now() - 10 * 60_000) === false,
      freshIsNews: isNews(Date.now() - 1000),
      canBeTurnedOff: off,
    }
  })
  check('history arriving from a peer makes no noise', sounds.backfillIsQuiet)
  check('something said just now does', sounds.freshIsNews)
  check('and the whole lot can be turned off', sounds.canBeTurnedOff)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
