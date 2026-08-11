/**
 * The viewer side of one connection. It only answers, never offers, so a
 * renegotiation from the host is always safe.
 */

import { rtcConfig } from './config'
import { EMPTY_STATS, StatsTracker, type StatsSnapshot } from './stats'

export interface ViewerPeerOptions {
  send: (type: 'answer' | 'ice', data: unknown) => void
  onStream: (stream: MediaStream) => void
  onChange: () => void
  onFailed: (reason: string) => void
  /** A line of chat arrived from the host. */
  onChat: (raw: string) => void
  /** The chat channel opened, so anything queued can go now. */
  onChatReady: () => void
}

export class ViewerPeer {
  readonly pc: RTCPeerConnection
  state: RTCPeerConnectionState = 'new'
  stats: StatsSnapshot = { ...EMPTY_STATS }

  private readonly opts: ViewerPeerOptions
  private readonly tracker: StatsTracker
  private readonly stream = new MediaStream()
  private chat: RTCDataChannel | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private hasRemote = false
  private restarted = false
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

    // The host opens the chat channel, so we only have to catch it.
    this.pc.ondatachannel = (ev) => {
      if (ev.channel.label !== 'chat') return
      this.chat = ev.channel
      this.chat.onmessage = (m) => {
        if (typeof m.data === 'string') opts.onChat(m.data)
      }
      this.chat.onopen = () => opts.onChatReady()
      if (this.chat.readyState === 'open') opts.onChatReady()
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

  get chatReady(): boolean {
    return this.chat?.readyState === 'open'
  }

  sendChat(raw: string): void {
    if (this.chat?.readyState !== 'open') return
    try {
      this.chat.send(raw)
    } catch {
      // The channel closed between the check and the send.
    }
  }

  async sample(): Promise<StatsSnapshot> {
    this.stats = await this.tracker.sample()
    return this.stats
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.pc.ontrack = null
    this.pc.ondatachannel = null
    if (this.chat) {
      this.chat.onmessage = null
      this.chat.onopen = null
    }
    this.pc.onicecandidate = null
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
      // The host owns the offer, so we wait one moment for its ICE restart.
      this.restarted = true
      window.setTimeout(() => {
        if (!this.closed && this.pc.connectionState === 'failed') {
          this.opts.onFailed(
            'The direct connection failed. Your network blocks peer to peer traffic. Try another network, or a phone hotspot.',
          )
        }
      }, 6000)
      return
    }
  }
}
