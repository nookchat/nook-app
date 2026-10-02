import { APP_URL, FAKE_MEDIA, check, finish, launch, openSettingsTab, poll, stoppedEarly } from './harness.mjs'

// Each voice of the voice changer is made in an offline context and fed a loud made-up vowel. What
// comes out must be sound, not silence, not numbers gone wrong, and not so loud that it clips.
const browser = await launch({ args: FAKE_MEDIA })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('  [page error]', String(e)))
await page.goto(APP_URL)

try {
  const results = await page.evaluate(async (level) => {
    const { VOICES } = await import('/src/net/mic.ts')
    const { buildVoice } = await import('/src/net/voice-effects.ts')
    const rate = 48000
    const seconds = 2
    const out = []
    for (const { id } of VOICES) {
      const ctx = new OfflineAudioContext(1, rate * seconds, rate)
      const vowel = ctx.createBuffer(1, rate * seconds, rate)
      const data = vowel.getChannelData(0)
      for (let i = 0; i < data.length; i++) {
        const t = i / rate
        data[i] = level * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t) + 0.3 * Math.sin(2 * Math.PI * 700 * t))
      }
      const source = ctx.createBufferSource()
      source.buffer = vowel
      try {
        const effect = await buildVoice(ctx, id)
        if (effect) {
          source.connect(effect.input)
          effect.output.connect(ctx.destination)
        } else source.connect(ctx.destination)
        source.start()
        const rendered = (await ctx.startRendering()).getChannelData(0)
        // The first tenth of a second is left out, while the effects fill up.
        const tail = rendered.subarray(rate / 10)
        let sum = 0
        let peak = 0
        let finite = true
        for (const v of tail) {
          if (!Number.isFinite(v)) finite = false
          sum += v * v
          peak = Math.max(peak, Math.abs(v))
        }
        out.push({ id, finite, rms: Math.sqrt(sum / tail.length), peak })
      } catch (err) {
        out.push({ id, error: String(err) })
      }
    }
    return out
  }, 0.5)

  for (const r of results) {
    if (r.error) {
      check(`${r.id} is made`, false, r.error)
      continue
    }
    const detail = `rms ${r.rms.toFixed(3)}, peak ${r.peak.toFixed(2)}`
    check(`${r.id} gives sound`, r.finite && r.rms > 0.02, detail)
    check(`${r.id} does not clip`, r.peak < 1.5, detail)
  }
  check('every voice was tried', results.length === 18, `${results.length} voices`)

  // Preview my voice opens the mic and plays it back, and a voice chosen meanwhile is heard at once.
  await openSettingsTab(page, 'voice')
  const preview = page.locator('.voice-preview button')
  await preview.click()
  const playing = await poll(
    () => page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => a.srcObject && !a.muted)),
    10_000,
  )
  check('Preview my voice plays the mic back', playing)
  check('the preview can be stopped', (await preview.textContent()).includes('Stop preview'))
  check('Hear yourself is on with it', await page.locator('.mic-test button.on', { hasText: 'Hear yourself' }).isVisible())
  await page.locator('.voice-choice', { hasText: 'Goat' }).click()
  check('a voice can be chosen while it plays', await page.locator('.voice-choice.on', { hasText: 'Goat' }).isVisible())
  await preview.click()
  const quiet = await page.evaluate(() => ![...document.querySelectorAll('audio')].some((a) => a.srcObject && !a.muted))
  check('Stop preview stops the playback', quiet && (await preview.textContent()).includes('Preview my voice'))
} catch (err) {
  stoppedEarly(err)
}

await browser.close()
finish()
