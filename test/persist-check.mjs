/**
 * Will it still be there tomorrow?
 *
 * The claim is that history survives because you hold it, not because a server
 * does. So this proves the hard version: two people talk, the host goes away
 * entirely, the viewer reloads, and the conversation is still on screen with
 * nothing to connect to.
 *
 *   node test/persist-check.mjs
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const STUB = `(() => {
  const c = document.createElement('canvas')
  c.width = 1280; c.height = 720
  const x = c.getContext('2d')
  let f = 0
  setInterval(() => {
    f++
    x.fillStyle = '#123'; x.fillRect(0, 0, 1280, 720)
    x.fillStyle = '#0c8'; x.fillRect((f * 9) % 1180, 260, 100, 100)
  }, 33)
  const s = c.captureStream(30)
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(s.getVideoTracks())
})()`

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
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)}`)
}

const hostBrowser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream'],
})
// The viewer keeps its profile on disk, so a reload finds the same IndexedDB.
const viewerBrowser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
})

try {
  const host = await (await hostBrowser.newContext()).newPage()
  await host.addInitScript(STUB)
  await host.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await host.getByRole('button', { name: 'New space' }).click()
  await host.getByRole('button', { name: 'Share screen' }).click()
  await host.locator('.share-code').waitFor({ timeout: 15_000 })
  const link = await host.locator('.share-code').getAttribute('data-link')

  const viewerContext = await viewerBrowser.newContext()
  const viewer = await viewerContext.newPage()
  await viewer.goto(link, { waitUntil: 'domcontentloaded' })

  // A viewer is offered the stream and asks for it. Nothing arrives unasked.
  await waitFor(
    async () =>
      viewer.evaluate(() => {
        const button = [...document.querySelectorAll('.stream-tab')].find((b) =>
          b.textContent.startsWith('Watch'),
        )
        if (!button) return null
        button.click()
        return true
      }),
    45_000,
    'the viewer to be offered the stream',
  )
  await waitFor(
    async () => viewer.evaluate(() => (document.querySelector('video')?.videoWidth ?? 0) > 0 || null),
    45_000,
    'the viewer to connect',
  )

  await viewer.fill('input[aria-label="Write a message"]', 'this should outlive the host')
  await viewer.press('input[aria-label="Write a message"]', 'Enter')
  await host.fill('input[aria-label="Write a message"]', 'so should this')
  await host.press('input[aria-label="Write a message"]', 'Enter')

  await waitFor(
    async () =>
      viewer.evaluate(() =>
        (document.querySelector('.chat-log')?.textContent ?? '').includes('so should this')
          ? true
          : null,
      ),
    15_000,
    'both lines to reach the viewer',
  )
  check('both people can see both lines while connected', true)

  // Signatures are checked, not assumed.
  const forged = await viewer.evaluate(async () => {
    const { openEvent } = await import('/src/store/log.ts')
    const { makeEvent } = await import('/src/store/log.ts')
    const real = await makeEvent('room', 'a'.repeat(64), 1, 'said', { text: 'hi' })
    const tamperedText = { ...real, body: { text: 'not what was signed' } }
    const tamperedSig = { ...real, sig: 'f'.repeat(128) }
    return {
      text: (await openEvent(tamperedText, 'room')) === null,
      sig: (await openEvent(tamperedSig, 'room')) === null,
      wrongRoom: (await openEvent(real, 'other')) === null,
    }
  })
  check(
    'a tampered event is refused',
    forged.text && forged.sig && forged.wrongRoom,
    JSON.stringify(forged),
  )

  // The host leaves the world entirely.
  await hostBrowser.close()
  await viewer.waitForTimeout(1500)

  // A fresh page in the same profile: nothing to connect to, nothing in memory.
  const revisit = await viewerContext.newPage()
  await viewer.close()
  await revisit.goto(link, { waitUntil: 'domcontentloaded' })

  const restored = await waitFor(
    async () =>
      revisit.evaluate(() => {
        const text = document.querySelector('.chat-log')?.textContent ?? ''
        return text.includes('this should outlive the host') ? text : null
      }),
    15_000,
    'the stored conversation to be read back',
  )
  check('history is there with the host gone', restored.includes('this should outlive the host'))
  check('the other side of the conversation survived too', restored.includes('so should this'))

  const offline = await revisit.evaluate(() => ({
    connected: (document.querySelector('video')?.videoWidth ?? 0) > 0,
    lines: document.querySelectorAll('.chat-line').length,
  }))
  check(
    'and it is there without any connection at all',
    !offline.connected && offline.lines >= 2,
    `${offline.lines} lines, video connected: ${offline.connected}`,
  )
} finally {
  await viewerBrowser.close()
  await hostBrowser.close().catch(() => undefined)
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} of ${results.length} checks passed.`)
process.exit(failed === 0 ? 0 : 1)
