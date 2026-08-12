/**
 * Small noises.
 *
 * Generated rather than loaded: three short blips out of an oscillator cost
 * nothing to ship and never wait on a network. They are deliberately quiet and
 * short, because a chat that pings loudly is a chat people mute.
 *
 * Two rules stop them becoming a nuisance. Nothing plays for anything you did
 * yourself, and nothing plays for old news: syncing with a peer can deliver
 * hundreds of messages at once, and every one of them is already history.
 */

const KEY = 'cathode.sounds.v1'

/** Ignore anything older than this. Backfill is not news. */
const NEWS_MS = 45_000
/** At most one noise this often, however much arrives. */
const GAP_MS = 400

let context: AudioContext | null = null
let lastAt = 0

export function soundsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function setSounds(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* the choice lasts for this session only */
  }
}

function audio(): AudioContext | null {
  if (context) return context
  try {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    context = new Ctor()
  } catch {
    context = null
  }
  return context
}

/** One soft note, short, with a fade so it never clicks. */
function note(
  freq: number,
  at: number,
  length = 0.09,
  gain = 0.05,
  shape: OscillatorType = 'sine',
): void {
  const ctx = audio()
  if (!ctx) return
  const osc = ctx.createOscillator()
  const vol = ctx.createGain()
  osc.type = shape
  osc.frequency.value = freq
  vol.gain.setValueAtTime(0, at)
  vol.gain.linearRampToValueAtTime(gain, at + 0.012)
  vol.gain.exponentialRampToValueAtTime(0.0001, at + length)
  osc.connect(vol)
  vol.connect(ctx.destination)
  osc.start(at)
  osc.stop(at + length + 0.02)
}

function play(notes: [number, number][], shape: OscillatorType = 'sine'): void {
  if (!soundsOn()) return
  const now = Date.now()
  if (now - lastAt < GAP_MS) return
  lastAt = now
  const ctx = audio()
  if (!ctx) return
  // A page that has never been clicked cannot make a noise. Nothing to do but
  // let it stay quiet until it can.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  for (const [freq, delay] of notes) note(freq, ctx.currentTime + delay, 0.09, 0.05, shape)
}

/**
 * Something was said. Two bright notes, up, the way the messengers of 2003
 * announced a line: glassy rather than mellow, which is what a triangle wave
 * is for. Their actual recordings belong to Microsoft; the feel does not.
 */
export function chirpMessage(): void {
  play(
    [
      [784, 0],
      [1318, 0.07],
    ],
    'triangle',
  )
}

/** Somebody walked into the voice channel you are in. The door, opening. */
export function chirpJoin(): void {
  play([
    [520, 0],
    [780, 0.08],
    [1040, 0.16],
  ])
}

/** And walked out again. */
export function chirpLeave(): void {
  play([
    [780, 0],
    [520, 0.09],
  ])
}

/**
 * A nudge. Half a second of rattle, low and square-modulated, the buzz of a
 * window being shaken. Deliberately not run through the shared throttle:
 * a nudge is asked for by name and rationed by its own rule at the caller.
 */
export function buzzNudge(): void {
  if (!soundsOn()) return
  const ctx = audio()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  const t = ctx.currentTime

  const osc = ctx.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(150, t)
  osc.frequency.linearRampToValueAtTime(95, t + 0.4)

  const vol = ctx.createGain()
  vol.gain.setValueAtTime(0, t)
  vol.gain.linearRampToValueAtTime(0.045, t + 0.02)
  vol.gain.setValueAtTime(0.045, t + 0.34)
  vol.gain.exponentialRampToValueAtTime(0.0001, t + 0.46)

  // The rattle: a square wave opening and closing the volume 26 times a second.
  const lfo = ctx.createOscillator()
  lfo.type = 'square'
  lfo.frequency.value = 26
  const depth = ctx.createGain()
  depth.gain.value = 0.03
  lfo.connect(depth)
  depth.connect(vol.gain)

  osc.connect(vol)
  vol.connect(ctx.destination)
  osc.start(t)
  lfo.start(t)
  osc.stop(t + 0.5)
  lfo.stop(t + 0.5)
}

/** True when the event is recent enough to be worth a noise. */
export function isNews(at: number): boolean {
  return Date.now() - at < NEWS_MS
}
