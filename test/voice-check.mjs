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
        const m = (document.querySelector('.status-bar')?.textContent ?? '').match(/(\d+) here/)
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
  check('the answering side hears the caller', heard > 0, `${heard} inbound streams`)

  /*
   * And the other way, which is the half that used to be missing. A connection
   * can reach "connected" while audio travels one way only, so checking both
   * directions is the only check worth having here.
   */
  const heardBack = await waitFor(
    async () =>
      one.evaluate(() => {
        const live = Array.from(document.querySelectorAll('audio')).filter((a) => {
          const s = a.srcObject
          return s && s.getAudioTracks().some((t) => t.readyState === 'live')
        })
        return live.length > 0 ? live.length : null
      }),
    30_000,
    'the caller to hear the answering side',
  )
  check('and the caller hears them back', heardBack > 0, `${heardBack} inbound streams`)

  const seenByOne = await waitFor(
    async () =>
      one.evaluate(() => document.querySelectorAll('.voice-member').length || null),
    20_000,
    'the voice roster to fill in',
  )
  check('the channel shows who is standing in it', seenByOne >= 2, `${seenByOne} listed`)

  // Now the part that matters for syncing: a name is a label on a key.
  await two.fill('[aria-label="Write a message"]', 'before the rename')
  await two.press('[aria-label="Write a message"]', 'Enter')
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

  /*
   * Talking shows. The fake microphone Chrome provides plays a tone, so both
   * of them are making a noise the whole time and both should light up. The
   * check that matters is the other way round: muting must put the light out,
   * because a light that is always on says nothing at all.
   */
  const lit = await waitFor(
    async () =>
      one.evaluate(() =>
        document.querySelectorAll('.voice-member.talking, .pill.talking').length,
      ),
    15_000,
    'somebody to be shown as talking',
  ).catch(() => 0)
  check('somebody making a noise is shown as talking', lit > 0, `${lit} lit`)

  await one.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      /mute/i.test(b.textContent ?? ''),
    )
    button?.click()
  })
  await one.waitForTimeout(1500)
  const afterMute = await one.evaluate(() => {
    const rows = [...document.querySelectorAll('.voice-member')]
    const mine = rows.find((r) => (r.textContent ?? '').includes('(you)'))
    return mine ? mine.classList.contains('talking') : null
  })
  check('and muting puts your own light out', afterMute === false, `${afterMute}`)

} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} of ${results.length} checks passed.`)
process.exit(failed === 0 ? 0 : 1)
