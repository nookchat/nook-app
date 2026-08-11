/**
 * Voice channels, and the promise that a name is only a label.
 *
 * Two people join the same voice channel and must actually hear each other,
 * which means an inbound audio track that is live. Then one of them renames
 * themselves, and every message they ever wrote must follow, because the log
 * attributes messages to a key and looks the name up at the last moment.
 *
 *   node test/voice-check.mjs
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
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})

try {
  // Separate contexts, so the two people have separate identities.
  const one = await (await browser.newContext()).newPage()
  await one.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await one.getByRole('button', { name: 'New space' }).waitFor({ timeout: 10_000 })
  await one.getByRole('button', { name: 'New space' }).click()
  await one.locator('.share-code').waitFor({ timeout: 15_000 })
  const link = await one.locator('.share-code').getAttribute('data-link')

  const two = await (await browser.newContext()).newPage()
  await two.goto(link, { waitUntil: 'domcontentloaded' })

  await waitFor(
    async () =>
      two.evaluate(() => {
        const m = (document.querySelector('.chat-panel .pill')?.textContent ?? '').match(/(\d+) here/)
        return m && Number(m[1]) >= 2 ? true : null
      }),
    45_000,
    'the mesh to come up',
  )

  const voiceChannels = await one.evaluate(() =>
    Array.from(document.querySelectorAll('.voice-channel .rail-item')).map((b) =>
      (b.textContent ?? '').trim(),
    ),
  )
  check('a space has voice channels', voiceChannels.length > 0, voiceChannels.join(', '))

  // Both walk into the same voice channel.
  await one.locator('.voice-channel .rail-item').first().click()
  await two.locator('.voice-channel .rail-item').first().click()

  const heard = await waitFor(
    async () =>
      two.evaluate(() => {
        const audios = Array.from(document.querySelectorAll('audio'))
        const live = audios.filter((a) => {
          const s = a.srcObject
          return s && s.getAudioTracks().some((t) => t.readyState === 'live')
        })
        return live.length > 0 ? live.length : null
      }),
    45_000,
    'an inbound voice track',
  )
  check('two people in a voice channel hear each other', heard > 0, `${heard} inbound streams`)

  const seenByOne = await waitFor(
    async () =>
      one.evaluate(() => document.querySelectorAll('.voice-member').length || null),
    20_000,
    'the voice roster to fill in',
  )
  check('the channel shows who is standing in it', seenByOne >= 2, `${seenByOne} listed`)

  // Now the part that matters for syncing: a name is a label on a key.
  await two.fill('input[aria-label="Write a message"]', 'before the rename')
  await two.press('input[aria-label="Write a message"]', 'Enter')
  await waitFor(
    async () =>
      one.evaluate(() =>
        (document.querySelector('.chat-log')?.textContent ?? '').includes('before the rename')
          ? true
          : null,
      ),
    20_000,
    'the message to arrive',
  )

  const oldName = await two.evaluate(
    () => document.querySelector('.chat-line .chat-name')?.textContent ?? '',
  )

  await two.getByRole('button', { name: 'Settings' }).click()
  await two.fill('input[aria-label="Your name"]', 'Renamed Person')
  await two.getByRole('button', { name: 'Save name' }).click()

  const renamed = await waitFor(
    async () =>
      one.evaluate(() => {
        const text = document.querySelector('.chat-log')?.textContent ?? ''
        return text.includes('Renamed Person') && text.includes('before the rename') ? text : null
      }),
    25_000,
    'the rename to reach the other person',
  )
  check(
    'renaming yourself renames your old messages too',
    renamed.includes('Renamed Person'),
    `was ${oldName.trim()}`,
  )
  check(
    'and the message itself is untouched',
    renamed.includes('before the rename'),
  )
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} of ${results.length} checks passed.`)
process.exit(failed === 0 ? 0 : 1)
