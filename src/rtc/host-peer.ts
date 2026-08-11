/**
 * One HostPeer is one viewer.
 *
 * The host is always the offerer, in the first negotiation and in every later
 * one. That removes the glare problem, so we do not need the perfect
 * negotiation dance. The viewer only ever answers.
 */

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
  send: (type: 'offer' | 'ice', data: unknown) => void
  onChange: () => void
  onFailed: (reason: string) => void
}

export class HostPeer {
  readonly id: string
  readonly pc: RTCPeerConnection
  readonly joinedAt = Date.now()

  state: RTCPeerConnectionState = 'new'
  /** When the state last changed. The host uses it to clear away dead viewers. */
  stateSince = Date.now()
  stats: StatsSnapshot = { ...EMPTY_STATS }
  plan: QualityPlan | null = null
  codec: string | null = null

  private readonly opts: HostPeerOptions
  private readonly tracker: StatsTracker
  private videoSender: RTCRtpSender | null = null
  private audioSender: RTCRtpSender | null = null
  private videoTransceiver: RTCRtpTransceiver | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private makingOffer = false
  private hasRemote = false
  private restarted = false
  private closed = false

  constructor(opts: HostPeerOptions) {
    this.opts = opts
    this.id = opts.viewerId
    this.pc = new RTCPeerConnection(rtcConfig())
    this.tracker = new StatsTracker(this.pc, 'out')

    const video = opts.stream.getVideoTracks()[0] ?? null
    const audio = opts.stream.getAudioTracks()[0] ?? null

    if (video) {
      applyContentHint(video, opts.mode)
      this.videoTransceiver = this.pc.addTransceiver(video, {
        direction: 'sendonly',
        streams: [opts.stream],
      })
      this.videoSender = this.videoTransceiver.sender
      this.codec = preferCodecs(this.videoTransceiver, opts.mode, opts.codec)
    }
    if (audio) {
      this.audioSender = this.pc.addTransceiver(audio, {
        direction: 'sendonly',
        streams: [opts.stream],
      }).sender
    }

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) opts.send('ice', ev.candidate.toJSON())
    }

    this.pc.onnegotiationneeded = () => {
      void this.negotiate()
    }

    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState !== this.state) this.stateSince = Date.now()
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
      this.opts.onFailed(`Beam could not make an offer: ${String(err)}`)
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
      this.opts.onFailed(`Beam could not read the answer: ${String(err)}`)
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
    if (!this.videoSender || samePlan(this.plan, plan)) return
    this.plan = plan
    await applyPlan(this.videoSender, plan)
  }

  setMode(mode: Mode, codec: CodecChoice): void {
    const track = this.videoSender?.track ?? null
    applyContentHint(track, mode)
    if (this.videoTransceiver && this.pc.signalingState === 'stable') {
      this.codec = preferCodecs(this.videoTransceiver, mode, codec)
    }
  }

  /** Swap the shared surface with no renegotiation. */
  async replaceVideo(track: MediaStreamTrack | null): Promise<void> {
    if (!this.videoSender) return
    await this.videoSender.replaceTrack(track).catch(() => undefined)
  }

  async replaceAudio(track: MediaStreamTrack | null): Promise<void> {
    if (!this.audioSender) return
    await this.audioSender.replaceTrack(track).catch(() => undefined)
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
    } catch {
      /* already closed */
    }
  }

  private onFailure(): void {
    if (this.closed) return
    if (!this.restarted) {
      // One free retry. A path can break when a viewer switches network.
      this.restarted = true
      try {
        this.pc.restartIce()
      } catch {
        /* not supported, the message below covers it */
      }
      void this.negotiate()
      return
    }
    this.opts.onFailed(
      'The direct connection to this viewer failed. Their network blocks peer to peer traffic.',
    )
  }
}
