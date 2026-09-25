const KEY = 'cathode.sounds.v1'

const NEWS_MAX_AGE_MS = 45_000
const MIN_GAP_MS = 400

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
    /* storage blocked */
  }
}

// Browsers cap the AudioContexts a page may open, so the soundboard shares this one.
export function sharedAudio(): AudioContext | null {
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

function note(
  freq: number,
  at: number,
  length = 0.09,
  gain = 0.05,
  shape: OscillatorType = 'sine',
): void {
  const ctx = sharedAudio()
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
  if (now - lastAt < MIN_GAP_MS) return
  lastAt = now
  const ctx = sharedAudio()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  for (const [freq, delay] of notes) note(freq, ctx.currentTime + delay, 0.09, 0.05, shape)
}

export function chirpMessage(): void {
  play(
    [
      [784, 0],
      [1318, 0.07],
    ],
    'triangle',
  )
}

export function chirpJoin(): void {
  play([
    [520, 0],
    [780, 0.08],
    [1040, 0.16],
  ])
}

export function chirpLeave(): void {
  play([
    [780, 0],
    [520, 0.09],
  ])
}

export function ring(): () => void {
  if (!soundsOn()) return () => undefined
  const ctx = sharedAudio()
  if (!ctx) return () => undefined
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  const once = (): void => {
    const t = ctx.currentTime
    note(660, t, 0.16, 0.06)
    note(880, t + 0.18, 0.16, 0.06)
    note(660, t + 0.36, 0.16, 0.06)
    note(880, t + 0.54, 0.24, 0.06)
  }
  once()
  const timer = window.setInterval(once, 2400)
  return () => window.clearInterval(timer)
}

export function isNews(at: number): boolean {
  return Date.now() - at < NEWS_MAX_AGE_MS
}

export function speak(text: string): void {
  if (!soundsOn()) return
  const line = text.trim()
  if (!line) return
  try {
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(line))
  } catch {
    /* no speech synthesis */
  }
}
