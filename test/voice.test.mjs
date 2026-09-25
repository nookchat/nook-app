import { APP_URL, FAKE_MEDIA, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

async function waitFor(fn, ms, label) {
  const found = await poll(fn, ms, 400)
  if (!found) throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(found)}`)
  return found
}

const browser = await launch({ args: FAKE_MEDIA })

try {
  const one = await (await browser.newContext()).newPage()
  await one.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await one.getByRole('button', { name: 'New space' }).waitFor({ timeout: 10_000 })
  await one.getByRole('button', { name: 'New space' }).click()
  await one.waitForSelector('[aria-label="Write a message"]', { timeout: 15_000 })
  await one.waitForTimeout(800)
  // The address bar is the invite.
  const link = one.url()

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

  // A connection can reach "connected" while audio travels one way only.
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

  // The fake microphone beeps, so a second of listening hears something.
  const loudness = (page) =>
    page.evaluate(async () => {
      const sink = [...document.querySelectorAll('audio.voice-sink')].find((a) => a.srcObject)
      if (!sink) return { playing: false, peak: 0 }
      const ctx = new AudioContext()
      await ctx.resume()
      const analyser = ctx.createAnalyser()
      ctx.createMediaStreamSource(sink.srcObject).connect(analyser)
      const data = new Float32Array(analyser.fftSize)
      let peak = 0
      const end = performance.now() + 2500
      while (performance.now() < end) {
        analyser.getFloatTimeDomainData(data)
        for (const v of data) peak = Math.max(peak, Math.abs(v))
        await new Promise((r) => setTimeout(r, 50))
      }
      await ctx.close()
      return { playing: !sink.paused, peak: Math.round(peak * 1000) / 1000 }
    })
  const twoHears = await loudness(two)
  const oneHears = await loudness(one)
  check(
    'and what arrives is sound, playing, both ways',
    twoHears.playing && twoHears.peak > 0.01 && oneHears.playing && oneHears.peak > 0.01,
    `${JSON.stringify(twoHears)} ${JSON.stringify(oneHears)}`,
  )

  const seenByOne = await waitFor(
    async () =>
      one.evaluate(() => document.querySelectorAll('.voice-member').length || null),
    20_000,
    'the voice roster to fill in',
  )
  check('the channel shows who is standing in it', seenByOne >= 2, `${seenByOne} listed`)

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

  // The fake microphone plays a tone, so both of them make a noise the whole time.
  const lit = await waitFor(
    async () =>
      one.evaluate(() =>
        document.querySelectorAll('.voice-member.talking, .pill.talking').length,
      ),
    15_000,
    'somebody to be shown as talking',
  ).catch(() => 0)
  check('somebody making a noise is shown as talking', lit > 0, `${lit} lit`)

  // The space's own voice bar, not the dock, which is for voice somewhere else.
  await one.click('.voice-bar:not(.voice-dock) button[aria-label="Mute"]')
  await one.waitForTimeout(1500)
  const afterMute = await one.evaluate(() => {
    const rows = [...document.querySelectorAll('.voice-member')]
    const mine = rows.find((r) => (r.textContent ?? '').includes('(you)'))
    return mine ? mine.classList.contains('talking') : null
  })
  check('and muting puts your own light out', afterMute === false, `${afterMute}`)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
