import { check, finish } from './harness.mjs'

// The soundboard's loudness measure, on its own: plain numbers in, so no browser is needed.
const { lengthOf, loudnessOf, peakOf } = await import('../src/ui/loudness.ts')

const RATE = 48_000
const sine = (freq, amp, seconds, rate = RATE) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate))
const near = (a, b, within = 0.1) => Math.abs(a - b) <= within

const full = loudnessOf([sine(1000, 1, 2)], RATE)
check('a full scale 1 kHz tone is -3.01 LUFS, as BS.1770 says', near(full, -3.01), full.toFixed(2))
const half = loudnessOf([sine(1000, 0.5, 2)], RATE)
check('half the level is 6 dB quieter', near(full - half, 6.02), (full - half).toFixed(2))
const at44 = loudnessOf([sine(1000, 1, 2, 44_100)], 44_100)
check('the sample rate does not change it', near(at44, full, 0.05), at44.toFixed(2))
check('stereo of the same sound measures as mono', near(loudnessOf([sine(1000, 1, 2), sine(1000, 1, 2)], RATE), full, 0.01))
const low = loudnessOf([sine(40, 1, 2)], RATE)
check('a deep hum counts for less than its level', low < full - 3, low.toFixed(2))
const gap = new Float32Array(RATE * 4)
gap.set(sine(1000, 1, 1), 0)
// A plain average over the 4 seconds would be 6 dB down. The gate leaves only the edges of the tone.
check('silence around a sound hardly changes it', near(loudnessOf([gap], RATE), full, 1), loudnessOf([gap], RATE).toFixed(2))
check('silence is -Infinity', loudnessOf([new Float32Array(RATE)], RATE) === -Infinity)
check('a sound shorter than a block is measured', Number.isFinite(loudnessOf([sine(1000, 1, 0.06)], RATE)))
check('the peak', near(peakOf([sine(1000, 0.25, 0.1)]), 0.25, 0.001))
check('the length stops where the sound does', near(lengthOf([gap], RATE), 1, 0.01), lengthOf([gap], RATE).toFixed(3))

finish()
