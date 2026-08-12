/**
 * The soundboard.
 *
 * Press a button and everybody in the space hears it, which is the whole
 * point: a noise only you can hear is not a joke, it is a notification.
 *
 * Nothing is recorded and nothing is downloaded. Every sound is built out of
 * oscillators and noise when it is pressed, the same way the chat blips are,
 * for three reasons that all matter here. There is no server to hold a sound
 * file. A recording of an airhorn belongs to whoever recorded it. And the
 * wire carries a name, thirty bytes of it, rather than an audio clip, so a
 * soundboard press costs the same as saying "hi" and cannot be used to push
 * a megabyte at everybody in the room.
 *
 * The cost is that these are impressions rather than samples. An airhorn made
 * of three sawtooth waves sounds like an airhorn drawn from memory, which is
 * the right amount of accuracy for a thing people press to be annoying.
 */

import { h, clear } from './dom'
import { placeNear } from './emoji'
import { sharedAudio, soundsOn } from './sounds'

export interface Sound {
  id: string
  label: string
  emoji: string
}

/**
 * What is on the board.
 *
 * Short list on purpose. Twelve sounds people can name beats forty they have
 * to hunt through, and the id is the whole payload on the wire so it stays
 * short and stays stable: a renamed id is a sound an older peer cannot play.
 */
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
]

export function soundById(id: string): Sound | null {
  return SOUNDS.find((s) => s.id === id) ?? null
}

/** Find one by id or by name, so /sound sad trumpet works. */
export function soundByName(text: string): Sound | null {
  const want = text.trim().toLowerCase().replace(/\s+/g, '')
  if (!want) return null
  return SOUNDS.find((s) => s.id === want || s.label.toLowerCase().replace(/\s+/g, '') === want) ?? null
}

/** At most one every so often, however hard somebody leans on the board. */
const GAP_MS = 600
let lastAt = 0

/**
 * Make the noise.
 *
 * Returns false when it did not, which is either because sounds are off, or
 * because the last one was moments ago, or because the page has never been
 * clicked and a browser will not let a silent page start making noise. The
 * caller uses that to decide whether to tell anybody.
 */
export function playSound(id: string): boolean {
  if (!soundsOn()) return false
  const now = Date.now()
  if (now - lastAt < GAP_MS) return false
  const ctx = sharedAudio()
  if (!ctx) return false
  const voice = VOICES[id]
  if (!voice) return false
  lastAt = now
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  try {
    voice(ctx, ctx.currentTime + 0.02)
  } catch {
    return false
  }
  return true
}

// ---- the parts every voice is made of ----

/** A note with a shape, a gain envelope, and an optional slide in pitch. */
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
    /** A second oscillator this far off in cents, for weight. */
    detune?: number
  },
): void {
  const make = (cents: number): void => {
    const osc = ctx.createOscillator()
    const vol = ctx.createGain()
    osc.type = opts.shape ?? 'sine'
    osc.detune.value = cents
    osc.frequency.setValueAtTime(opts.from, at)
    if (opts.to !== undefined && opts.to !== opts.from) {
      // Exponential, because pitch is heard in ratios. A linear slide from
      // 900 to 90 spends most of its time at the top and lands with a thud.
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), at + opts.len)
    }
    const rise = opts.attack ?? 0.008
    vol.gain.setValueAtTime(0.0001, at)
    vol.gain.linearRampToValueAtTime(opts.gain, at + rise)
    vol.gain.exponentialRampToValueAtTime(0.0001, at + opts.len)
    osc.connect(vol)
    vol.connect(ctx.destination)
    osc.start(at)
    osc.stop(at + opts.len + 0.02)
  }
  make(0)
  if (opts.detune) make(opts.detune)
}

/** A short burst of static, shaped by a filter. Every drum starts here. */
function hiss(
  ctx: AudioContext,
  at: number,
  opts: {
    len: number
    gain: number
    type?: BiquadFilterType
    freq: number
    /** Where the filter ends up, when it moves. */
    to?: number
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
  if (opts.to !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.to), at + opts.len)
  if (opts.q !== undefined) filter.Q.value = opts.q

  const vol = ctx.createGain()
  vol.gain.setValueAtTime(0.0001, at)
  vol.gain.linearRampToValueAtTime(opts.gain, at + 0.006)
  vol.gain.exponentialRampToValueAtTime(0.0001, at + opts.len)

  src.connect(filter)
  filter.connect(vol)
  vol.connect(ctx.destination)
  src.start(at)
  src.stop(at + opts.len + 0.02)
}

// ---- the voices ----

type Voice = (ctx: AudioContext, at: number) => void

/** Three sawtooths a fifth and an octave apart, which is a horn, roughly. */
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
      detune: 7,
    })
  }
}

/** One drum hit: a body that drops in pitch, and the skin on top of it. */
function hit(ctx: AudioContext, at: number, gain = 0.12): void {
  tone(ctx, at, { shape: 'triangle', from: 220, to: 90, len: 0.13, gain })
  hiss(ctx, at, { len: 0.11, gain: gain * 0.8, freq: 1400 })
}

