import { h } from './dom'
import { icon } from './icons'
import { placeNear } from './emoji'
import { onContextMenu } from './menu'
import { sharedAudio, soundsOn } from './sounds'

export interface Sound {
  id: string
  label: string
  emoji: string
}

/** A sound somebody added: its id on the wire is CUSTOM + the board id. */
export const CUSTOM = 'c:'
/** Longest a sound that somebody added plays for. */
export const CUSTOM_MAX_S = 10

// The id is the wire payload: renaming one breaks older peers.
export const SOUNDS: Sound[] = [
  { id: 'airhorn', label: 'Airhorn', emoji: '📢' },
  { id: 'rimshot', label: 'Rimshot', emoji: '🥁' },
  { id: 'sadtrumpet', label: 'Sad trumpet', emoji: '🎺' },
  { id: 'drumroll', label: 'Drum roll', emoji: '🪘' },
  { id: 'applause', label: 'Applause', emoji: '👏' },
  { id: 'fanfare', label: 'Fanfare', emoji: '🎉' },
  { id: 'boing', label: 'Boing', emoji: '🌀' },
  { id: 'coin', label: 'Coin', emoji: '🪙' },
  { id: 'bell', label: 'Bell', emoji: '🔔' },
  { id: 'buzzer', label: 'Buzzer', emoji: '⛔' },
  { id: 'zap', label: 'Zap', emoji: '⚡' },
  { id: 'pop', label: 'Pop', emoji: '🫧' },
  { id: 'tada', label: 'Ta-da', emoji: '✨' },
  { id: 'whoosh', label: 'Whoosh', emoji: '💨' },
  { id: 'crickets', label: 'Crickets', emoji: '🦗' },
]

export function soundById(id: string): Sound | null {
  return SOUNDS.find((s) => s.id === id) ?? null
}

export function soundByName(text: string): Sound | null {
  const want = text.trim().toLowerCase().replace(/\s+/g, '')
  if (!want) return null
  return SOUNDS.find((s) => s.id === want || s.label.toLowerCase().replace(/\s+/g, '') === want) ?? null
}

const MIN_GAP_MS = 600
let lastAt = 0

/**
 * Every sound goes through one chain: a gentle top cut, a small room, and a
 * compressor, so the synthesised ones sound less like a test tone and a loud
 * sound somebody added cannot blow anybody's ears out.
 */
const chains = new WeakMap<AudioContext, AudioNode>()

function room(ctx: AudioContext, seconds: number): AudioBuffer {
  const frames = Math.floor(ctx.sampleRate * seconds)
  const buffer = ctx.createBuffer(2, frames, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 3)
  }
  return buffer
}

function out(ctx: AudioContext): AudioNode {
  const had = chains.get(ctx)
  if (had) return had
  const input = ctx.createGain()
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 9000
  tone.Q.value = 0.5
  const dry = ctx.createGain()
  dry.gain.value = 1
  const wet = ctx.createGain()
  wet.gain.value = 0.16
  const verb = ctx.createConvolver()
  verb.buffer = room(ctx, 1.1)
  const squeeze = ctx.createDynamicsCompressor()
  squeeze.threshold.value = -18
  squeeze.knee.value = 12
  squeeze.ratio.value = 4
  squeeze.attack.value = 0.004
  squeeze.release.value = 0.2
  const level = ctx.createGain()
  level.gain.value = 1.4
  input.connect(tone)
  tone.connect(dry)
  tone.connect(verb)
  verb.connect(wet)
  dry.connect(squeeze)
  wet.connect(squeeze)
  squeeze.connect(level)
  level.connect(ctx.destination)
  chains.set(ctx, input)
  return input
}

function ready(): AudioContext | null {
  if (!soundsOn()) return null
  const now = Date.now()
  if (now - lastAt < MIN_GAP_MS) return null
  const ctx = sharedAudio()
  if (!ctx) return null
  lastAt = now
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  return ctx
}

export function playSound(id: string): boolean {
  const voice = VOICES[id]
  if (!voice) return false
  const ctx = ready()
  if (!ctx) return false
  try {
    voice(ctx, ctx.currentTime + 0.02)
  } catch {
    return false
  }
  return true
}

/** A sound somebody added, already decoded. */
export function playClip(buffer: AudioBuffer): boolean {
  const ctx = ready()
  if (!ctx) return false
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const vol = ctx.createGain()
  vol.gain.value = 0.8
  src.connect(vol)
  vol.connect(out(ctx))
  const at = ctx.currentTime + 0.02
  src.start(at)
  if (buffer.duration > CUSTOM_MAX_S) {
    vol.gain.setValueAtTime(0.8, at + CUSTOM_MAX_S - 0.3)
    vol.gain.linearRampToValueAtTime(0.0001, at + CUSTOM_MAX_S)
    src.stop(at + CUSTOM_MAX_S)
  }
  return true
}

