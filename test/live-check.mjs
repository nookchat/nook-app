/**
 * Two screens at once, and moving somebody between voice channels.
 *
 * Neither of these can be checked without two real browsers. More than one
 * person sharing was always possible in the wiring and never possible in the
 * window: a watcher attached to whoever announced first and had no way to look
 * at anybody else, and the second person's offer would pull the screen out
 * from under the first. Moving somebody is a message off a public relay, so
 * the interesting part is that it is refused when it should be.
 *
 *   node test/live-check.mjs
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function waitFor(fn, ms, label) {
  const until = Date.now() + ms
  let last
  while (Date.now() < until) {
    last = await fn()
    if (last) return last
    await new Promise((r) => setTimeout(r, 400))
  }
  console.log(`  (gave up waiting for ${label}: ${JSON.stringify(last)})`)
  return null
}

/** A fake display, so a share needs no permission and no real screen. */
const DISPLAY_STUB = `
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const ctx = canvas.getContext('2d')
    setInterval(() => {
      ctx.fillStyle = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
      ctx.fillRect(0, 0, 640, 360)
    }, 100)
    return canvas.captureStream(10)
  }
`

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-running-insecure-content',
  ],
})

try {
  const open = async (name) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
    await context.grantPermissions(['microphone'], { origin: new URL(APP_URL).origin })
    const page = await context.newPage()
    await page.addInitScript(DISPLAY_STUB)
    await page.goto(APP_URL)
    await page.evaluate((n) => localStorage.setItem('cathode.name.v1', n), name)
    await page.reload()
    await page.waitForTimeout(700)
    return page
  }

  const alice = await open('Alice')
  await alice.evaluate(
    () => (document.querySelector('input[aria-label="Space name"]').value = 'Live'),
  )
  await alice.getByRole('button', { name: 'New space' }).click()
  await alice.waitForTimeout(2500)
  const link = alice.url()

  const bob = await open('Bob')
  await bob.goto(link)
  await bob.reload()
  await bob.waitForTimeout(1500)

  const carol = await open('Carol')
  await carol.goto(link)
  await carol.reload()
  await carol.waitForTimeout(1500)

  const together = await waitFor(
    async () => (await alice.evaluate(() => document.querySelectorAll('.rail-person').length)) === 3,
    30_000,
    'all three to see each other',
  )
  check('three people in one space', !!together)

  // ---- two screens at once -------------------------------------------------
  await alice.getByRole('button', { name: 'Share screen' }).click()
  await alice.waitForTimeout(1500)
  await bob.getByRole('button', { name: 'Share screen' }).click()
  await bob.waitForTimeout(2500)

  const tabs = await waitFor(
    async () =>
      carol.evaluate(() => {
        const bar = document.querySelector('.stream-bar')
        if (!bar || bar.classList.contains('hidden')) return null
        return [...bar.querySelectorAll('.stream-tab')].map((b) => ({
          name: b.textContent.trim(),
          on: b.classList.contains('on'),
        }))
      }),
    30_000,
    'Carol to be offered a choice of two',
  )
  check(
    'two people sharing at once gives the third a choice',
    !!tabs && tabs.length === 2,
    tabs ? tabs.map((t) => `${t.name}${t.on ? '*' : ''}`).join(' | ') : 'no bar',
  )

  // Neither is on her screen. Two people sharing is two offers, not two
  // pictures arriving unasked.
  const quiet = await carol.evaluate(() => ({
    video: !!document.querySelector('video'),
    pressed: !!document.querySelector('.stream-tab.on'),
  }))
  check(
    'and neither is on her screen until she asks',
    quiet.video === false && quiet.pressed === false,
    JSON.stringify(quiet),
  )

  const first = await carol.evaluate(() => {
    const button = [...document.querySelectorAll('.stream-tab')].find(
      (b) => b.dataset.watch === 'peer',
    )
    if (!button) return null
    const name = button.textContent.trim()
    button.click()
    return name
  })
  const watchingFirst = await waitFor(
    async () =>
      carol.evaluate(() => {
        const el = document.querySelector('video')
        return el && el.videoWidth > 0 && !el.paused ? el.videoWidth : null
      }),
    30_000,
    'the first stream she picked',
  )
  check(
    'picking one puts it on her screen',
    !!watchingFirst,
    `${first}, ${watchingFirst ?? 0}px wide`,
  )

  // Switch to the other one, and check the picture comes back.
  const switched = await carol.evaluate(() => {
    const off = [...document.querySelectorAll('.stream-tab')].find(
      (b) => b.dataset.watch === 'peer' && !b.classList.contains('on'),
    )
    if (!off) return null
    const name = off.textContent.trim()
    off.click()
    return name
  })
  check('the other one can be picked', !!switched, switched ?? 'nothing to pick')

  const watchingSecond = await waitFor(
    async () =>
      carol.evaluate(() => {
        const el = document.querySelector('video')
        const on = document.querySelector('.stream-tab.on')?.textContent.trim() ?? ''
        return el && el.videoWidth > 0 && !el.paused && on ? { w: el.videoWidth, on } : null
      }),
    30_000,
    'the second stream to arrive',
  )
  check(
    'and switching to it brings a picture back',
    !!watchingSecond && watchingSecond.on === switched,
    watchingSecond ? `${watchingSecond.on}, ${watchingSecond.w}px wide` : 'no picture',
  )

  // And a way back off it again.
  const stopped = await carol.evaluate(async () => {
    const off = [...document.querySelectorAll('.stream-tab')].find(
      (b) => b.textContent.trim() === 'Stop watching',
    )
    if (!off) return null
    off.click()
    await new Promise((r) => setTimeout(r, 1200))
    return { video: !!document.querySelector('video'), pressed: !!document.querySelector('.stream-tab.on') }
  })
  check(
    'and she can take it back off again',
    stopped !== null && stopped.pressed === false,
    JSON.stringify(stopped),
  )

  // ---- both sharing, watching each other -----------------------------------
  /*
   * The two-connection trap. Alice and Bob are both sharing, and now each
   * watches the other, so each pair of browsers holds two connections at
   * once: I host yours while I view mine. Every ICE line has to land on the
   * connection it belongs to. Routing them by sender fed both connections'
   * lines to the hosting one, the viewing one starved, and the stage was a
   * black rectangle until a reload emptied the watchers map.
   */
  const watchTheOther = async (page, name) => {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.stream-tab')].find(
        (x) => x.dataset.watch === 'peer',
      )
      b?.click()
    })
    return waitFor(
      async () =>
        page.evaluate(() => {
          const tag = document.querySelector('.stage-tag')?.textContent ?? ''
          const el = document.querySelector('video')
          return el && el.videoWidth > 0 && !el.paused && tag.startsWith('Watching')
            ? `${tag}, ${el.videoWidth}px`
            : null
        }),
      30_000,
      `${name} to see the other sharer's picture`,
    )
  }
  const aliceSees = await watchTheOther(alice, 'Alice')
  const bobSees = await watchTheOther(bob, 'Bob')
  check(
    'two sharers can watch each other at the same time',
    !!aliceSees && !!bobSees,
    `${aliceSees ?? 'nothing'} | ${bobSees ?? 'nothing'}`,
  )

  // ---- moving somebody between voice channels ------------------------------
  await alice.getByRole('button', { name: 'lounge' }).first().click()
  await alice.waitForTimeout(1500)
  await bob.getByRole('button', { name: 'lounge' }).first().click()
  await bob.waitForTimeout(2000)

  /*
   * The actions live behind the ellipsis on somebody's row now, so the check
   * opens the menu and reads what it offers, which is what a person does.
   */
  const menuFor = async (page, who) => {
    const row = page.locator('.rail-person', { hasText: who })
    const more = row.locator('.person-more')
    if ((await more.count()) === 0) return []
    await more.first().evaluate((el) => el.focus())
    await more.first().click()
    await page.waitForSelector('.menu', { timeout: 5000 })
    const items = await page.$$eval('.menu-item', (els) =>
      els.map((e) => e.textContent.trim().split('\n')[0]),
    )
    await page.keyboard.press('Escape')
    return items
  }

  const canMove = await waitFor(
    async () => {
      const items = await menuFor(alice, 'Bob')
      return items.some((t) => t.startsWith('Move to')) ? items : null
    },
    20_000,
    'the move action to appear for the admin',
  )
  check('an admin standing in a voice channel can move people to it', !!canMove, (canMove ?? []).join(' | '))

  // Bob is a member, so he is offered nothing that changes anybody else.
  const bobOffered = await menuFor(bob, 'Alice')
  check(
    'a member is never offered it',
    !bobOffered.some((t) => t.startsWith('Move to')) && !bobOffered.some((t) => t.includes('admin')),
    bobOffered.join(' | ') || 'nothing',
  )

  /*
   * The move itself. Alice makes a second voice channel, stands in it, and
   * moves Bob. The ask travels signed, Bob's device checks the signature
   * against the log's admins, and his microphone is already open, so he lands
   * in the new channel without being asked anything.
   */
  alice.once('dialog', (d) => d.accept('war-room'))
  await alice.click('button[title="Make a voice channel"]')
  await alice.getByRole('button', { name: 'war-room' }).first().click()
  await alice.waitForTimeout(1500)

  const bobRow = alice.locator('.rail-person', { hasText: 'Bob' })
  await bobRow.locator('.person-more').first().evaluate((el) => el.focus())
  await bobRow.locator('.person-more').first().click()
  await alice.waitForSelector('.menu', { timeout: 5000 })
  await alice.click('.menu-item:has-text("Move to war-room")')

  const moved = await waitFor(
    async () => {
      const where = await bob.$eval('.voice-bar', (el) => el.textContent).catch(() => '')
      return where.includes('war-room') ? where : null
    },
    20_000,
    'Bob to land in the channel he was moved to',
  )
  check('and the move lands, signed and checked', !!moved, moved ?? 'nowhere')
} finally {
  await browser.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} checks passed.`)
process.exit(passed === results.length ? 0 : 1)
