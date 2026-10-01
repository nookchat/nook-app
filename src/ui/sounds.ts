import { doNotDisturb } from '../store/status'

const KEY = 'nook.sounds.v1'

const NEWS_MAX_AGE_MS = 45_000
const MIN_GAP_MS = 400

let context: AudioContext | null = null

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

/**
 * The app's own sounds: Google's Material Design sound resources, under CC-BY 4.0. They are
 * in public/sounds, with the licence, each brought to the same loudness. Each is fetched and
 * decoded once, the first time it is wanted or when warmSounds runs.
 */
type Cue = 'join' | 'leave' | 'message' | 'mention' | 'ring' | 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'hangup' | 'stream'

/** How loud each plays: the clips are mastered loud, and these sit under a voice. */
const LOUDNESS: Record<Cue, number> = {
  join: 0.7,
  leave: 0.7,
  message: 0.55,
  mention: 0.65,
  ring: 0.6,
  mute: 0.55,
  unmute: 0.55,
  deafen: 0.55,
  undeafen: 0.55,
  hangup: 0.7,
  stream: 0.7,
}
/** The ringtone is a little under eight seconds, and goes again when it ends. */
const RING_EVERY_MS = 8000

const clips = new Map<Cue, Promise<AudioBuffer | null>>()
const lastPlayed = new Map<Cue, number>()

function clip(cue: Cue): Promise<AudioBuffer | null> {
  const had = clips.get(cue)
  if (had) return had
  const ctx = sharedAudio()
  if (!ctx) return Promise.resolve(null)
  const loading = fetch(new URL(`sounds/${cue}.mp3`, document.baseURI))
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(String(res.status)))))
    .then((bytes) => ctx.decodeAudioData(bytes))
    .catch(() => {
      clips.delete(cue)
      return null
    })
  clips.set(cue, loading)
  return loading
}

/** Fetched ahead, so the first join or message is not late. */
export function warmSounds(): void {
  for (const cue of Object.keys(LOUDNESS) as Cue[]) void clip(cue)
}

async function play(cue: Cue): Promise<AudioBufferSourceNode | null> {
  const ctx = sharedAudio()
  if (!ctx) return null
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  const buffer = await clip(cue)
  if (!buffer) return null
  const source = ctx.createBufferSource()
  const vol = ctx.createGain()
  source.buffer = buffer
  vol.gain.value = LOUDNESS[cue]
  source.connect(vol)
  vol.connect(ctx.destination)
  source.start()
  return source
}

/** One cue, unless sounds are off, or the same one just played: a burst is one sound. */
function cue(name: Cue): void {
  if (!soundsOn()) return
  const now = Date.now()
  if (now - (lastPlayed.get(name) ?? 0) < MIN_GAP_MS) return
  lastPlayed.set(name, now)
  void play(name)
}

export function chirpMessage(): void {
  if (doNotDisturb()) return
  cue('message')
}

/** Somebody named you, or wrote to you alone. */
export function chirpMention(): void {
  if (doNotDisturb()) return
  cue('mention')
}

export function chirpJoin(): void {
  cue('join')
}

export function chirpLeave(): void {
  cue('leave')
}

export function chirpMute(muted: boolean): void {
  cue(muted ? 'mute' : 'unmute')
}

export function chirpDeafen(deafened: boolean): void {
  cue(deafened ? 'deafen' : 'undeafen')
}

export function chirpHangup(): void {
  cue('hangup')
}

/** A screen share starts: your own, or one in your voice channel. */
export function chirpStream(): void {
  cue('stream')
}

/** Rings until the function it gives back is called, which stops the ringtone at once. */
export function ring(): () => void {
  if (!soundsOn()) return () => undefined
  let stopped = false
  let playing: AudioBufferSourceNode | null = null
  const once = (): void => {
    void play('ring').then((source) => {
      if (stopped) source?.stop()
      else playing = source
    })
  }
  once()
  const timer = window.setInterval(once, RING_EVERY_MS)
  return () => {
    stopped = true
    window.clearInterval(timer)
    try {
      playing?.stop()
    } catch {
      /* it had ended */
    }
  }
}

export function isNews(at: number): boolean {
  return Date.now() - at < NEWS_MAX_AGE_MS
}

const MAX_QUEUED_LINES = 3
let queued: number[] = []

/** Lines handed to speech in the last minute, about as many as can still be waiting. */
function queuedLines(): number {
  const now = Date.now()
  queued = queued.filter((at) => now - at < 60_000)
  return queued.length
}

export function speak(text: string): void {
  if (!soundsOn()) return
  const line = text.trim()
  if (!line) return
  try {
    // A few lines wait their turn. More than that is somebody filling the queue: those are dropped.
    if (window.speechSynthesis.pending && queuedLines() >= MAX_QUEUED_LINES) return
    queued.push(Date.now())
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(line))
  } catch {
    /* no speech synthesis */
  }
}
