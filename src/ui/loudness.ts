/**
 * How loud a sound is, by ITU-R BS.1770: a filter that hears the way people do
 * (K-weighting), then the average power of the parts that are not silence. In
 * LUFS. The channels are averaged, not added, so a mono clip and a stereo one
 * of the same sound measure the same.
 */

const BLOCK_S = 0.4
const STEP_S = 0.1
const ABSOLUTE_GATE = -70
const RELATIVE_GATE = -10

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

// The two K-weighting stages, for any sample rate, as libebur128 derives them.
// At 48 kHz they are the coefficients BS.1770 gives.
function highShelf(rate: number): Biquad {
  const K = Math.tan((Math.PI * 1681.974450955533) / rate)
  const Q = 0.7071752369554196
  const Vh = 10 ** (3.999843853973347 / 20)
  const Vb = Vh ** 0.4996667741545416
  const a0 = 1 + K / Q + K * K
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
}

function highPass(rate: number): Biquad {
  const K = Math.tan((Math.PI * 38.13547087602444) / rate)
  const Q = 0.5003270373238773
  const a0 = 1 + K / Q + K * K
  return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }
}

function filter(input: Float32Array, f: Biquad): Float32Array {
  const out = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x = input[i]
    const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    out[i] = y
  }
  return out
}

const toLufs = (power: number): number => -0.691 + 10 * Math.log10(power)

/** In LUFS, or -Infinity for silence. `channels` are the samples of each channel, at `rate`. */
export function loudnessOf(channels: Float32Array[], rate: number): number {
  const frames = Math.min(...channels.map((c) => c.length))
  if (!channels.length || !frames) return -Infinity
  const weighted = channels.map((c) => filter(filter(c.subarray(0, frames), highShelf(rate)), highPass(rate)))
  // A sound shorter than a block is one block.
  const block = Math.min(frames, Math.round(BLOCK_S * rate))
  const step = Math.max(1, Math.round(STEP_S * rate))
  const powers: number[] = []
  for (let start = 0; start + block <= frames; start += step) {
    let sum = 0
    for (const w of weighted) for (let i = start; i < start + block; i++) sum += w[i] * w[i]
    powers.push(sum / block / weighted.length)
  }
  const loud = powers.filter((p) => toLufs(p) > ABSOLUTE_GATE)
  if (!loud.length) return -Infinity
  const gate = toLufs(loud.reduce((a, b) => a + b, 0) / loud.length) + RELATIVE_GATE
  const kept = loud.filter((p) => toLufs(p) > gate)
  return toLufs(kept.reduce((a, b) => a + b, 0) / kept.length)
}

/** The loudest sample, from 0 to 1 and past. */
export function peakOf(channels: Float32Array[]): number {
  let peak = 0
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]))
  return peak
}

/** Seconds until the sound falls silent for good. */
export function lengthOf(channels: Float32Array[], rate: number, floor = 0.001): number {
  let last = 0
  for (const c of channels) {
    for (let i = c.length - 1; i > last; i--) {
      if (Math.abs(c[i]) > floor) {
        last = i
        break
      }
    }
  }
  return last / rate
}
