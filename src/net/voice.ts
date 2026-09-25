import type { SignalBus } from '../signal/bus'
import type { Envelope } from '../signal/envelope'
import { denoise, type Denoiser } from './denoise'
import { DEVICES_CHANGED, explainMicRefusal, micSettings, openMic, playOn } from './mic'
import { Talking } from './talking'
import { VOLUMES_CHANGED } from './volume'

const RETRY_MS = 5000
const STALE_CALL_MS = 8000

export interface VoiceState {
  channel: string | null
  muted: boolean
  /** Hears nobody. Deafened also means muted. */
  deafened: boolean
  /** When this session came into the channel, by this clock. */
  since: number
}

/** How the line to one person in the channel is doing. Null when not known yet. */
export interface LinkQuality {
  peerId: string
  pingMs: number | null
  jitterMs: number | null
  lossPct: number | null
}

export class Voice {
  onChange: (() => void) | null = null
  onArrival: ((arrived: boolean, peerId: string) => void) | null = null
  /** Said once per person per channel. */
  onFailed: ((peerId: string) => void) | null = null
  /** Null admits anybody standing in the channel. */
  admit: ((peerId: string, channel: string) => boolean) | null = null
  /** From 0 to 1. */
  volumeOf: ((peerId: string) => number) | null = null

  private readonly failed = new Set<string>()
  private readonly bus: SignalBus
  private readonly selfId: string
  private readonly calls = new Map<string, Call>()
  private readonly talking = new Talking()
  private mic: MediaStream | null = null
  private rawMic: MediaStream | null = null
  private cleaner: Denoiser | null = null
  private channel: string | null = null
  private muted = false
  private deafened = false
  private since = 0
  /** The mute to go back to when deafened ends. */
  private mutedBeforeDeaf = false
  private readonly standing = new Map<string, string>()
  private timer: number | null = null
  private readonly config: () => RTCConfiguration
  private switching = false

  private readonly onVolumes = (): void => {
    for (const [peer, call] of this.calls) call.setVolume(this.volumeOf?.(peer) ?? 1)
  }

  private readonly onDevices = (): void => {
    for (const call of this.calls.values()) call.speakers()
    void this.switchMic()
  }

