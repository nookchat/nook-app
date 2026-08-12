/**
 * Voice channels.
 *
 * A voice channel is somewhere you stand rather than something you send. Join
 * one and you are connected to everybody else standing in it; leave and those
 * connections go.
 *
 * Audio is cheap enough for a full mesh: a dozen people at forty kilobits each
 * is less than one screen share to one watcher. So there is no mixer and no
 * host, just a connection to each person, which also means nobody is a single
 * point of failure and nobody hears a mix they did not choose.
 *
 * Who offers follows the same rule as the chat mesh: the smaller id calls. That
 * is the only coordination needed, and it is why two people joining at the same
 * moment do not knock each other's call down.
 */

import { rtcConfig } from '../rtc/config'
import { explainMicRefusal, micConstraints, micSettings } from './mic'
import { denoise, type Denoiser } from './denoise'
import { Talking } from './talking'
import type { SignalBus } from '../signal/bus'
import type { Envelope } from '../signal/envelope'

export interface VoiceState {
  /** The channel this person is standing in, or null. */
  channel: string | null
  /** True while the microphone is muted but the connection stays up. */
  muted: boolean
}

export class Voice {
  onChange: (() => void) | null = null
  /** Somebody walked into, or out of, the channel we are standing in. */
  onArrival: ((arrived: boolean) => void) | null = null

  private readonly bus: SignalBus
  private readonly selfId: string
  private readonly calls = new Map<string, Call>()
  private readonly talking = new Talking()
  private mic: MediaStream | null = null
  /** The raw microphone, kept so it can be stopped when the cleaned one is. */
  private rawMic: MediaStream | null = null
  private cleaner: Denoiser | null = null
  private channel: string | null = null
  private muted = false
  /** Where everybody else is standing, from their announcements. */
  private readonly standing = new Map<string, string>()

  private timer: number | null = null

  constructor(bus: SignalBus, selfId: string) {
    this.bus = bus
    this.selfId = selfId
    this.talking.onChange = () => this.onChange?.()
    this.timer = window.setInterval(() => this.retry(), 5000)
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.leave()
    this.talking.dispose()
  }

  /** True while this person is making a noise we would call speech. */
  isTalking(peerId: string): boolean {
    // Muted is muted, whatever the meter thinks of the room.
    if (peerId === this.selfId && this.muted) return false
    return this.talking.is(peerId)
  }

  get state(): VoiceState {
    return { channel: this.channel, muted: this.muted }
  }

  /** Who is standing in a given voice channel, ourselves included. */
  membersOf(channel: string): string[] {
    const out = [...this.standing.entries()].filter(([, c]) => c === channel).map(([id]) => id)
    if (this.channel === channel) out.push(this.selfId)
    return out
  }

  whereIs(peerId: string): string | null {
    return this.standing.get(peerId) ?? null
  }

