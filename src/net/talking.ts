/**
 * Who is talking.
 *
 * A level meter, one per person, and a threshold. There is nothing clever in
 * it and it does not need to be clever: the microphone has already been
 * through noise removal by the time it gets here, so what is left above the
 * floor is somebody speaking.
 *
 * Two details stop it flickering. It reads a short window rather than a single
 * sample, because speech is full of gaps between words and a meter that reads
 * one instant goes out during every one of them. And it holds on for a moment
 * after the level drops, for the same reason.
 */

/** Above this and somebody is talking. Below it is a quiet room. */
const FLOOR = 0.012
/** Keep the light on this long after they stop, so gaps between words do not show. */
const HOLD_MS = 350
/** How often to look. Twelve times a second is smooth and costs nothing. */
const TICK_MS = 80

interface Watched {
  analyser: AnalyserNode
  samples: Float32Array<ArrayBuffer>
  source: MediaStreamAudioSourceNode
  until: number
}

export class Talking {
  /** Called when the set of people talking changes. */
  onChange: (() => void) | null = null

  private ctx: AudioContext | null = null
  private readonly watched = new Map<string, Watched>()
  private live = new Set<string>()
  private timer: number | null = null

  /** Watch a stream, filed under whoever it belongs to. */
  add(id: string, stream: MediaStream): void {
    if (stream.getAudioTracks().length === 0) return
    this.remove(id)
    try {
      this.ctx = this.ctx ?? new AudioContext()
      void this.ctx.resume().catch(() => undefined)
      const analyser = this.ctx.createAnalyser()
      analyser.fftSize = 1024
      const source = this.ctx.createMediaStreamSource(stream)
      source.connect(analyser)
      this.watched.set(id, {
        analyser,
        samples: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)),
        source,
        until: 0,
      })
    } catch {
      // No meter is better than no call.
      return
    }
    if (this.timer === null) {
      this.timer = window.setInterval(() => this.look(), TICK_MS)
    }
  }

  remove(id: string): void {
    const one = this.watched.get(id)
    if (!one) return
    try {
      one.source.disconnect()
    } catch {
      /* already gone */
    }
    this.watched.delete(id)
    if (this.live.delete(id)) this.onChange?.()
    if (this.watched.size === 0) this.stopTimer()
  }

  is(id: string): boolean {
    return this.live.has(id)
  }

  dispose(): void {
    for (const id of [...this.watched.keys()]) this.remove(id)
    this.stopTimer()
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
  }

  private look(): void {
    const now = Date.now()
    const next = new Set<string>()

    for (const [id, one] of this.watched) {
      one.analyser.getFloatTimeDomainData(one.samples)
      let sum = 0
      for (const s of one.samples) sum += s * s
      const level = Math.sqrt(sum / one.samples.length)
      if (level > FLOOR) one.until = now + HOLD_MS
      if (one.until > now) next.add(id)
    }

    if (next.size === this.live.size && [...next].every((id) => this.live.has(id))) return
    this.live = next
    this.onChange?.()
  }
}
