import { LOUD_DB, MIC_CHANGED, QUIET_DB, micSettings } from './mic'
import { watchContext } from './unlock'

/**
 * The last step before the mic is sent: the input volume, then a gate that
 * closes below the threshold when the sensitivity is set by hand.
 */
export interface Shaped {
  stream: MediaStream
  /** The level after the input volume, in dBFS. */
  level(): number
  /** True while the gate lets the voice through. */
  open(): boolean
  close(): void
}

const TICK_MS = 20
/** How long the gate stays open after the voice drops, so words do not lose their ends. */
const HOLD_MS = 300

export function shape(input: MediaStream): Shaped {
  const ctx = watchContext(new AudioContext())
  void ctx.resume().catch(() => undefined)
  const source = ctx.createMediaStreamSource(input)
  const volume = ctx.createGain()
  const gate = ctx.createGain()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  const out = ctx.createMediaStreamDestination()
  source.connect(volume)
  volume.connect(analyser)
  volume.connect(gate)
  gate.connect(out)

  // The sent track follows the mute of the one it came from.
  const inTrack = input.getAudioTracks()[0]
  const outTrack = out.stream.getAudioTracks()[0]
  if (inTrack && outTrack) outTrack.enabled = inTrack.enabled

  let settings = micSettings()
  const apply = (): void => {
    settings = micSettings()
    volume.gain.setTargetAtTime(settings.inputVolume, ctx.currentTime, 0.02)
  }
  apply()
  window.addEventListener(MIC_CHANGED, apply)

  const data = new Float32Array(analyser.fftSize)
  let db = QUIET_DB
  let isOpen = true
  let lastLoud = 0
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (const v of data) sum += v * v
    db = Math.max(QUIET_DB - 40, 20 * Math.log10(Math.sqrt(sum / data.length) + 1e-8))
    const now = performance.now()
    if (db >= settings.threshold) lastLoud = now
    const want = settings.autoSensitivity || now - lastLoud < HOLD_MS
    if (want !== isOpen) {
      isOpen = want
      // Opens fast so the first sound is kept, and closes gently so it does not click.
      gate.gain.setTargetAtTime(want ? 1 : 0, ctx.currentTime, want ? 0.005 : 0.05)
    }
  }, TICK_MS)

  return {
    stream: out.stream,
    level: () => Math.min(LOUD_DB + 10, db),
    open: () => isOpen,
    close: () => {
      window.clearInterval(timer)
      window.removeEventListener(MIC_CHANGED, apply)
      out.stream.getTracks().forEach((t) => t.stop())
      void ctx.close().catch(() => undefined)
    },
  }
}