  constructor(bus: SignalBus, selfId: string, config: () => RTCConfiguration) {
    this.bus = bus
    this.selfId = selfId
    this.config = config
    window.addEventListener(DEVICES_CHANGED, this.onDevices)
    window.addEventListener(VOLUMES_CHANGED, this.onVolumes)
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDevices)
    this.talking.onChange = () => this.onChange?.()
    this.timer = window.setInterval(() => this.retry(), RETRY_MS)
  }

  dispose(): void {
    window.removeEventListener(DEVICES_CHANGED, this.onDevices)
    window.removeEventListener(VOLUMES_CHANGED, this.onVolumes)
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDevices)
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.leave()
    this.talking.dispose()
  }

  isTalking(peerId: string): boolean {
    if (peerId === this.selfId && this.muted) return false
    return this.talking.is(peerId)
  }

  get state(): VoiceState {
    return { channel: this.channel, muted: this.muted, deafened: this.deafened, since: this.since }
  }

  /** Includes this session when it stands there. */
  membersOf(channel: string): string[] {
    const out: string[] = []
    for (const [id, c] of this.standing) if (c === channel) out.push(id)
    if (this.channel === channel) out.push(this.selfId)
    return out
  }

  whereIs(peerId: string): string | null {
    return this.standing.get(peerId) ?? null
  }

  /** Must run from a click: the browser will not open the microphone or play audio without one. */
  async join(channel: string): Promise<void> {
    if (this.channel === channel) return
    this.leave()
    try {
      this.rawMic = await openMic()
    } catch (err) {
      throw new Error(await explainMicRefusal(err))
    }
    this.mic = this.rawMic
    if (micSettings().smart) {
      this.cleaner = await denoise(this.rawMic)
      if (this.cleaner) this.mic = this.cleaner.stream
    }
    this.channel = channel
    this.since = Date.now()
    this.muted = false
    this.deafened = false
    this.failed.clear()
    this.talking.add(this.selfId, this.mic)
    this.onChange?.()
    for (const peer of this.membersOf(channel)) this.considerCall(peer)
  }

  private async switchMic(): Promise<void> {
    if (!this.channel || this.switching) return
    this.switching = true
    try {
      const raw = await openMic()
      let mic = raw
      let cleaner: Denoiser | null = null
      if (micSettings().smart) {
        cleaner = await denoise(raw)
        if (cleaner) mic = cleaner.stream
      }
      if (!this.channel) {
        cleaner?.close()
        raw.getTracks().forEach((t) => t.stop())
        return
      }
      for (const t of [...raw.getAudioTracks(), ...mic.getAudioTracks()]) t.enabled = !this.muted
      for (const call of this.calls.values()) await call.useMic(mic)
      const old = { raw: this.rawMic, mic: this.mic, cleaner: this.cleaner }
      this.rawMic = raw
      this.mic = mic
      this.cleaner = cleaner
      old.cleaner?.close()
      old.raw?.getTracks().forEach((t) => t.stop())
      old.mic?.getTracks().forEach((t) => t.stop())
      this.talking.remove(this.selfId)
      this.talking.add(this.selfId, mic)
      this.onChange?.()
    } catch {
      /* the old microphone keeps going */
    } finally {
      this.switching = false
    }
  }

  leave(): void {
    for (const id of this.calls.keys()) this.talking.remove(id)
    this.talking.remove(this.selfId)
    for (const call of this.calls.values()) call.close()
    this.calls.clear()
    this.cleaner?.close()
    this.cleaner = null
    this.rawMic?.getTracks().forEach((t) => t.stop())
    this.mic?.getTracks().forEach((t) => t.stop())
    this.rawMic = null
    this.mic = null
    this.channel = null
    this.muted = false
    this.deafened = false
    this.onChange?.()
  }

  setMuted(muted: boolean): void {
    // Speaking again while deafened means hearing again too.
    if (!muted && this.deafened) {
      this.deafened = false
      for (const call of this.calls.values()) call.setDeaf(false)
    }
    this.muted = muted
    for (const track of this.rawMic?.getAudioTracks() ?? []) track.enabled = !muted
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !muted
    this.onChange?.()
  }

  setDeafened(deafened: boolean): void {
    if (deafened === this.deafened) return
    if (deafened) this.mutedBeforeDeaf = this.muted
    this.deafened = deafened
    for (const call of this.calls.values()) call.setDeaf(deafened)
    this.setMuted(deafened ? true : this.mutedBeforeDeaf)
  }

  /** The microphone before any cleaning, which names the device. */
  get source(): MediaStream | null {
    return this.rawMic
  }

  async quality(): Promise<LinkQuality[]> {
    const out: LinkQuality[] = []
    for (const [peerId, call] of this.calls) {
      if (!call.live) continue
      out.push({ peerId, ...(await call.quality()) })
    }
    return out
  }

  get connected(): number {
    let live = 0
    for (const call of this.calls.values()) if (call.live) live++
    return live
  }

  noteAnnounce(from: string, voice: string | null): void {
    const was = this.standing.get(from) ?? null
    if (voice) this.standing.set(from, voice)
    else this.standing.delete(from)
    if (was === voice) return
    if (this.channel && voice === this.channel) {
      this.considerCall(from)
      this.onArrival?.(true, from)
    }
    if (was === this.channel && voice !== this.channel) {
      this.onArrival?.(false, from)
      this.calls.get(from)?.close()
      this.calls.delete(from)
      this.talking.remove(from)
    }
    this.onChange?.()
  }

  forget(peerId: string): void {
    if (this.standing.delete(peerId)) this.onChange?.()
    this.calls.get(peerId)?.close()
    this.calls.delete(peerId)
    this.talking.remove(peerId)
  }

  /** A session with a call stays: a relay outage empties the roster while the audio keeps flowing. */
  prune(alive: Set<string>): void {
    let changed = false
    for (const id of this.standing.keys()) {
      if (alive.has(id) || this.calls.has(id)) continue
      this.standing.delete(id)
      changed = true
    }
    if (changed) this.onChange?.()
  }

  async handle(env: Envelope): Promise<void> {
    const data = (env.data ?? {}) as Record<string, unknown>
    switch (env.type) {
      case 'voffer': {
        if (!this.channel || !this.mic) return
        if (this.admit && !this.admit(env.from, this.channel)) return
        // The offer can overtake their announcement, and is itself proof they stand here.
        this.standing.set(env.from, this.channel)
        const call = this.call(env.from, false)
        await call.onOffer(data as unknown as RTCSessionDescriptionInit)
        this.onChange?.()
        return
      }
      case 'vanswer': {
        await this.calls.get(env.from)?.onAnswer(data as unknown as RTCSessionDescriptionInit)
        return
      }
      case 'vice': {
        await this.calls.get(env.from)?.onIce(data as unknown as RTCIceCandidateInit)
        return
      }
      default:
        return
    }
  }

  private considerCall(peerId: string): void {
    if (peerId === this.selfId || !this.channel || !this.mic) return
    if (this.admit && !this.admit(peerId, this.channel)) return
    if (this.selfId >= peerId) return // the smaller id calls
    const existing = this.calls.get(peerId)
    if (existing && !existing.stale()) return
    existing?.close()
    this.calls.delete(peerId)
    void this.call(peerId, true).dial()
  }

  private retry(): void {
    if (!this.channel) return
    for (const peer of this.membersOf(this.channel)) this.considerCall(peer)
  }

  private call(peerId: string, weOffer: boolean): Call {
    const existing = this.calls.get(peerId)
    if (existing) return existing
    const call = new Call(this.mic!, weOffer, this.config(), {
      send: (type, data) => void this.bus.send({ type, to: peerId, data }),
      onChange: () => this.onChange?.(),
      onAudio: (stream) => this.talking.add(peerId, stream),
      onFailed: () => {
        if (this.failed.has(peerId)) return
        this.failed.add(peerId)
        this.onFailed?.(peerId)
      },
    })
    call.setVolume(this.volumeOf?.(peerId) ?? 1)
    call.setDeaf(this.deafened)
    this.calls.set(peerId, call)
    return call
  }
}

