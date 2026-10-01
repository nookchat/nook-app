import type { VoiceId } from './mic'

const WORKLET = '/voice-worklet.js'

/** A piece of the audio graph: sound goes in at `input` and comes out of `output`. */
export interface Effect {
  input: AudioNode
  output: AudioNode
  stop(): void
}

/** How far each pitch effect moves the voice: 1 is as it is, 2 is an octave up. */
const PITCH: Partial<Record<VoiceId, number>> = {
  deep: 0.74,
  high: 1.32,
  chipmunk: 1.85,
  monster: 0.55,
}

const loaded = new WeakMap<BaseAudioContext, Promise<void>>()

function loadPitch(ctx: AudioContext): Promise<void> {
  let had = loaded.get(ctx)
  if (!had) {
    had = ctx.audioWorklet.addModule(WORKLET)
    loaded.set(ctx, had)
  }
  return had
}

function pitchNode(ctx: AudioContext, ratio: number): AudioWorkletNode {
  return new AudioWorkletNode(ctx, 'pitch', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
    outputChannelCount: [1],
    parameterData: { ratio },
  })
}

/** A soft bend, so a loud voice is rounded and not cut flat. */
function bend(amount: number): Float32Array {
  const curve = new Float32Array(1024)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount)
  }
  return curve
}

/**
 * The graph for one voice. Null for the voice as it is, or when this browser has no way to make
 * the effect: the caller then sends no sound at all, never the voice the person meant to change.
 */
export async function buildVoice(ctx: AudioContext, id: VoiceId): Promise<Effect | null> {
  if (id === 'off') return null
  const nodes: AudioNode[] = []
  const keep = <T extends AudioNode>(node: T): T => {
    nodes.push(node)
    return node
  }
  const stopAll = (): void => {
    for (const node of nodes) {
      try {
        if (node instanceof OscillatorNode) node.stop()
        node.disconnect()
      } catch {
        /* it had stopped */
      }
    }
  }

  const ratio = PITCH[id]
  if (ratio !== undefined) {
    await loadPitch(ctx)
    const pitch = keep(pitchNode(ctx, ratio))
    if (id !== 'monster') return { input: pitch, output: pitch, stop: stopAll }
    // Low and rough: a dark tone, with the edges rounded off.
    const dark = keep(ctx.createBiquadFilter())
    dark.type = 'lowpass'
    dark.frequency.value = 2200
    const rough = keep(ctx.createWaveShaper())
    rough.curve = bend(3) as Float32Array<ArrayBuffer>
    pitch.connect(rough)
    rough.connect(dark)
    return { input: pitch, output: dark, stop: stopAll }
  }

  if (id === 'robot') {
    // The voice, times a tone: every part of it is made to buzz at that tone's pitch.
    const buzz = keep(ctx.createGain())
    buzz.gain.value = 0
    const tone = keep(ctx.createOscillator())
    tone.type = 'sine'
    tone.frequency.value = 52
    tone.connect(buzz.gain)
    tone.start()
    const lift = keep(ctx.createGain())
    lift.gain.value = 1.8
    buzz.connect(lift)
    return { input: buzz, output: lift, stop: stopAll }
  }

  if (id === 'radio') {
    const thin = keep(ctx.createBiquadFilter())
    thin.type = 'highpass'
    thin.frequency.value = 600
    const narrow = keep(ctx.createBiquadFilter())
    narrow.type = 'lowpass'
    narrow.frequency.value = 3200
    const crunch = keep(ctx.createWaveShaper())
    crunch.curve = bend(6) as Float32Array<ArrayBuffer>
    const level = keep(ctx.createGain())
    level.gain.value = 0.8
    thin.connect(narrow)
    narrow.connect(crunch)
    crunch.connect(level)
    return { input: thin, output: level, stop: stopAll }
  }

  // Echo: the voice, and after it a few softer copies of it.
  const input = keep(ctx.createGain())
  const output = keep(ctx.createGain())
  const wait = keep(ctx.createDelay(1))
  wait.delayTime.value = 0.24
  const back = keep(ctx.createGain())
  back.gain.value = 0.4
  const wet = keep(ctx.createGain())
  wet.gain.value = 0.6
  input.connect(output)
  input.connect(wait)
  wait.connect(wet)
  wet.connect(output)
  wait.connect(back)
  back.connect(wait)
  return { input, output, stop: stopAll }
}
