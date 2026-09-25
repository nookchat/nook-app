const TALKING_FLOOR = 0.012
/** Held after the level drops, so gaps between words do not show. */
const HOLD_MS = 350
const TICK_MS = 80

interface Watched {
  analyser: AnalyserNode
  samples: Float32Array<ArrayBuffer>
  source: MediaStreamAudioSourceNode
  until: number
}

export class Talking {
  onChange: (() => void) | null = null

  private ctx: AudioContext | null = null
  private readonly watched = new Map<string, Watched>()
  private readonly live = new Set<string>()
  private timer: number | null = null

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
      this.watched.set(id, { analyser, samples: new Float32Array(analyser.fftSize), source, until: 0 })
    } catch {
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
    let changed = false
    for (const [id, one] of this.watched) {
      const samples = one.samples
      one.analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
      if (Math.sqrt(sum / samples.length) > TALKING_FLOOR) one.until = now + HOLD_MS
      const talking = one.until > now
      if (talking === this.live.has(id)) continue
      if (talking) this.live.add(id)
      else this.live.delete(id)
      changed = true
    }
    if (changed) this.onChange?.()
  }
}
