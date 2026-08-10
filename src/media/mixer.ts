/**
 * The audio mixer.
 *
 * System audio and the microphone go through one WebAudio graph and leave as a
 * single track:
 *
 *   system audio -> gain -> analyser -\
 *                                      +-> destination -> one outgoing track
 *   microphone   -> gain -> analyser -/
 *
 * The track exists from the first moment, even when both sources are absent.
 * That keeps the sender fixed, so the host can add a microphone later with no
 * renegotiation and no stutter for the viewers.
 */

export interface Levels {
  system: number
  mic: number
}

class Channel {
  readonly gain: GainNode
  private readonly analyser: AnalyserNode
  private readonly buffer: Uint8Array<ArrayBuffer>
  private source: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null

  constructor(ctx: AudioContext, destination: AudioNode, initialGain: number) {
    this.gain = ctx.createGain()
    this.gain.gain.value = initialGain
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.analyser.smoothingTimeConstant = 0.5
    this.buffer = new Uint8Array(this.analyser.fftSize)
    this.gain.connect(this.analyser)
    this.analyser.connect(destination)
  }

  attach(ctx: AudioContext, stream: MediaStream | null): void {
    this.detach()
    if (!stream || stream.getAudioTracks().length === 0) return
    try {
      this.source = ctx.createMediaStreamSource(stream)
      this.source.connect(this.gain)
      this.stream = stream
    } catch {
      this.source = null
      this.stream = null
    }
  }

  detach(): void {
    if (this.source) {
      try {
        this.source.disconnect()
      } catch {
        /* already gone */
      }
    }
    this.source = null
    this.stream = null
  }

  stopTracks(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.detach()
  }

  get active(): boolean {
    return this.source !== null
  }

  setGain(value: number, ctx: AudioContext): void {
    const v = Math.max(0, Math.min(2, value))
    try {
      this.gain.gain.setTargetAtTime(v, ctx.currentTime, 0.02)
    } catch {
      this.gain.gain.value = v
    }
  }

  level(): number {
    if (!this.source) return 0
    this.analyser.getByteTimeDomainData(this.buffer)
    let sum = 0
    for (let i = 0; i < this.buffer.length; i++) {
      const x = (this.buffer[i] - 128) / 128
      sum += x * x
    }
    // Root mean square, then a gentle curve so quiet speech still shows.
    return Math.min(1, Math.sqrt(sum / this.buffer.length) * 3)
  }
}

export class AudioMixer {
  readonly track: MediaStreamTrack
  private readonly ctx: AudioContext
  private readonly destination: MediaStreamAudioDestinationNode
  private readonly system: Channel
  private readonly mic: Channel
  private closed = false

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new Ctor()
    this.destination = this.ctx.createMediaStreamDestination()
    this.system = new Channel(this.ctx, this.destination, 1)
    this.mic = new Channel(this.ctx, this.destination, 1)
    this.track = this.destination.stream.getAudioTracks()[0]
    try {
      ;(this.track as MediaStreamTrack & { contentHint: string }).contentHint = 'speech'
    } catch {
      /* no hint support */
    }
  }

  /** A browser can start an AudioContext only after a user gesture. */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => undefined)
    }
  }

  attachSystem(stream: MediaStream | null): void {
    this.system.attach(this.ctx, stream)
  }

  attachMic(stream: MediaStream | null): void {
    this.mic.attach(this.ctx, stream)
  }

  stopMic(): void {
    this.mic.stopTracks()
  }

  setSystemGain(value: number): void {
    this.system.setGain(value, this.ctx)
  }

  setMicGain(value: number): void {
    this.mic.setGain(value, this.ctx)
  }

  get hasSystem(): boolean {
    return this.system.active
  }

  get hasMic(): boolean {
    return this.mic.active
  }

  levels(): Levels {
    if (this.closed) return { system: 0, mic: 0 }
    return { system: this.system.level(), mic: this.mic.level() }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.system.stopTracks()
    this.mic.stopTracks()
    this.track.stop()
    void this.ctx.close().catch(() => undefined)
  }
}
