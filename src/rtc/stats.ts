/**
 * getStats, reduced to the handful of numbers a person can act on.
 *
 * The host uses availableOutKbps to keep the upload budget honest. Both sides
 * use loss and round trip time for the quality badge.
 */

export interface StatsSnapshot {
  kbps: number
  fps: number
  width: number
  height: number
  lossPct: number
  rttMs: number
  jitterMs: number
  availableOutKbps: number
  /** Chrome tells us why it dropped quality: 'cpu', 'bandwidth', 'none'. */
  limitation: string
  codec: string
  /**
   * Milliseconds of processor time per encoded frame. Chrome does not report
   * whether the encoder is on the GPU, so this is the honest proxy: compare it
   * against the frame interval to see how much of the budget encoding eats.
   */
  encodeMsPerFrame: number
  /** The encoder name, when the browser names it. Many do not. */
  encoderImpl: string
  /** 'host' is same network, 'srflx' is through NAT, 'relay' is through TURN. */
  path: string
  audioKbps: number
}

export const EMPTY_STATS: StatsSnapshot = {
  kbps: 0,
  fps: 0,
  width: 0,
  height: 0,
  lossPct: 0,
  rttMs: 0,
  jitterMs: 0,
  availableOutKbps: 0,
  limitation: 'none',
  codec: '',
  encodeMsPerFrame: 0,
  encoderImpl: '',
  path: '',
  audioKbps: 0,
}

type Any = Record<string, unknown>

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export class StatsTracker {
  private readonly pc: RTCPeerConnection
  private readonly direction: 'out' | 'in'

  private lastAt = 0
  private lastVideoBytes = 0
  private lastAudioBytes = 0
  private lastPacketsLost = 0
  private lastPacketsTotal = 0
  private lastEncodeTime = 0
  private lastFramesEncoded = 0
  private encodeMs = 0

  constructor(pc: RTCPeerConnection, direction: 'out' | 'in') {
    this.pc = pc
    this.direction = direction
  }

  async sample(): Promise<StatsSnapshot> {
    let report: RTCStatsReport
    try {
      report = await this.pc.getStats()
    } catch {
      return { ...EMPTY_STATS }
    }

    const rtpType = this.direction === 'out' ? 'outbound-rtp' : 'inbound-rtp'
    const byId = new Map<string, Any>()
    let video: Any | null = null
    let audio: Any | null = null
    let remote: Any | null = null
    let pair: Any | null = null

    report.forEach((entry) => {
      const s = entry as unknown as Any
      byId.set(str(s.id), s)
      const type = str(s.type)
      if (type === rtpType && str(s.kind) === 'video') video = s
      else if (type === rtpType && str(s.kind) === 'audio') audio = s
      else if (this.direction === 'out' && type === 'remote-inbound-rtp' && str(s.kind) === 'video')
        remote = s
      else if (type === 'candidate-pair' && (s.nominated === true || str(s.state) === 'succeeded')) {
        // Prefer the pair that is actually moving bytes.
        if (!pair || num(s.bytesSent) > num(pair.bytesSent)) pair = s
      }
    })

    const v = video as Any | null
    const a = audio as Any | null
    const r = remote as Any | null
    const p = pair as Any | null

    const now = performance.now()
    const videoBytes = num(this.direction === 'out' ? v?.bytesSent : v?.bytesReceived)
    const audioBytes = num(this.direction === 'out' ? a?.bytesSent : a?.bytesReceived)

    let kbps = 0
    let audioKbps = 0
    if (this.lastAt > 0) {
      const seconds = (now - this.lastAt) / 1000
      if (seconds > 0.2) {
        kbps = Math.max(0, ((videoBytes - this.lastVideoBytes) * 8) / 1000 / seconds)
        audioKbps = Math.max(0, ((audioBytes - this.lastAudioBytes) * 8) / 1000 / seconds)
      }
    }

    // Loss. Outbound learns it from the receiver report, inbound counts its own.
    const lossSource = this.direction === 'out' ? r : v
    const packetsLost = num(lossSource?.packetsLost)
    const packetsTotal =
      this.direction === 'out' ? num(v?.packetsSent) : num(v?.packetsReceived) + packetsLost

    let lossPct = 0
    if (this.lastAt > 0) {
      const dLost = Math.max(0, packetsLost - this.lastPacketsLost)
      const dTotal = Math.max(0, packetsTotal - this.lastPacketsTotal)
      if (dTotal > 0) lossPct = Math.min(100, (dLost / (dTotal + dLost)) * 100)
    }

    this.lastAt = now
    this.lastVideoBytes = videoBytes
    this.lastAudioBytes = audioBytes
    this.lastPacketsLost = packetsLost
    this.lastPacketsTotal = packetsTotal

    // Encoder cost, measured over this interval rather than the whole session.
    if (this.direction === 'out') {
      const encodeTime = num(v?.totalEncodeTime)
      const framesEncoded = num(v?.framesEncoded)
      const dFrames = framesEncoded - this.lastFramesEncoded
      const dTime = encodeTime - this.lastEncodeTime
      if (dFrames > 0 && dTime >= 0) this.encodeMs = (dTime / dFrames) * 1000
      this.lastEncodeTime = encodeTime
      this.lastFramesEncoded = framesEncoded
    }

    const rttSec = this.direction === 'out' ? num(r?.roundTripTime) : num(p?.currentRoundTripTime)
    const codecEntry = v?.codecId ? byId.get(str(v.codecId)) : undefined
    const local = p?.localCandidateId ? byId.get(str(p.localCandidateId)) : undefined
    const remoteCand = p?.remoteCandidateId ? byId.get(str(p.remoteCandidateId)) : undefined
    const localType = str(local?.candidateType)
    const remoteType = str(remoteCand?.candidateType)
    const path =
      localType === 'relay' || remoteType === 'relay' ? 'relay' : localType || remoteType || ''

    return {
      kbps: Math.round(kbps),
      audioKbps: Math.round(audioKbps),
      fps: Math.round(num(v?.framesPerSecond)),
      width: num(v?.frameWidth),
      height: num(v?.frameHeight),
      lossPct: Math.round(lossPct * 10) / 10,
      rttMs: Math.round((rttSec || num(p?.currentRoundTripTime)) * 1000),
      jitterMs: Math.round(num(lossSource?.jitter) * 1000),
      availableOutKbps: Math.round(num(p?.availableOutgoingBitrate) / 1000),
      limitation: str(v?.qualityLimitationReason) || 'none',
      codec: str(codecEntry?.mimeType).split('/')[1] ?? '',
      encodeMsPerFrame: Math.round(this.encodeMs * 100) / 100,
      encoderImpl: str(v?.encoderImplementation),
      path,
    }
  }
}

export type Grade = 'good' | 'ok' | 'poor' | 'none'

export function gradeOf(s: StatsSnapshot): Grade {
  if (s.kbps <= 0) return 'none'
  if (s.lossPct > 5 || s.rttMs > 400) return 'poor'
  if (s.lossPct > 1.5 || s.rttMs > 200 || s.limitation === 'bandwidth') return 'ok'
  return 'good'
}
