import { APP_URL, FAKE_MEDIA, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

// A fake display, so a share needs no permission and no real screen.
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

const browser = await launch({ args: [...FAKE_MEDIA, '--allow-running-insecure-content'] })

try {
  const open = async (name) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
    await context.grantPermissions(['microphone'], { origin: new URL(APP_URL).origin })
    const page = await context.newPage()
    await page.addInitScript(DISPLAY_STUB)
    await page.goto(APP_URL)
    await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
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

  const together = await poll(
    async () => (await alice.evaluate(() => document.querySelectorAll('.rail-person').length)) === 3,
    30_000,
  )
  check('three people in one space', !!together)

  // A screen is shared from voice, so both sharers stand in the lounge first.
  for (const page of [alice, bob]) {
    await page.click('.voice-channel .rail-item:has-text("lounge")')
    await page.waitForSelector('.voice-bar:not(.hidden)', { timeout: 15_000 })
  }
  await alice.click('button[aria-label="Share screen"]')
  await alice.waitForTimeout(1500)
  await bob.click('button[aria-label="Share screen"]')
  await bob.waitForTimeout(2500)

  const tabs = await poll(
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
  )
  check(
    'two people sharing at once gives the third a choice',
    !!tabs && tabs.length === 2,
    tabs ? tabs.map((t) => `${t.name}${t.on ? '*' : ''}`).join(' | ') : 'no bar',
  )

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
  const watchingFirst = await poll(
    async () =>
      carol.evaluate(() => {
        const el = document.querySelector('video')
        return el && el.videoWidth > 0 && !el.paused ? el.videoWidth : null
      }),
    30_000,
  )
  check(
    'picking one puts it on her screen',
    !!watchingFirst,
    `${first}, ${watchingFirst ?? 0}px wide`,
  )

  const second = await carol.evaluate(() => {
    const off = [...document.querySelectorAll('.stream-tab')].find(
      (b) => b.dataset.watch === 'peer' && !b.classList.contains('on'),
    )
    if (!off) return null
    const name = off.textContent.trim()
    off.click()
    return name
  })
  check('the other one can be picked as well', !!second, second ?? 'nothing to pick')

  const split = await poll(
    async () =>
      carol.evaluate(() => {
        const tiles = [...document.querySelectorAll('.stage-tile video')]
        const playing = tiles.filter((el) => el.videoWidth > 0 && !el.paused)
        const pressed = document.querySelectorAll('.stream-tab.on').length
        return playing.length === 2 && pressed === 2
          ? `${playing.length} pictures, ${pressed} cards pressed`
          : null
      }),
    30_000,
  )
  check('and the stage splits to show both at once', !!split, split ?? 'no split')

  const stopped = await carol.evaluate(async () => {
    const off = [...document.querySelectorAll('.stream-tab')].find(
      (b) => b.textContent.trim() === 'Close',
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

  const watchTheOther = async (page, name) => {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.stream-tab')].find(
        (x) => x.dataset.watch === 'peer',
      )
      b?.click()
    })
    return poll(
      async () =>
        page.evaluate(() => {
          // Their own preview is a tile too, so look for the watched one.
          for (const tile of document.querySelectorAll('.stage-tile')) {
            const tag = tile.querySelector('.stage-tag')?.textContent ?? ''
            const el = tile.querySelector('video')
            if (!tag.startsWith('Your screen') && el && el.videoWidth > 0 && !el.paused) {
              return `${tag}, ${el.videoWidth}px`
            }
          }
          return null
        }),
      30_000,
    )
  }
  const aliceSees = await watchTheOther(alice, 'Alice')
  const bobSees = await watchTheOther(bob, 'Bob')
  check(
    'two sharers can watch each other at the same time',
    !!aliceSees && !!bobSees,
    `${aliceSees ?? 'nothing'} | ${bobSees ?? 'nothing'}`,
  )

  // Both are still in the lounge from sharing.
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

  const canMove = await poll(
    async () => {
      const items = await menuFor(alice, 'Bob')
      return items.some((t) => t.startsWith('Move to')) ? items : null
    },
    20_000,
  )
  check('an admin standing in a voice channel can move people to it', !!canMove, (canMove ?? []).join(' | '))

  const bobOffered = await menuFor(bob, 'Alice')
  check(
    'a member is never offered it',
    !bobOffered.some((t) => t.startsWith('Move to')) && !bobOffered.some((t) => t.includes('admin')),
    bobOffered.join(' | ') || 'nothing',
  )

  alice.once('dialog', (d) => d.accept('war-room'))
  await alice.click('button[title="Make a voice channel"]')
  await alice.getByRole('button', { name: 'war-room' }).first().click()
  await alice.waitForTimeout(1500)

  const bobRow = alice.locator('.rail-person', { hasText: 'Bob' })
  await bobRow.locator('.person-more').first().evaluate((el) => el.focus())
  await bobRow.locator('.person-more').first().click()
  await alice.waitForSelector('.menu', { timeout: 5000 })
  await alice.click('.menu-item:has-text("Move to war-room")')

  const moved = await poll(
    async () => {
      const where = await bob.$eval('.voice-bar:not(.voice-dock)', (el) => el.textContent).catch(() => '')
      return where.includes('war-room') ? where : null
    },
    20_000,
  )
  check('and the move lands, signed and checked', !!moved, moved ?? 'nowhere')
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
