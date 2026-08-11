/**
 * The neural denoiser.
 *
 * Two things have to be true and neither is obvious from the code. The first
 * is that the module was read correctly: it is loaded as bare WebAssembly with
 * the emscripten loader thrown away, so the exports are single letters and the
 * mapping between them and the functions is a guess until something calls them.
 * The second is that it does something: a network that loads, runs, and returns
 * the sound unchanged is the same as no network at all.
 *
 *   node test/denoise-check.mjs
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

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const page = await browser.newPage()
page.on('console', (m) => console.log(`  [page ${m.type()}]`, m.text()))
page.on('pageerror', (e) => console.log('  [page error]', String(e)))
await page.goto(APP_URL)

try {
  // ---- the module, called directly ----------------------------------------
  /*
   * The same amount of sound twice: once as white noise, once as something
   * shaped like a voice. A network that simply turns everything down would
   * lose both equally, and would be a volume control with a model attached.
   * The claim is that it can tell them apart, so that is what is measured.
   */
  const raw = await page.evaluate(async () => {
    const bytes = await (await fetch('/rnnoise.wasm')).arrayBuffer()
    const module = await WebAssembly.compile(bytes)

    const run = (fill) => {
      let memory
      const instance = new WebAssembly.Instance(module, {
        a: {
          a: () => 0,
          b: (dest, src, num) => {
            new Uint8Array(memory.buffer).copyWithin(dest, src, src + num)
            return dest
          },
        },
      })
      const api = instance.exports
      memory = api.c
      api.d() // __wasm_call_ctors, which the discarded loader used to call
      const state = api.f(0)
      const buffer = api.g(480 * 4)
      if (!state || !buffer) return null

      const inLevels = []
      const outLevels = []
      const rms = (xs) => {
        let sum = 0
        for (const x of xs) sum += x * x
        return Math.sqrt(sum / xs.length)
      }

      // Two seconds, which is long enough for the recurrent state to settle.
      for (let frame = 0; frame < 200; frame++) {
        const heap = new Float32Array(memory.buffer, buffer, 480)
        fill(heap, frame)
        inLevels.push(rms(heap))
        api.j(state, buffer, buffer)
        outLevels.push(rms(new Float32Array(memory.buffer, buffer, 480)))
      }

      api.h(state)
      api.i(buffer)
      const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length
      // The last half second, by which point it has made its mind up.
      return { in: mean(inLevels.slice(-25)), out: mean(outLevels.slice(-25)) }
    }

    let seed = 12345
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff - 0.5
    }

    const noise = run((heap) => {
      for (let i = 0; i < 480; i++) heap[i] = random() * 0.3 * 32768
    })

    /*
     * Not speech, but the part of speech this network keys on: a low pitch
     * with harmonics above it, which is what a voiced vowel is. Scaled to the
     * same level as the noise so the comparison is fair.
     */
    const voice = run((heap, frame) => {
      const base = frame * 480
      for (let i = 0; i < 480; i++) {
        const t = (base + i) / 48000
        const wave =
          Math.sin(2 * Math.PI * 120 * t) +
          0.5 * Math.sin(2 * Math.PI * 240 * t) +
          0.3 * Math.sin(2 * Math.PI * 360 * t) +
          0.2 * Math.sin(2 * Math.PI * 480 * t)
        heap[i] = wave * 0.15 * 32768
      }
    })

    return { noise, voice }
  })

  check('the module loads without its 1.8 MB loader', !!raw.noise && !!raw.voice)

  const keptNoise = raw.noise ? raw.noise.out / raw.noise.in : 1
  const keptVoice = raw.voice ? raw.voice.out / raw.voice.in : 0
  check(
    'noise comes out quieter than it went in',
    keptNoise < 0.75,
    `${Math.round(keptNoise * 100)}% of it survives`,
  )
  check(
    'and a voice survives it far better than noise does',
    keptVoice > keptNoise * 1.5,
    `voice keeps ${Math.round(keptVoice * 100)}%, noise keeps ${Math.round(keptNoise * 100)}%`,
  )

  // ---- the worklet, end to end --------------------------------------------
  const live = await page.evaluate(async () => {
    const { denoise } = await import('/src/net/denoise.ts')

    // A tone plus noise, played into a stream, exactly as a microphone would.
    const ctx = new AudioContext({ sampleRate: 48000 })
    const noise = ctx.createBufferSource()
    const buffer = ctx.createBuffer(1, 48000, 48000)
    const data = buffer.getChannelData(0)
    let seed = 999
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      data[i] = (seed / 0x7fffffff - 0.5) * 0.3
    }
    buffer.loopStart = 0
    noise.buffer = buffer
    noise.loop = true
    const out = ctx.createMediaStreamDestination()
    noise.connect(out)
    noise.start()

    const cleaned = await denoise(out.stream)
    if (!cleaned) return { built: false }

    /*
     * Both streams measured the same way, through the same kind of analyser,
     * so the comparison is of the network and not of two different meters.
     */
    const meter = (stream) => {
      const ctx2 = new AudioContext({ sampleRate: 48000 })
      const node = ctx2.createAnalyser()
      node.fftSize = 2048
      ctx2.createMediaStreamSource(stream).connect(node)
      return {
        read: () => {
          const samples = new Float32Array(node.fftSize)
          node.getFloatTimeDomainData(samples)
          let sum = 0
          for (const s of samples) sum += s * s
          return Math.sqrt(sum / samples.length)
        },
        close: () => void ctx2.close(),
      }
    }

    const started = await cleaned.running
    const before = meter(out.stream)
    const after = meter(cleaned.stream)

    // Let the recurrent state settle, then average over a stretch: one read of
    // a signal that moves is a reading of the moment, not of the network.
    await new Promise((r) => setTimeout(r, 4000))
    let dirty = 0
    let quiet = 0
    const READS = 40
    for (let i = 0; i < READS; i++) {
      dirty += before.read()
      quiet += after.read()
      await new Promise((r) => setTimeout(r, 100))
    }
    dirty /= READS
    quiet /= READS

    before.close()
    after.close()
    cleaned.close()
    void ctx.close()
    return { built: true, started, dirty, quiet, tracks: cleaned.stream.getAudioTracks().length }
  })

  check('the worklet starts and hands back a stream', live.built && live.tracks === 1)
  check('and the network is really running in it', live.started === true)
  /*
   * A loose bound on purpose. How much white noise survives any given second
   * moves about, because the network is still making its mind up and the meter
   * reads a window rather than the whole thing; runs land anywhere from a fifth
   * to two fifths off. How strongly it suppresses is measured above, frame by
   * frame, where it can be measured properly. What this check is for is the
   * end to end path: microphone in, worklet, stream out, and something
   * different at the far end of it.
   */
  check(
    'and the whole path through the worklet is quieter for it',
    live.built && live.quiet < live.dirty * 0.9,
    live.built
      ? `${live.dirty.toFixed(3)} in, ${live.quiet.toFixed(3)} out`
      : 'never built',
  )
} finally {
  await browser.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} checks passed.`)
process.exit(passed === results.length ? 0 : 1)