export async function decodeClip(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = sharedAudio()
  if (!ctx) throw new Error('This browser cannot play sounds.')
  return ctx.decodeAudioData(bytes)
}

function tone(
  ctx: AudioContext,
  at: number,
  opts: {
    shape?: OscillatorType
    from: number
    to?: number
    len: number
    gain: number
    attack?: number
    unisonCents?: number
    /** Low pass, in Hz: takes the fizz off a saw or a square. */
    cut?: number
    /** Vibrato: rate in Hz and depth in cents. */
    wobble?: [number, number]
  },
): void {
  const make = (cents: number): void => {
    const osc = ctx.createOscillator()
    const vol = ctx.createGain()
    osc.type = opts.shape ?? 'sine'
    osc.detune.value = cents
    if (opts.wobble) {
      const lfo = ctx.createOscillator()
      const depth = ctx.createGain()
      lfo.frequency.value = opts.wobble[0]
      depth.gain.value = opts.wobble[1]
      lfo.connect(depth)
      depth.connect(osc.detune)
      lfo.start(at)
      lfo.stop(at + opts.len + 0.02)
    }
    osc.frequency.setValueAtTime(opts.from, at)
    if (opts.to !== undefined && opts.to !== opts.from) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), at + opts.len)
    }
    const rise = opts.attack ?? 0.008
    vol.gain.setValueAtTime(0.0001, at)
    vol.gain.linearRampToValueAtTime(opts.gain, at + rise)
    vol.gain.exponentialRampToValueAtTime(0.0001, at + opts.len)
    if (opts.cut) {
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = opts.cut
      osc.connect(filter)
      filter.connect(vol)
    } else {
      osc.connect(vol)
    }
    vol.connect(out(ctx))
    osc.start(at)
    osc.stop(at + opts.len + 0.02)
  }
  make(0)
  if (opts.unisonCents) make(opts.unisonCents)
}

function hiss(
  ctx: AudioContext,
  at: number,
  opts: {
    len: number
    gain: number
    type?: BiquadFilterType
    freq: number
    endFreq?: number
    q?: number
  },
): void {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * opts.len))
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1
  const src = ctx.createBufferSource()
  src.buffer = buffer

  const filter = ctx.createBiquadFilter()
  filter.type = opts.type ?? 'highpass'
  filter.frequency.setValueAtTime(opts.freq, at)
  if (opts.endFreq !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.endFreq), at + opts.len)
  if (opts.q !== undefined) filter.Q.value = opts.q

  const vol = ctx.createGain()
  vol.gain.setValueAtTime(0.0001, at)
  vol.gain.linearRampToValueAtTime(opts.gain, at + 0.006)
  vol.gain.exponentialRampToValueAtTime(0.0001, at + opts.len)

  src.connect(filter)
  filter.connect(vol)
  vol.connect(out(ctx))
  src.start(at)
  src.stop(at + opts.len + 0.02)
}

type Voice = (ctx: AudioContext, at: number) => void

function blast(ctx: AudioContext, at: number, len: number): void {
  const base = 233
  for (const [mult, gain] of [
    [1, 0.11],
    [1.5, 0.07],
    [2.01, 0.05],
    [3.02, 0.03],
  ] as const) {
    tone(ctx, at, {
      shape: 'sawtooth',
      from: base * mult * 0.94,
      to: base * mult,
      len,
      gain,
      attack: 0.02,
      unisonCents: 7,
      cut: 3800,
      wobble: [6, 8],
    })
  }
}

function hit(ctx: AudioContext, at: number, gain = 0.12): void {
  tone(ctx, at, { shape: 'triangle', from: 220, to: 90, len: 0.13, gain })
  hiss(ctx, at, { len: 0.11, gain: gain * 0.8, freq: 1400 })
}

