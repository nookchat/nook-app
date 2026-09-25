export interface StatsSnapshot {
  kbps: number
  fps: number
  width: number
  height: number
  lossPct: number
  availableOutKbps: number
  codec: string
  audioKbps: number
}

export const EMPTY_STATS: StatsSnapshot = {
  kbps: 0,
  fps: 0,
  width: 0,
  height: 0,
  lossPct: 0,
  availableOutKbps: 0,
  codec: '',
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

    const out = this.direction === 'out'
    const rtpType = out ? 'outbound-rtp' : 'inbound-rtp'
    let v: Any | undefined
    let a: Any | undefined
    let r: Any | undefined
    let p: Any | undefined

    for (const s of report.values() as IterableIterator<Any>) {
      const type = s.type
      if (type === rtpType) {
        if (s.kind === 'video') v = s
        else if (s.kind === 'audio') a = s
      } else if (out && type === 'remote-inbound-rtp' && s.kind === 'video') {
        r = s
      } else if (type === 'candidate-pair' && (s.nominated === true || s.state === 'succeeded')) {
        // Prefer the pair that is actually moving bytes.
        if (!p || num(s.bytesSent) > num(p.bytesSent)) p = s
      }
    }

    const now = performance.now()
    const videoBytes = num(out ? v?.bytesSent : v?.bytesReceived)
    const audioBytes = num(out ? a?.bytesSent : a?.bytesReceived)

    let kbps = 0
    let audioKbps = 0
    if (this.lastAt > 0) {
      const seconds = (now - this.lastAt) / 1000
      if (seconds > 0.2) {
        kbps = Math.max(0, ((videoBytes - this.lastVideoBytes) * 8) / 1000 / seconds)
        audioKbps = Math.max(0, ((audioBytes - this.lastAudioBytes) * 8) / 1000 / seconds)
      }
    }

    // Outbound learns loss from the receiver report, inbound counts its own.
    const packetsLost = num((out ? r : v)?.packetsLost)
    const packetsTotal = out ? num(v?.packetsSent) : num(v?.packetsReceived) + packetsLost

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

    const codecId = str(v?.codecId)
    const codecEntry: Any | undefined = codecId ? report.get(codecId) : undefined

    return {
      kbps: Math.round(kbps),
      audioKbps: Math.round(audioKbps),
      fps: Math.round(num(v?.framesPerSecond)),
      width: num(v?.frameWidth),
      height: num(v?.frameHeight),
      lossPct: Math.round(lossPct * 10) / 10,
      availableOutKbps: Math.round(num(p?.availableOutgoingBitrate) / 1000),
      codec: str(codecEntry?.mimeType).split('/')[1] ?? '',
    }
  }
}
