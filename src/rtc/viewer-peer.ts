import { rtcConfig } from './config'
import { EMPTY_STATS, StatsTracker, type StatsSnapshot } from './stats'

const HOST_ICE_RESTART_GRACE_MS = 6000

export interface ViewerPeerOptions {
  send: (type: 'answer' | 'ice', data: unknown) => void
  onStream: (stream: MediaStream) => void
  onChange: () => void
  onFailed: (reason: string) => void
}

export class ViewerPeer {
  readonly pc: RTCPeerConnection
  state: RTCPeerConnectionState = 'new'
  stats: StatsSnapshot = { ...EMPTY_STATS }

  private readonly opts: ViewerPeerOptions
  private readonly tracker: StatsTracker
  private readonly stream = new MediaStream()
  private readonly pendingCandidates: RTCIceCandidateInit[] = []
  private hasRemote = false
  private failureSeen = false
  private closed = false

  constructor(opts: ViewerPeerOptions) {
    this.opts = opts
    this.pc = new RTCPeerConnection(rtcConfig())
    this.tracker = new StatsTracker(this.pc, 'in')

    this.pc.ontrack = (ev) => {
      const incoming = ev.streams[0]
      if (incoming) {
        this.opts.onStream(incoming)
        return
      }
      this.stream.addTrack(ev.track)
      this.opts.onStream(this.stream)
    }

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) opts.send('ice', ev.candidate.toJSON())
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

  async onOffer(desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) return
    try {
      await this.pc.setRemoteDescription(desc)
      this.hasRemote = true
      for (const c of this.pendingCandidates.splice(0)) {
        await this.pc.addIceCandidate(c).catch(() => undefined)
      }
      const answer = await this.pc.createAnswer()
      await this.pc.setLocalDescription(answer)
      this.opts.send('answer', { sdp: this.pc.localDescription?.sdp, type: 'answer' })
    } catch (err) {
      this.opts.onFailed(`Could not answer the host: ${String(err)}`)
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

  async sample(): Promise<StatsSnapshot> {
    this.stats = await this.tracker.sample()
    return this.stats
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.pc.ontrack = null
    this.pc.onicecandidate = null
    this.pc.onconnectionstatechange = null
    this.pc.oniceconnectionstatechange = null
    try {
      this.pc.close()
    } catch {}
  }

  private onFailure(): void {
    if (this.closed || this.failureSeen) return
    this.failureSeen = true
    window.setTimeout(() => {
      if (!this.closed && this.pc.connectionState === 'failed') {
        this.opts.onFailed(
          'The direct connection failed. Your network blocks peer to peer traffic. Try another network, or a phone hotspot.',
        )
      }
    }, HOST_ICE_RESTART_GRACE_MS)
  }
}