interface CallHooks {
  send: (type: 'voffer' | 'vanswer' | 'vice', data: unknown) => void
  onChange: () => void
  onAudio: (stream: MediaStream) => void
  onFailed: () => void
}

class Call {
  live = false

  private readonly startedAt = Date.now()
  private readonly pc: RTCPeerConnection
  private mic: MediaStream
  private readonly hooks: CallHooks
  private readonly sink: HTMLAudioElement
  private readonly pending: RTCIceCandidateInit[] = []
  private hasRemote = false
  private closed = false

  constructor(mic: MediaStream, weOffer: boolean, config: RTCConfiguration, hooks: CallHooks) {
    this.hooks = hooks
    this.mic = mic
    this.pc = new RTCPeerConnection(config)

    // Only the caller: an answerer's own transceiver adds an m-line the answer cannot carry.
    if (weOffer) {
      for (const track of mic.getAudioTracks()) {
        this.pc.addTransceiver(track, { direction: 'sendrecv', streams: [mic] })
      }
    }

    // In the page, hidden: a detached audio element is not reliably played.
    this.sink = document.createElement('audio')
    this.sink.autoplay = true
    this.sink.className = 'voice-sink'
    document.body.append(this.sink)
    playOn(this.sink)

    this.pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track])
      this.sink.srcObject = stream
      void this.sink.play().catch(() => undefined)
      hooks.onAudio(stream)
    }
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) hooks.send('vice', ev.candidate.toJSON())
    }
    this.pc.onconnectionstatechange = () => {
      this.live = this.pc.connectionState === 'connected'
      if (this.pc.connectionState === 'failed') {
        hooks.onFailed()
        this.close()
      }
      hooks.onChange()
    }
  }

  private lostBefore = 0
  private gotBefore = 0

  async quality(): Promise<Omit<LinkQuality, 'peerId'>> {
    const none = { pingMs: null, jitterMs: null, lossPct: null }
    let report: RTCStatsReport
    try {
      report = await this.pc.getStats()
    } catch {
      return none
    }
    let pair: Record<string, unknown> | undefined
    let inbound: Record<string, unknown> | undefined
    let chosen = ''
    report.forEach((stat: Record<string, unknown>) => {
      if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') chosen = stat.selectedCandidatePairId
    })
    report.forEach((stat: Record<string, unknown>) => {
      if (stat.type === 'candidate-pair' && (stat.id === chosen || (!chosen && stat.nominated && stat.state === 'succeeded'))) {
        pair = stat
      }
      if (stat.type === 'inbound-rtp' && stat.kind === 'audio') inbound = stat
    })
    const rtt = typeof pair?.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : null
    const jitter = typeof inbound?.jitter === 'number' ? inbound.jitter : null
    let lossPct: number | null = null
    if (inbound && typeof inbound.packetsLost === 'number' && typeof inbound.packetsReceived === 'number') {
      const lost = inbound.packetsLost - this.lostBefore
      const got = inbound.packetsReceived - this.gotBefore
      this.lostBefore = inbound.packetsLost
      this.gotBefore = inbound.packetsReceived
      if (lost + got > 0) lossPct = Math.max(0, (lost / (lost + got)) * 100)
    }
    return {
      pingMs: rtt === null ? null : Math.round(rtt * 1000),
      jitterMs: jitter === null ? null : Math.round(jitter * 1000),
      lossPct,
    }
  }

  stale(): boolean {
    return !this.live && Date.now() - this.startedAt > STALE_CALL_MS
  }

  async useMic(mic: MediaStream): Promise<void> {
    this.mic = mic
    const track = mic.getAudioTracks()[0]
    const audio = this.pc.getTransceivers().find((t) => t.sender.track?.kind === 'audio' || t.receiver.track?.kind === 'audio')
    if (track && audio && !this.closed) await audio.sender.replaceTrack(track).catch(() => undefined)
  }

  speakers(): void {
    playOn(this.sink)
  }

  setDeaf(deaf: boolean): void {
    this.sink.muted = deaf
  }

  setVolume(level: number): void {
    this.sink.volume = Math.min(1, Math.max(0, level))
  }

  async dial(): Promise<void> {
    if (this.closed) return
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer())
      this.hooks.send('voffer', { sdp: this.pc.localDescription?.sdp, type: 'offer' })
    } catch {
      this.close()
    }
  }

  async onOffer(desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) return
    try {
      await this.pc.setRemoteDescription(desc)
      this.hasRemote = true
      await this.drain()

      const track = this.mic.getAudioTracks()[0]
      const audio = this.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio')
      if (track && audio) {
        await audio.sender.replaceTrack(track)
        audio.direction = 'sendrecv'
      }

      await this.pc.setLocalDescription(await this.pc.createAnswer())
      this.hooks.send('vanswer', { sdp: this.pc.localDescription?.sdp, type: 'answer' })
    } catch {
      this.close()
    }
  }

  async onAnswer(desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed || this.pc.signalingState !== 'have-local-offer') return
    try {
      await this.pc.setRemoteDescription(desc)
      this.hasRemote = true
      await this.drain()
    } catch {
      this.close()
    }
  }

  async onIce(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.closed) return
    if (!this.hasRemote) {
      this.pending.push(candidate)
      return
    }
    await this.pc.addIceCandidate(candidate).catch(() => undefined)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.live = false
    this.pc.ontrack = null
    this.pc.onicecandidate = null
    this.pc.onconnectionstatechange = null
    this.sink.srcObject = null
    this.sink.remove()
    try {
      this.pc.close()
    } catch {
      /* already closed */
    }
  }

  private async drain(): Promise<void> {
    for (const c of this.pending.splice(0)) {
      await this.pc.addIceCandidate(c).catch(() => undefined)
    }
  }
}
