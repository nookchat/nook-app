import { explainMicRefusal, openMic } from '../net/mic'

/** A voice message never runs longer than this. */
export const MOST_VOICE_SECONDS = 5 * 60

/** The length of a recording, which a browser cannot read back from a WebM file it just made. */
const spoken = new WeakMap<File, number>()

export function voiceSeconds(file: File): number | undefined {
  return spoken.get(file)
}

/** The name every voice message has, so a message can tell one from another audio file. */
export const VOICE_NAME = /^Voice message\./

const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']

export function canRecordVoice(): boolean {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

export interface VoiceRecording {
  /** Ends the recording and gives the file, or null when it holds nothing. */
  finish(): Promise<File | null>
  /** Ends the recording and throws it away. */
  cancel(): void
  seconds(): number
  /** How loud it is now, from 0 to 1. */
  level(): number
}

export async function recordVoice(onLimit: () => void): Promise<VoiceRecording> {
  let stream: MediaStream
  try {
    stream = await openMic()
  } catch (err) {
    throw new Error(await explainMicRefusal(err))
  }
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t))
  const recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 64_000 })
  const parts: Blob[] = []
  recorder.addEventListener('dataavailable', (ev) => {
    if (ev.data.size) parts.push(ev.data)
  })

  const context = new AudioContext()
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  context.createMediaStreamSource(stream).connect(analyser)
  const wave = new Uint8Array(analyser.fftSize)

  const started = performance.now()
  let stoppedAt = 0
  const closed = new Promise<void>((ok) => recorder.addEventListener('stop', () => ok(), { once: true }))
  const release = (): void => {
    for (const track of stream.getTracks()) track.stop()
    void context.close().catch(() => undefined)
  }
  const stop = (): void => {
    if (recorder.state === 'inactive') return
    stoppedAt = performance.now()
    recorder.stop()
  }
  const limit = window.setTimeout(() => {
    onLimit()
  }, MOST_VOICE_SECONDS * 1000)

  recorder.start(250)
  return {
    seconds: () => ((stoppedAt || performance.now()) - started) / 1000,
    level() {
      analyser.getByteTimeDomainData(wave)
      let peak = 0
      for (const v of wave) peak = Math.max(peak, Math.abs(v - 128))
      return Math.min(1, peak / 80)
    },
    async finish() {
      window.clearTimeout(limit)
      stop()
      await closed
      release()
      const length = (stoppedAt - started) / 1000
      if (!parts.length || length < 0.5) return null
      const mime = recorder.mimeType || type || 'audio/webm'
      const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'
      const file = new File(parts, `Voice message.${ext}`, { type: mime.split(';')[0] })
      spoken.set(file, Math.round(Math.min(length, MOST_VOICE_SECONDS) * 10) / 10)
      return file
    },
    cancel() {
      window.clearTimeout(limit)
      parts.length = 0
      stop()
      release()
    },
  }
}
