import { rtcConfig } from './config'
import {
  applyContentHint,
  applyPlan,
  preferCodecs,
  samePlan,
  type CodecChoice,
  type Mode,
  type QualityPlan,
} from './quality'
import { EMPTY_STATS, StatsTracker, type StatsSnapshot } from './stats'

export interface HostPeerOptions {
  viewerId: string
  stream: MediaStream
  mode: Mode
  codec: CodecChoice
  /** Codecs this machine can encode on the GPU, best first. */
  hardware: string[]
  send: (type: 'offer' | 'ice', data: unknown) => void
  onChange: () => void
  onFailed: (reason: string) => void
}

// The host always offers and the viewer only answers, so there is no glare.
export class HostPeer {
  readonly id: string
  readonly pc: RTCPeerConnection

  state: RTCPeerConnectionState = 'new'
  stats: StatsSnapshot = { ...EMPTY_STATS }
  plan: QualityPlan | null = null

  private readonly opts: HostPeerOptions
  private readonly tracker: StatsTracker
  private readonly video: RTCRtpTransceiver | null = null
  private readonly pendingCandidates: RTCIceCandidateInit[] = []
  private makingOffer = false
  private hasRemote = false
  private iceRestarted = false
  private closed = false

  constructor(opts: HostPeerOptions) {
    this.opts = opts
    this.id = opts.viewerId
    this.pc = new RTCPeerConnection(rtcConfig())
    this.tracker = new StatsTracker(this.pc, 'out')

    const video = opts.stream.getVideoTracks()[0]
    const audio = opts.stream.getAudioTracks()[0]

    if (video) {
      applyContentHint(video, opts.mode)
      this.video = this.pc.addTransceiver(video, { direction: 'sendonly', streams: [opts.stream] })
      preferCodecs(this.video, opts.mode, opts.codec, opts.hardware)
    }
    if (audio) {
      this.pc.addTransceiver(audio, { direction: 'sendonly', streams: [opts.stream] })
    }

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) opts.send('ice', ev.candidate.toJSON())
    }

    this.pc.onnegotiationneeded = () => {
      void this.negotiate()
    }

    this.pc.onconnectionstatechange = () => {
      this.state = this.pc.connectionState
      if (this.state === 'failed') this.onFailure()
      opts.onChange()
    }

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') this.onFailure()
    }
  }

  async negotiate(): Promise<void> {
    if (this.closed || this.makingOffer) return
    this.makingOffer = true
    try {
      const offer = await this.pc.createOffer()
      if (this.closed) return
      await this.pc.setLocalDescription(offer)
      this.opts.send('offer', { sdp: this.pc.localDescription?.sdp, type: 'offer' })
    } catch (err) {
      this.opts.onFailed(`Could not make an offer: ${String(err)}`)
    } finally {
      this.makingOffer = false
    }
  }

  async onAnswer(desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) return
    try {
      if (this.pc.signalingState !== 'have-local-offer') return
      await this.pc.setRemoteDescription(desc)
      this.hasRemote = true
      for (const c of this.pendingCandidates.splice(0)) {
        await this.pc.addIceCandidate(c).catch(() => undefined)
      }
    } catch (err) {
      this.opts.onFailed(`Could not read the answer: ${String(err)}`)
    }
  }

  async onIce(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.closed) return
    if (!this.hasRemote) {
      this.pendingCandidates.push(candidate)
      return
    }
    await this.pc.addIceCandidate(candidate).catch(() => undefined)
  }

  async setPlan(plan: QualityPlan): Promise<void> {
    if (!this.video || samePlan(this.plan, plan)) return
    this.plan = plan
    await applyPlan(this.video.sender, plan)
  }

  setMode(mode: Mode, codec: CodecChoice, hardware: string[]): void {
    applyContentHint(this.video?.sender.track ?? null, mode)
    if (this.video && this.pc.signalingState === 'stable') {
      preferCodecs(this.video, mode, codec, hardware)
    }
  }

  async sample(): Promise<StatsSnapshot> {
    this.stats = await this.tracker.sample()
    return this.stats
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.pc.onicecandidate = null
    this.pc.onnegotiationneeded = null
    this.pc.onconnectionstatechange = null
    this.pc.oniceconnectionstatechange = null
    try {
      this.pc.close()
    } catch {}
  }

  private onFailure(): void {
    if (this.closed) return
    if (!this.iceRestarted) {
      this.iceRestarted = true
      try {
        this.pc.restartIce()
      } catch {}
      void this.negotiate()
      return
    }
    this.opts.onFailed(
      'The direct connection to this viewer failed. Their network blocks peer to peer traffic.',
    )
  }
}