const VOICES: Record<string, Voice> = {
  /** Two short, one long. The pattern is what makes it a horn and not a note. */
  airhorn: (ctx, at) => {
    blast(ctx, at, 0.17)
    blast(ctx, at + 0.24, 0.17)
    blast(ctx, at + 0.5, 0.8)
  },

  /** Ba-dum, tss. The joke is over. */
  rimshot: (ctx, at) => {
    hit(ctx, at)
    hit(ctx, at + 0.15)
    hiss(ctx, at + 0.3, { len: 0.7, gain: 0.09, type: 'highpass', freq: 6000, to: 3000 })
  },

  /** Four notes down, each sagging a semitone on the way out. Womp womp. */
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
        len: long ? 0.6 : 0.26,
        gain: 0.09,
        attack: 0.03,
        detune: 9,
      })
    }
  },

  /** A roll that speeds up, and the crash it was leading to. */
  drumroll: (ctx, at) => {
    let t = at
    let gap = 0.055
    while (t < at + 0.95) {
      hiss(ctx, t, { len: 0.05, gain: 0.05 + (t - at) * 0.05, freq: 1800 })
      gap = Math.max(0.028, gap * 0.96)
      t += gap
    }
    hit(ctx, at + 1, 0.14)
    hiss(ctx, at + 1, { len: 0.9, gain: 0.1, type: 'highpass', freq: 5000, to: 2500 })
  },

  /**
   * Forty pairs of hands, scattered.
   *
   * Claps land at random times because people do. Evenly spaced bursts sound
   * like a machine, which is the one thing applause must never sound like.
   */
  applause: (ctx, at) => {
    for (let i = 0; i < 44; i += 1) {
      const when = at + Math.random() * 1.5
      const swell = when - at < 0.25 ? 0.5 : 1
      hiss(ctx, when, {
        len: 0.045,
        gain: (0.012 + Math.random() * 0.02) * swell,
        type: 'bandpass',
        freq: 1400 + Math.random() * 2200,
        q: 1.1,
      })
    }
  },

  /** Up the chord and hold the top. Something good happened. */
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

  /** A cartoon spring: pitch falling fast, wobbling as it goes. */
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
    vol.connect(ctx.destination)
    lfo.start(at)
    carrier.start(at)
    lfo.stop(at + 0.5)
    carrier.stop(at + 0.5)
  },

  /** Two notes, the second held. Everybody born after 1985 knows this one. */
  coin: (ctx, at) => {
    tone(ctx, at, { shape: 'square', from: 988, len: 0.08, gain: 0.07 })
    tone(ctx, at + 0.08, { shape: 'square', from: 1319, len: 0.4, gain: 0.07 })
  },

  /** A struck bell: the note, and a partial well off the harmonic series. */
  bell: (ctx, at) => {
    tone(ctx, at, { shape: 'sine', from: 660, len: 1.6, gain: 0.1, attack: 0.003 })
    tone(ctx, at, { shape: 'sine', from: 660 * 2.76, len: 1, gain: 0.04, attack: 0.003 })
    tone(ctx, at, { shape: 'sine', from: 660 * 5.4, len: 0.5, gain: 0.02, attack: 0.003 })
  },

  /** Wrong. Two flat blasts, low enough to feel rude. */
  buzzer: (ctx, at) => {
    for (const delay of [0, 0.3]) {
      tone(ctx, at + delay, {
        shape: 'square',
        from: 140,
        len: 0.22,
        gain: 0.07,
        attack: 0.004,
        detune: -18,
      })
      tone(ctx, at + delay, { shape: 'sawtooth', from: 70, len: 0.22, gain: 0.05 })
    }
  },

  /** A shot from a film about space, which is a square wave falling over. */
  zap: (ctx, at) => {
    tone(ctx, at, { shape: 'square', from: 1600, to: 110, len: 0.28, gain: 0.08 })
    hiss(ctx, at, { len: 0.28, gain: 0.02, type: 'bandpass', freq: 2400, to: 300, q: 3 })
  },

  /** A cork, or a bubble. Sixty milliseconds of it. */
  pop: (ctx, at) => {
    tone(ctx, at, { shape: 'sine', from: 900, to: 180, len: 0.07, gain: 0.14, attack: 0.002 })
    hiss(ctx, at, { len: 0.02, gain: 0.03, freq: 2000 })
  },
}

// ---- the board itself ----

interface BoardOptions {
  anchor: HTMLElement
  /** Somebody pressed one. The caller plays it and tells the room. */
  onPick(id: string): void
}

let open: { close(): void } | null = null

/**
 * The grid of buttons, hung off whatever was pressed to open it.
 *
 * It stays open after a press, because a soundboard is played rather than
 * consulted, and closing after every noise would make a duet impossible.
 */
export function openSoundboard(options: BoardOptions): void {
  open?.close()

  const grid = h('div', { class: 'sound-grid' })
  const foot = h('div', { class: 'tiny faint' })

  const pop = h('div', { class: 'sound-pop', role: 'dialog', ariaLabel: 'Soundboard' }, [
    h('div', { class: 'row spread' }, [
      h('span', { class: 'eyebrow', text: 'Soundboard' }),
      h('button', {
        class: 'ghost tiny-btn',
        text: '×',
        title: 'Close',
        ariaLabel: 'Close the soundboard',
        on: { click: () => close() },
      }),
    ]),
    grid,
    foot,
  ])

  const sayFoot = (): void => {
    clear(foot)
    foot.append(
      soundsOn()
        ? 'Everybody here hears it.'
        : 'Sounds are off. Turn them on in Settings to play these.',
    )
  }

  for (const sound of SOUNDS) {
    grid.append(
      h(
        'button',
        {
          class: 'sound-cell',
          title: `Play ${sound.label} for everybody`,
          ariaLabel: `Play ${sound.label} for everybody`,
          on: { click: () => options.onPick(sound.id) },
        },
        [
          h('span', { class: 'sound-emoji', text: sound.emoji }),
          h('span', { class: 'sound-name', text: sound.label }),
        ],
      ),
    )
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

  open = { close }
  sayFoot()
  document.body.append(pop)
  placeNear(pop, options.anchor)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('pointerdown', onDown, true)
  window.addEventListener('resize', close)
}
