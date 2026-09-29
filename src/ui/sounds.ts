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
 * The app's own sounds: short clips from Kenney's Interface Sounds (www.kenney.nl), which
 * are CC0, so free to use with no conditions. They are in public/sounds, with the licence.
 * Each is fetched and decoded once, the first time it is wanted or when warmSounds runs.
 */
type Cue = 'join' | 'leave' | 'message' | 'mention' | 'ring' | 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'hangup'

/** How loud each plays: the clips are mastered loud, and these sit under a voice. */
const LOUDNESS: Record<Cue, number> = {
  join: 0.35,
  leave: 0.35,
  message: 0.3,
  mention: 0.4,
  ring: 0.45,
  mute: 0.3,
  unmute: 0.3,
  deafen: 0.3,
  undeafen: 0.3,
  hangup: 0.35,
}
const RING_EVERY_MS = 2400
/** The ring is its clip twice, this far apart. */
const RING_SECOND_S = 0.42

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

async function play(cue: Cue, at = 0): Promise<void> {
  const ctx = sharedAudio()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  const buffer = await clip(cue)
  if (!buffer) return
  const source = ctx.createBufferSource()
  const vol = ctx.createGain()
  source.buffer = buffer
  vol.gain.value = LOUDNESS[cue]
  source.connect(vol)
  vol.connect(ctx.destination)
  source.start(ctx.currentTime + at)
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
  cue('message')
}

/** Somebody named you, or wrote to you alone. */
export function chirpMention(): void {
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

export function ring(): () => void {
  if (!soundsOn()) return () => undefined
  const once = (): void => {
    void play('ring')
    void play('ring', RING_SECOND_S)
  }
  once()
  const timer = window.setInterval(once, RING_EVERY_MS)
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