  /**
   * Join a voice channel. This must run from a click, because it opens the
   * microphone and because the browser will not play the others without one.
   */
  async join(channel: string): Promise<void> {
    if (this.channel === channel) return
    this.leave()
    try {
      this.rawMic = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints(),
        video: false,
      })
    } catch (err) {
      // The browser asks on its own whenever asking is still possible. This
      // is for when it will not: say which switch is set to no, and where.
      throw new Error(await explainMicRefusal(err))
    }

    /*
     * Put it through the network if that is wanted and possible. When it is
     * not, the microphone goes out as it came: the driver has already done the
     * easy half, and a call with some noise in it beats no call.
     */
    this.mic = this.rawMic
    if (micSettings().smart) {
      this.cleaner = await denoise(this.rawMic)
      if (this.cleaner) this.mic = this.cleaner.stream
    }
    this.channel = channel
    this.muted = false
    // Our own level comes off the cleaned microphone, which is what the others
    // hear, so the light matches what they get rather than what the room does.
    this.talking.add(this.selfId, this.mic)
    this.onChange?.()
    for (const peer of this.membersOf(channel)) this.considerCall(peer)
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
    this.onChange?.()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    // Mute at the source, so nothing reaches the network either.
    for (const track of this.rawMic?.getAudioTracks() ?? []) track.enabled = !muted
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !muted
    this.onChange?.()
  }

  /** The live microphone, so the settings screen can say what it really got. */
  get stream(): MediaStream | null {
    return this.mic
  }

  /** Everyone we can actually hear right now. */
  get connected(): number {
    return [...this.calls.values()].filter((c) => c.live).length
  }

  /** Presence rides on the same announcement the chat mesh sends. */
  noteAnnounce(from: string, voice: string | null): void {
    const was = this.standing.get(from) ?? null
    if (voice) this.standing.set(from, voice)
    else this.standing.delete(from)
    if (was === voice) return

    // Somebody arrived in our channel, or left it.
    if (this.channel && voice === this.channel) {
      this.considerCall(from)
      this.onArrival?.(true)
    }
    if (was === this.channel && voice !== this.channel) {
      this.onArrival?.(false)
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

  /**
   * Drop standings for sessions the mesh no longer knows.
   *
   * Standing rides announcements, and a tab that dies without a goodbye never
   * takes its announcement back, so its owner stood in the channel for ever,
   * including your own last session after a reload. A live call is proof
   * enough to stay: a relay outage empties the roster while the audio keeps
   * flowing, and this must not hang up on it.
   */
  prune(alive: Set<string>): void {
    let changed = false
    for (const id of [...this.standing.keys()]) {
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
        /*
         * Answer anybody who calls while we are standing somewhere. Requiring
         * their announcement first looked tidier and dropped the call whenever
         * the offer overtook the presence, which announcements every few seconds
         * made easy. They only call people they believe are in their channel, so
         * an offer is itself the evidence.
         */
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
    if (this.selfId >= peerId) return // they call us
    const existing = this.calls.get(peerId)
    if (existing && !existing.stale()) return
    // A call that never came up gets another go, in case an offer went missing.
    existing?.close()
    this.calls.delete(peerId)
    void this.call(peerId, true).dial()
  }

  /** Retry anything that has not come up. Cheap, and it recovers a lost offer. */
  private retry(): void {
    if (!this.channel) return
    for (const peer of this.membersOf(this.channel)) this.considerCall(peer)
  }

  private call(peerId: string, weOffer: boolean): Call {
    const existing = this.calls.get(peerId)
    if (existing) return existing
    const call = new Call(this.mic!, weOffer, {
      send: (type, data) => void this.bus.send({ type, to: peerId, data }),
      onChange: () => this.onChange?.(),
      onAudio: (stream) => this.talking.add(peerId, stream),
    })
    this.calls.set(peerId, call)
    return call
  }
}

interface CallHooks {
  send: (type: 'voffer' | 'vanswer' | 'vice', data: unknown) => void
  onChange: () => void
  /** Their voice, once it starts arriving, so its level can be watched. */
  onAudio: (stream: MediaStream) => void
}

/** One voice connection to one person: our microphone out, theirs in. */
class Call {
  live = false

  private readonly startedAt = Date.now()

  /** True once it has had long enough and still is not carrying anything. */
  stale(): boolean {
    return !this.live && Date.now() - this.startedAt > 8000
  }

  private readonly pc: RTCPeerConnection
  private readonly mic: MediaStream
  private readonly hooks: CallHooks
  private readonly sink: HTMLAudioElement
  private pending: RTCIceCandidateInit[] = []
  private hasRemote = false
  private closed = false

  constructor(mic: MediaStream, weOffer: boolean, hooks: CallHooks) {
    this.hooks = hooks
    this.mic = mic
    this.pc = new RTCPeerConnection(rtcConfig())

    /*
     * Only the caller adds a transceiver up front.
     *
     * The side that answers must not, and this cost an evening. Adding one
     * before the offer is applied creates a second, separate m-line, and an
     * answer cannot introduce m-lines the offer did not have. The negotiation
     * still succeeded and the connection still reached "connected", so it looked
     * fine: audio simply travelled one way, from the caller to the answerer and
     * never back. The answering side attaches its microphone to the transceiver
     * the offer brought with it, in onOffer below.
     */
    if (weOffer) {
      for (const track of mic.getAudioTracks()) {
        this.pc.addTransceiver(track, { direction: 'sendrecv', streams: [mic] })
      }
    }

    /*
     * An element per person, so each voice is a separate stream the browser can
     * mix. It goes into the page, hidden: a detached element is not reliably
     * played, and this way the browser owns the audio the way it owns any other.
     */
    this.sink = document.createElement('audio')
    this.sink.autoplay = true
    this.sink.className = 'voice-sink'
    document.body.append(this.sink)

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
      if (this.pc.connectionState === 'failed') this.close()
      hooks.onChange()
    }
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

      // Put our microphone on the transceiver the offer created, rather than
      // making one of our own that the answer could never carry.
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
