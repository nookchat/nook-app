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

  // A voice put away stops its processors. One that ran on, with nothing joined to it, stayed on the
  // audio thread until the call ended, and enough of them made the voice crackle. A probe loaded
  // first into the same worklet counts the process calls of every other processor.
  const live = await page.evaluate(async () => {
    const probe = URL.createObjectURL(
      new Blob(
        [
          `globalThis.calls = 0
          const register = globalThis.registerProcessor
          globalThis.registerProcessor = (name, kind) => {
            const process = kind.prototype.process
            kind.prototype.process = function (...args) { globalThis.calls++; return process.apply(this, args) }
            register(name, kind)
          }
          register('probe', class extends AudioWorkletProcessor {
            constructor() { super(); this.port.onmessage = () => this.port.postMessage(globalThis.calls) }
            process() { return true }
          })`,
        ],
        { type: 'text/javascript' },
      ),
    )
    const addModule = AudioWorklet.prototype.addModule
    const source = AudioContext.prototype.createMediaStreamSource
    let ctx = null
    AudioWorklet.prototype.addModule = async function (url, options) {
      if (!this.probed) {
        this.probed = true
        await addModule.call(this, probe)
      }
      return addModule.call(this, url, options)
    }
    AudioContext.prototype.createMediaStreamSource = function (stream) {
      ctx = this
      return source.call(this, stream)
    }
    const { shape } = await import('/src/net/shaper.ts')
    const { changeMic } = await import('/src/net/mic.ts')
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
    const shaped = shape(mic)
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
    for (const voice of ['clones', 'deep', 'demon', 'retro', 'goat']) {
      changeMic({ voice })
      await sleep(400)
    }
    changeMic({ voice: 'off' })
    await sleep(300)
    const node = new AudioWorkletNode(ctx, 'probe')
    node.connect(ctx.destination)
    const count = () =>
      new Promise((done) => {
        node.port.onmessage = (ev) => done(ev.data)
        node.port.postMessage('count')
      })
    const before = await count()
    await sleep(1000)
    const calls = (await count()) - before
    shaped.close()
    mic.getTracks().forEach((t) => t.stop())
    AudioWorklet.prototype.addModule = addModule
    AudioContext.prototype.createMediaStreamSource = source
    return calls
  })
  check('a voice changed or turned off leaves no processor running', live === 0, `${live} process calls in a second`)

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