const VOICES: Record<string, Voice> = {
  airhorn: (ctx, at) => {
    blast(ctx, at, 0.17)
    blast(ctx, at + 0.24, 0.17)
    blast(ctx, at + 0.5, 0.8)
  },

  rimshot: (ctx, at) => {
    hit(ctx, at)
    hit(ctx, at + 0.15)
    hiss(ctx, at + 0.3, { len: 0.7, gain: 0.09, type: 'highpass', freq: 6000, endFreq: 3000 })
  },

  sadtrumpet: (ctx, at) => {
    const steps: [number, number][] = [
      [392, 0],
      [349, 0.26],
      [311, 0.52],
      [262, 0.78],
    ]
    for (const [freq, delay] of steps) {
      const long = delay > 0.7
      tone(ctx, at + delay, {
        shape: 'sawtooth',
        from: freq,
        to: freq * 0.94,
        len: long ? 0.9 : 0.26,
        gain: 0.09,
        attack: 0.03,
        unisonCents: 9,
        cut: 2200,
        wobble: long ? [5, 30] : undefined,
      })
    }
  },

  drumroll: (ctx, at) => {
    let t = at
    let gap = 0.055
    while (t < at + 0.95) {
      hiss(ctx, t, { len: 0.05, gain: 0.05 + (t - at) * 0.05, freq: 1800 })
      gap = Math.max(0.028, gap * 0.96)
      t += gap
    }
    hit(ctx, at + 1, 0.14)
    hiss(ctx, at + 1, { len: 0.9, gain: 0.1, type: 'highpass', freq: 5000, endFreq: 2500 })
  },

  applause: (ctx, at) => {
    hiss(ctx, at, { len: 1.9, gain: 0.018, type: 'bandpass', freq: 2200, q: 0.6 })
    for (let i = 0; i < 110; i += 1) {
      const when = at + Math.random() * 1.8
      const swell = when - at < 0.25 ? 0.5 : when - at > 1.4 ? 0.6 : 1
      hiss(ctx, when, {
        len: 0.045,
        gain: (0.012 + Math.random() * 0.02) * swell,
        type: 'bandpass',
        freq: 1400 + Math.random() * 2200,
        q: 1.1,
      })
    }
  },

  fanfare: (ctx, at) => {
    const notes: [number, number, number][] = [
      [523, 0, 0.12],
      [659, 0.1, 0.12],
      [784, 0.2, 0.12],
      [1047, 0.3, 0.5],
    ]
    for (const [freq, delay, len] of notes) {
      tone(ctx, at + delay, { shape: 'triangle', from: freq, len, gain: 0.09 })
      tone(ctx, at + delay, { shape: 'square', from: freq * 2, len: len * 0.6, gain: 0.02 })
    }
  },

  boing: (ctx, at) => {
    tone(ctx, at, { shape: 'sine', from: 700, to: 90, len: 0.45, gain: 0.13 })
    const lfo = ctx.createOscillator()
    const depth = ctx.createGain()
    const carrier = ctx.createOscillator()
    const vol = ctx.createGain()
    lfo.frequency.value = 22
    depth.gain.value = 60
    carrier.type = 'sine'
    carrier.frequency.setValueAtTime(520, at)
    carrier.frequency.exponentialRampToValueAtTime(80, at + 0.45)
    vol.gain.setValueAtTime(0.06, at)
    vol.gain.exponentialRampToValueAtTime(0.0001, at + 0.45)
    lfo.connect(depth)
    depth.connect(carrier.frequency)
    carrier.connect(vol)
    vol.connect(out(ctx))
    lfo.start(at)
    carrier.start(at)
    lfo.stop(at + 0.5)
    carrier.stop(at + 0.5)
  },

  coin: (ctx, at) => {
    tone(ctx, at, { shape: 'square', from: 988, len: 0.08, gain: 0.06, cut: 5000 })
    tone(ctx, at + 0.08, { shape: 'square', from: 1319, len: 0.5, gain: 0.06, cut: 5000 })
    tone(ctx, at + 0.08, { shape: 'sine', from: 2638, len: 0.35, gain: 0.02 })
  },

  bell: (ctx, at) => {
    tone(ctx, at, { shape: 'sine', from: 660, len: 1.6, gain: 0.1, attack: 0.003 })
    tone(ctx, at, { shape: 'sine', from: 660 * 2.76, len: 1, gain: 0.04, attack: 0.003 })
    tone(ctx, at, { shape: 'sine', from: 660 * 5.4, len: 0.5, gain: 0.02, attack: 0.003 })
  },

  buzzer: (ctx, at) => {
    for (const delay of [0, 0.3]) {
      tone(ctx, at + delay, {
        shape: 'square',
        from: 140,
        len: 0.22,
        gain: 0.07,
        attack: 0.004,
        unisonCents: -18,
        cut: 2600,
      })
      tone(ctx, at + delay, { shape: 'sawtooth', from: 70, len: 0.22, gain: 0.05 })
    }
  },

  zap: (ctx, at) => {
    tone(ctx, at, { shape: 'square', from: 1600, to: 110, len: 0.28, gain: 0.08 })
    hiss(ctx, at, { len: 0.28, gain: 0.02, type: 'bandpass', freq: 2400, endFreq: 300, q: 3 })
  },

  tada: (ctx, at) => {
    // A brass chord stabbed twice, the second held.
    const chord = [523, 659, 784, 1047]
    for (const [delay, len] of [
      [0, 0.12],
      [0.16, 0.9],
    ] as const) {
      for (const freq of chord) {
        tone(ctx, at + delay, { shape: 'sawtooth', from: freq, len, gain: 0.035, attack: 0.012, unisonCents: 6, cut: 3200 })
      }
      tone(ctx, at + delay, { shape: 'triangle', from: 262, len, gain: 0.06 })
    }
    hiss(ctx, at + 0.16, { len: 0.8, gain: 0.05, type: 'highpass', freq: 7000, endFreq: 4000 })
  },

  whoosh: (ctx, at) => {
    hiss(ctx, at, { len: 0.55, gain: 0.16, type: 'bandpass', freq: 300, endFreq: 3800, q: 2.5 })
    hiss(ctx, at + 0.1, { len: 0.45, gain: 0.07, type: 'bandpass', freq: 3800, endFreq: 500, q: 3 })
  },

  crickets: (ctx, at) => {
    for (const [start, freq] of [
      [0, 4400],
      [0.55, 4700],
      [1.1, 4400],
    ] as const) {
      for (let i = 0; i < 4; i += 1) {
        const t = at + start + i * 0.05
        tone(ctx, t, { shape: 'sine', from: freq, len: 0.035, gain: 0.05, attack: 0.004, wobble: [55, 40] })
      }
    }
  },

  pop: (ctx, at) => {
    tone(ctx, at, { shape: 'sine', from: 900, to: 180, len: 0.07, gain: 0.14, attack: 0.002 })
    hiss(ctx, at, { len: 0.02, gain: 0.03, freq: 2000 })
  },
}

