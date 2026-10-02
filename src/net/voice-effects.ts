import type { VoiceId } from './mic'

// The file is kept for a week, so the number goes up whenever it changes: an old copy has no `crush`.
const WORKLET = '/voice-worklet.js?v=2'

/** A piece of the audio graph: sound goes in at `input` and comes out of `output`. */
export interface Effect {
  input: AudioNode
  output: AudioNode
  stop(): void
}

type Ends = Omit<Effect, 'stop'>

const loaded = new WeakMap<BaseAudioContext, Promise<void>>()

function loadWorklet(ctx: BaseAudioContext): Promise<void> {
  let had = loaded.get(ctx)
  if (!had) {
    had = ctx.audioWorklet.addModule(WORKLET)
    loaded.set(ctx, had)
  }
  return had
}

function workletNode(ctx: BaseAudioContext, name: string, parameterData: Record<string, number>): AudioWorkletNode {
  return new AudioWorkletNode(ctx, name, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
    outputChannelCount: [1],
    parameterData,
  })
}

/** A soft bend, so a loud voice is rounded and not cut flat. */
function bend(amount: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(1024)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount)
  }
  return curve
}

/** The nodes an effect is made of, each kept so that `stop` can take them all down. */
function parts(ctx: BaseAudioContext) {
  const nodes: AudioNode[] = []
  const keep = <T extends AudioNode>(node: T): T => {
    nodes.push(node)
    return node
  }
  const gain = (value: number): GainNode => {
    const node = keep(ctx.createGain())
    node.gain.value = value
    return node
  }
  const filter = (type: BiquadFilterType, frequency: number, q = 1, boost = 0): BiquadFilterNode => {
    const node = keep(ctx.createBiquadFilter())
    node.type = type
    node.frequency.value = frequency
    node.Q.value = q
    node.gain.value = boost
    return node
  }
  const shaper = (amount: number): WaveShaperNode => {
    const node = keep(ctx.createWaveShaper())
    node.curve = bend(amount)
    return node
  }
  /** Swings a setting up and down around where it is, `rate` times a second. */
  const wobble = (param: AudioParam, rate: number, depth: number, type: OscillatorType = 'sine'): void => {
    const tone = keep(ctx.createOscillator())
    tone.type = type
    tone.frequency.value = rate
    const size = gain(depth)
    tone.connect(size)
    size.connect(param)
    tone.start()
  }
  /** Moves the pitch: 1 is as it is, 2 is an octave up. */
  const pitch = async (ratio: number): Promise<AudioWorkletNode> => {
    await loadWorklet(ctx)
    return keep(workletNode(ctx, 'pitch', { ratio }))
  }
  const ratioOf = (node: AudioWorkletNode): AudioParam => node.parameters.get('ratio') as AudioParam
  const crush = async (bits: number, rate: number): Promise<AudioWorkletNode> => {
    await loadWorklet(ctx)
    return keep(workletNode(ctx, 'crush', { bits, rate }))
  }
  /** A room the voice rings on in for about `seconds`. */
  const hall = (seconds: number): ConvolverNode => {
    const length = Math.round(ctx.sampleRate * seconds)
    const ring = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = ring.getChannelData(0)
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3
    const node = keep(ctx.createConvolver())
    node.buffer = ring
    return node
  }
  /** Joins each node to the next, and gives the two ends. */
  const chain = (...line: AudioNode[]): Ends => {
    for (let i = 1; i < line.length; i++) line[i - 1].connect(line[i])
    return { input: line[0], output: line[line.length - 1] }
  }
  const stop = (): void => {
    for (const node of nodes) {
      try {
        if (node instanceof OscillatorNode) node.stop()
        node.disconnect()
      } catch {
        /* it had stopped */
      }
    }
  }
  return { keep, gain, filter, shaper, wobble, pitch, ratioOf, crush, hall, chain, stop }
}

type Parts = ReturnType<typeof parts>

