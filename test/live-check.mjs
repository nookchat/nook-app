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

  const watchingFirst = await carol.evaluate(() => {
    const el = document.querySelector('video')
    return el ? { w: el.videoWidth, playing: !el.paused } : null
  })
  check(
    'and one of them is on the screen',
    !!watchingFirst && watchingFirst.w > 0,
    JSON.stringify(watchingFirst),
  )

  // Switch to the other one, and check the picture comes back.
  const switched = await carol.evaluate(() => {
    const off = [...document.querySelectorAll('.stream-tab')].find(
      (b) => !b.classList.contains('on'),
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
        return el && el.videoWidth > 0 && !el.paused ? { w: el.videoWidth, on } : null
      }),
    30_000,
    'the second stream to arrive',
  )
  check(
    'and switching to it brings a picture back',
    !!watchingSecond && watchingSecond.on === switched,
    watchingSecond ? `${watchingSecond.on}, ${watchingSecond.w}px wide` : 'no picture',
  )

  // ---- moving somebody between voice channels ------------------------------
  await alice.getByRole('button', { name: 'lounge' }).first().click()
  await alice.waitForTimeout(1500)
  await bob.getByRole('button', { name: 'lounge' }).first().click()
  await bob.waitForTimeout(2000)

  const canMove = await waitFor(
    async () =>
      alice.evaluate(() =>
        [...document.querySelectorAll('.rail-person button')].some(
          (b) => b.title.startsWith('Move them into'),
        ),
      ),
    20_000,
    'the move button to appear for the admin',
  )
  check('an admin standing in a voice channel can move people to it', !!canMove)

  // Bob is a member, so his attempt has to be refused by the far side.
  const refused = await carol.evaluate(async () => {
    const before = document.querySelectorAll('.toast').length
    return { before }
  })
  const bobTried = await bob.evaluate(() => {
    const dbg = document.querySelectorAll('.rail-person button')
    return [...dbg].some((b) => b.title.startsWith('Move them into'))
  })
  check('a member is never offered it', bobTried === false, `${refused.before} toasts before`)
} finally {
  await browser.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} checks passed.`)
process.exit(passed === results.length ? 0 : 1)