interface BoardOptions {
  anchor: HTMLElement
  onPick(id: string): void
  /** Sounds people added, with ids that start with CUSTOM. */
  custom?: Sound[]
  onAdd?(): void
  /** Only called for sounds this person may take off. */
  onRemove?(id: string): void
  canRemove?(id: string): boolean
}

let open: { close(): void; anchor: HTMLElement } | null = null

export function openSoundboard(options: BoardOptions): void {
  if (open && open.anchor === options.anchor) {
    open.close()
    return
  }
  open?.close()

  const grid = h('div', { class: 'sound-grid' })
  const foot = h('div', { class: 'tiny faint' })

  const pop = h('div', { class: 'sound-pop', role: 'dialog', ariaLabel: 'Soundboard' }, [
    h('div', { class: 'row spread' }, [
      h('span', { class: 'eyebrow', text: 'Soundboard' }),
      h(
        'button',
        {
          class: 'ghost icon-only pop-close',
          title: 'Close',
          ariaLabel: 'Close the soundboard',
          on: { click: () => close() },
        },
        [icon('close', 18)],
      ),
    ]),
    grid,
    foot,
  ])

  const cell = (sound: Sound, mine: boolean): HTMLElement => {
    const button = h(
      'button',
      {
        class: `sound-cell${mine ? ' custom' : ''}`,
        title: `Play ${sound.label} for everybody in voice`,
        ariaLabel: `Play ${sound.label} for everybody`,
        on: { click: () => options.onPick(sound.id) },
      },
      [
        h('span', { class: 'sound-emoji', text: sound.emoji }),
        h('span', { class: 'sound-name', text: sound.label }),
      ],
    )
    if (mine && options.onRemove && options.canRemove?.(sound.id)) {
      onContextMenu(button, () => [
        {
          label: `Take ${sound.label} off`,
          note: 'For everybody in this space',
          danger: true,
          run: () => options.onRemove?.(sound.id),
        },
      ])
    }
    return button
  }

  for (const sound of SOUNDS) grid.append(cell(sound, false))
  const custom = options.custom ?? []
  if (custom.length || options.onAdd) {
    grid.append(h('div', { class: 'sound-split eyebrow', text: 'Added here' }))
    for (const sound of custom) grid.append(cell(sound, true))
    if (options.onAdd) {
      grid.append(
        h(
          'button',
          {
            class: 'sound-cell sound-add',
            title: 'Add a sound for this space, up to 10 seconds',
            ariaLabel: 'Add a sound',
            on: {
              click: () => {
                close()
                options.onAdd?.()
              },
            },
          },
          [icon('plus', 20), h('span', { class: 'sound-name', text: 'Add a sound' })],
        ),
      )
    }
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    close()
    options.anchor.focus()
  }
  const onDown = (ev: Event): void => {
    const target = ev.target as Node
    if (pop.contains(target) || options.anchor.contains(target)) return
    close()
  }
  function close(): void {
    if (open?.close !== close) return
    open = null
    pop.remove()
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('pointerdown', onDown, true)
    window.removeEventListener('resize', close)
  }

  open = { close, anchor: options.anchor }
  foot.textContent = soundsOn()
    ? 'Everybody in this voice channel hears it.'
    : 'Sounds are off. Turn them on in Settings to play these.'
  document.body.append(pop)
  placeNear(pop, options.anchor)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('pointerdown', onDown, true)
  window.addEventListener('resize', close)
}
