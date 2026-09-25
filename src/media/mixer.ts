// One outgoing track from the first moment, so a later source needs no renegotiation.
export class AudioMixer {
  readonly track: MediaStreamTrack
  private readonly ctx: AudioContext
  private readonly destination: MediaStreamAudioDestinationNode
  private source: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null
  private closed = false

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new Ctor()
    this.destination = this.ctx.createMediaStreamDestination()
    this.track = this.destination.stream.getAudioTracks()[0]
    try {
      ;(this.track as MediaStreamTrack & { contentHint: string }).contentHint = 'speech'
    } catch {}
  }

  // A browser can start an AudioContext only after a user gesture.
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => undefined)
    }
  }

  attachSystem(stream: MediaStream | null): void {
    this.detach()
    if (!stream || stream.getAudioTracks().length === 0) return
    try {
      this.source = this.ctx.createMediaStreamSource(stream)
      this.source.connect(this.destination)
      this.stream = stream
    } catch {
      this.source = null
      this.stream = null
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.stream?.getTracks().forEach((t) => t.stop())
    this.detach()
    this.track.stop()
    void this.ctx.close().catch(() => undefined)
  }

  private detach(): void {
    try {
      this.source?.disconnect()
    } catch {}
    this.source = null
    this.stream = null
  }
}
