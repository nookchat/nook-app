import { answer, APP_URL, check, closeSettings, openSpaceSettings, FAKE_MEDIA, finish, HOME, launch, makeSpace, poll, stoppedEarly } from './harness.mjs'

// Somebody who keeps the channels drags them into an order, and everybody sees that order.
// Nobody else can: not in the page, and not by writing an order to the log.
const browser = await launch({ args: FAKE_MEDIA })

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.addInitScript((n) => localStorage.setItem('nook.name.v1', n), name)
  return context.newPage()
}

const textOrder = (page) => page.$$eval('.rail-row', (rows) => rows.map((r) => r.querySelector('.truncate')?.textContent ?? ''))
const voiceOrder = (page) => page.$$eval('.voice-channel .voice-join .truncate', (els) => els.map((e) => e.textContent))
const until = (page, fn, arg, ms = 15_000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false)
const orderIs = (wanted) => {
  const names = [...document.querySelectorAll('.rail-row')].map((r) => r.querySelector('.truncate')?.textContent ?? '')
  return names.join() === wanted
}
const voiceIs = (wanted) =>
  [...document.querySelectorAll('.voice-channel .voice-join .truncate')].map((e) => e.textContent).join() === wanted

try {
  const alice = await person('Alice')
  await alice.goto(APP_URL)
  await alice.waitForSelector(HOME)
  await makeSpace(alice, 'order')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(1200)
  await alice.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    const chat = spaces.all()[0].chat
    for (const name of ['alpha', 'bravo', 'charlie']) await chat.makeChannel(name)
    await chat.makeChannel('studio', true)
  })
  check('channels start by name', await until(alice, orderIs, 'alpha,bravo,charlie,general'), (await textOrder(alice)).join())

  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector('.space-name')
  await until(bob, orderIs, 'alpha,bravo,charlie,general')

  // Alice drags charlie to the top.
  await alice.locator('.rail-row', { hasText: 'charlie' }).dragTo(alice.locator('.rail-row', { hasText: 'alpha' }), {
    targetPosition: { x: 40, y: 4 },
  })
  check('a drag puts charlie at the top', await until(alice, orderIs, 'charlie,alpha,bravo,general'), (await textOrder(alice)).join())
  check('Bob sees the new order', await until(bob, orderIs, 'charlie,alpha,bravo,general'), (await textOrder(bob)).join())

  // Dropped on the lower half of alpha, general goes under it.
  await alice.locator('.rail-row', { hasText: 'general' }).dragTo(alice.locator('.rail-row', { hasText: 'alpha' }), {
    targetPosition: { x: 40, y: 26 },
  })
  check('dropped on the lower half of a channel, it goes under it', await until(alice, orderIs, 'charlie,alpha,general,bravo'), (await textOrder(alice)).join())

  // Voice channels too.
  await alice.locator('.voice-channel', { hasText: 'studio' }).dragTo(alice.locator('.voice-channel', { hasText: 'lounge' }), {
    targetPosition: { x: 40, y: 4 },
  })
  check('a voice channel can be dragged too', await until(alice, voiceIs, 'studio,lounge'), (await voiceOrder(alice)).join())
  check('and Bob sees that as well', await until(bob, voiceIs, 'studio,lounge'), (await voiceOrder(bob)).join())

  // The channel's settings have Move up and Move down, for a touch screen, which has no drag.
  await alice.click('.rail-row:has-text("bravo")', { button: 'right' })
  const menu = await alice.$$eval('.menu-item', (els) => els.map((e) => e.textContent ?? ''))
  check('the menu has no Move up or Move down', !menu.some((t) => t.includes('Move')), JSON.stringify(menu))
  await alice.click('.menu-item:has-text("Edit channel")')
  await alice.waitForSelector('.settings-nav-title:has-text("Channel settings")')
  check('the channel page has no Move up either: its place is in Space settings', (await alice.locator('.settings-page button:has-text("Move")').count()) === 0)
  await closeSettings(alice)
  await alice.locator('.rail-row', { hasText: 'bravo' }).dragTo(alice.locator('.rail-row', { hasText: 'general' }), {
    targetPosition: { x: 40, y: 4 },
  })
  check('a drag puts bravo back above general', await until(alice, orderIs, 'charlie,alpha,bravo,general'), (await textOrder(alice)).join())

  // A new channel goes after the ones in the order.
  await alice.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    await spaces.all()[0].chat.makeChannel('aaa')
  })
  check('a channel made later goes at the end', await until(alice, orderIs, 'charlie,alpha,bravo,general,aaa'), (await textOrder(alice)).join())

  // Bob is a member: nothing of his can be dragged, and an order he writes counts for nothing.
  const draggable = await bob.$$eval('.rail-row', (rows) => rows.some((r) => r.draggable))
  check('a member cannot drag a channel', !draggable)
  await bob.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    await spaces.all()[0].chat.orderChannels(['general', 'bravo', 'alpha', 'charlie', 'aaa'])
  })
  await alice.waitForTimeout(2000)
  check('an order a member writes is ignored, on every device', (await textOrder(alice)).join() === 'charlie,alpha,bravo,general,aaa' && (await textOrder(bob)).join() === 'charlie,alpha,bravo,general,aaa', `${(await textOrder(alice)).join()} / ${(await textOrder(bob)).join()}`)

  await alice.reload()
  await alice.waitForSelector('.space-name')
  check('the order is kept', await until(alice, orderIs, 'charlie,alpha,bravo,general,aaa'), (await textOrder(alice)).join())

  // Space settings has a Channels tab: every text and voice channel, in order, to drag or move.
  await openSpaceSettings(alice, 'channels')
  const listed = (page, title) =>
    page.$$eval(
      `.settings-section:has(.eyebrow:text-is("${title}")) .channel-order-row`,
      (rows) => rows.map((r) => r.querySelector('.switch-label')?.textContent ?? ''),
    )
  check('the Channels tab lists the text channels in order', (await listed(alice, 'Text channels')).join() === 'charlie,alpha,bravo,general,aaa', (await listed(alice, 'Text channels')).join())
  check('and the voice channels', (await listed(alice, 'Voice channels')).join() === 'studio,lounge', (await listed(alice, 'Voice channels')).join())
  await alice.click('button[aria-label="Move aaa up"]')
  check('an arrow there moves it, for everybody', await until(bob, orderIs, 'charlie,alpha,bravo,aaa,general'), (await textOrder(bob)).join())
  await alice
    .locator('.channel-order-row', { hasText: 'general' })
    .dragTo(alice.locator('.channel-order-row', { hasText: 'charlie' }), { targetPosition: { x: 40, y: 4 } })
  check('and so does a drag', await until(bob, orderIs, 'general,charlie,alpha,bravo,aaa'), (await textOrder(bob)).join())
  await alice.click('button[aria-label="Edit lounge"]')
  const opened = await alice.waitForSelector('.settings-nav-title:has-text("Channel settings")', { timeout: 5000 }).then(() => true, () => false)
  check('Edit opens the channel’s own settings', opened)
  await closeSettings(alice)
  const back = await poll(async () => (await listed(alice, 'Voice channels')).length === 2, 5000)
  check('and back from it is the Channels tab again', back)

  // Channels are made there too.
  await alice.click('button:has-text("Create text channel")')
  await answer(alice, 'zulu')
  const made = await poll(async () => (await listed(alice, 'Text channels')).includes('zulu'), 10_000)
  check('Create text channel makes one, and the list shows it', made, (await listed(alice, 'Text channels')).join())
  await alice.click('button:has-text("Create voice channel")')
  await answer(alice, 'quiet')
  const madeVoice = await poll(async () => (await listed(alice, 'Voice channels')).includes('quiet'), 10_000)
  check('and so does Create voice channel', madeVoice, (await listed(alice, 'Voice channels')).join())
  check('Bob gets both', await until(bob, (w) => [...document.querySelectorAll('.rail-row, .voice-join')].map((e) => e.textContent).join().includes(w), 'zulu') && (await bob.locator('.voice-join:has-text("quiet")').count()) === 1)
} catch (err) {
  stoppedEarly(err)
}

await browser.close()
finish()