/** How each voice is made. Every voice but `off` has one, so a new voice cannot be left out. */
const MAKE: Record<Exclude<VoiceId, 'off'>, (p: Parts, ctx: BaseAudioContext) => Promise<Ends> | Ends> = {
  deep: async (p) => p.chain(await p.pitch(0.74)),
  high: async (p) => p.chain(await p.pitch(1.32)),
  chipmunk: async (p) => p.chain(await p.pitch(1.85)),

  // Low and rough: a dark tone, with the edges rounded off.
  monster: async (p) => p.chain(await p.pitch(0.55), p.shaper(3), p.filter('lowpass', 2200)),

  robot: (p, ctx) => {
    // The voice, times a tone: every part of it is made to buzz at that tone's pitch.
    const buzz = p.gain(0)
    const tone = p.keep(ctx.createOscillator())
    tone.type = 'sine'
    tone.frequency.value = 52
    tone.connect(buzz.gain)
    tone.start()
    return p.chain(buzz, p.gain(1.8))
  },

  radio: (p) => p.chain(p.filter('highpass', 600), p.filter('lowpass', 3200), p.shaper(6), p.gain(0.8)),

  echo: (p, ctx) => {
    // The voice, and after it a few softer copies of it.
    const input = p.gain(1)
    const output = p.gain(1)
    const wait = p.keep(ctx.createDelay(1))
    wait.delayTime.value = 0.24
    const back = p.gain(0.4)
    const wet = p.gain(0.6)
    input.connect(output)
    input.connect(wait)
    wait.connect(wet)
    wet.connect(output)
    wait.connect(back)
    back.connect(wait)
    return { input, output }
  },

  alien: async (p, ctx) => {
    // A little higher, then times a tone that slides up and down, with some of the plain voice under it.
    const up = await p.pitch(1.2)
    const ring = p.gain(0)
    const tone = p.keep(ctx.createOscillator())
    tone.frequency.value = 320
    p.wobble(tone.frequency, 2.5, 160)
    tone.connect(ring.gain)
    tone.start()
    const output = p.gain(1)
    up.connect(ring)
    ring.connect(p.gain(0.9)).connect(output)
    up.connect(p.gain(0.45)).connect(output)
    return { input: up, output }
  },

  underwater: async (p) => {
    // Muffled under a filter that moves, on a pitch that bobs a little.
    const bob = await p.pitch(0.93)
    p.wobble(p.ratioOf(bob), 3, 0.03)
    const muffle = p.filter('lowpass', 600, 4)
    p.wobble(muffle.frequency, 1.7, 280)
    return p.chain(bob, muffle, p.gain(1.1))
  },

  drunk: async (p) => {
    const slide = await p.pitch(0.94)
    p.wobble(p.ratioOf(slide), 0.5, 0.12)
    return p.chain(slide, p.filter('lowpass', 3800))
  },

  goat: async (p) => {
    // A fast, wide vibrato, through the nose.
    const bleat = await p.pitch(1.06)
    p.wobble(p.ratioOf(bleat), 7, 0.09)
    return p.chain(bleat, p.filter('peaking', 1400, 1, 8), p.gain(0.8))
  },

  fan: (p) => {
    // The level is chopped about sixteen times a second, as the blades go by.
    const blades = p.gain(0.55)
    p.wobble(blades.gain, 16, 0.45)
    return p.chain(blades)
  },

  clones: async (p, ctx) => {
    // Your voice, one a little lower and one a little higher, each a moment behind.
    const input = p.gain(1)
    const output = p.gain(1)
    input.connect(p.gain(0.55)).connect(output)
    for (const [ratio, late] of [
      [0.79, 0.035],
      [1.26, 0.06],
    ]) {
      const other = await p.pitch(ratio)
      const wait = p.keep(ctx.createDelay(0.2))
      wait.delayTime.value = late
      input.connect(other)
      other.connect(wait)
      wait.connect(p.gain(0.5)).connect(output)
    }
    return { input, output }
  },

  demon: async (p) => {
    // An octave down and a fifth down together, roughened, in a dark room.
    const input = p.gain(1)
    const both = p.gain(1)
    input.connect(await p.pitch(0.5)).connect(p.gain(0.9)).connect(both)
    input.connect(await p.pitch(0.75)).connect(p.gain(0.4)).connect(both)
    const dark = p.chain(both, p.shaper(4), p.filter('lowpass', 2600)).output
    const output = p.gain(0.8)
    dark.connect(output)
    dark.connect(p.hall(1.2)).connect(p.gain(0.3)).connect(output)
    return { input, output }
  },

  ghost: async (p) => {
    // A little higher and wavering, and mostly the ring of an empty hall.
    const waver = await p.pitch(1.1)
    p.wobble(p.ratioOf(waver), 5, 0.035)
    const thin = p.chain(waver, p.filter('highpass', 250)).output
    const output = p.gain(1)
    thin.connect(p.gain(0.4)).connect(output)
    thin.connect(p.hall(3)).connect(p.gain(0.9)).connect(output)
    return { input: waver, output }
  },

  retro: async (p) => p.chain(await p.crush(4, 5500), p.filter('highpass', 150), p.gain(0.9)),

  // Driven hard, so every word buzzes, then a nasal peak and the top taken off.
  kazoo: (p) =>
    p.chain(p.filter('highpass', 350), p.shaper(25), p.filter('peaking', 1800, 2, 9), p.filter('lowpass', 5000), p.gain(0.35)),
}

/**
 * The graph for one voice. Null for the voice as it is, or when this browser has no way to make
 * the effect: the caller then sends no sound at all, never the voice the person meant to change.
 */
export async function buildVoice(ctx: BaseAudioContext, id: VoiceId): Promise<Effect | null> {
  if (id === 'off') return null
  const p = parts(ctx)
  try {
    return { ...(await MAKE[id](p, ctx)), stop: p.stop }
  } catch (err) {
    p.stop()
    throw err
  }
}
