/**
 * Quality control.
 *
 * A mesh host encodes and sends the picture once per viewer. Upload and CPU are
 * therefore the two hard limits. This module turns one simple choice by the
 * host, Text mode or Video mode, plus one upload budget, into concrete sender
 * settings for every viewer.
 */

export type Mode = 'text' | 'motion'
export type Degradation = 'maintain-framerate' | 'maintain-resolution' | 'balanced'

export interface QualityPlan {
  maxBitrateKbps: number
  scaleDown: number
  maxFramerate: number
  degradation: Degradation
}

export interface QualityInput {
  mode: Mode
  /** Total upload the host allows for all viewers together, in kilobits. */
  budgetKbps: number
  viewerCount: number
  width: number
  height: number
}

/** What one stream wants when bandwidth is free. Kilobits per second. */
const LADDER: { maxPixels: number; text: number; motion: number }[] = [
  { maxPixels: 1280 * 720, text: 1200, motion: 2000 },
  { maxPixels: 1920 * 1080, text: 2500, motion: 4000 },
  { maxPixels: 2560 * 1440, text: 4000, motion: 6000 },
  { maxPixels: Number.MAX_SAFE_INTEGER, text: 6000, motion: 10000 },
]

/** Below this a screen share stops being readable, so we never go under it. */
const FLOOR_KBPS = 350

export function idealBitrateKbps(mode: Mode, width: number, height: number): number {
  const pixels = Math.max(1, width * height)
  const step = LADDER.find((s) => pixels <= s.maxPixels) ?? LADDER[LADDER.length - 1]
  return mode === 'text' ? step.text : step.motion
}

export function defaultFramerate(mode: Mode): number {
  // Text stays readable at a low frame rate, and the saved bits go into detail.
  return mode === 'text' ? 15 : 30
}

export function planFor(input: QualityInput): QualityPlan {
  const { mode, budgetKbps, viewerCount, width, height } = input
  const ideal = idealBitrateKbps(mode, width, height)
  const share = Math.floor(budgetKbps / Math.max(1, viewerCount))
  const maxBitrateKbps = Math.max(FLOOR_KBPS, Math.min(ideal, share))

  // When the share is far below the ideal, sending fewer pixels beats sending
  // the same pixels badly. The same is true once the mesh gets wide.
  let scaleDown = 1
  const ratio = maxBitrateKbps / ideal
  if (viewerCount > 6 || ratio < 0.3) scaleDown = 2
  else if (ratio < 0.55) scaleDown = 1.5

  return {
    maxBitrateKbps,
    scaleDown,
    maxFramerate: defaultFramerate(mode),
    degradation: mode === 'text' ? 'maintain-resolution' : 'maintain-framerate',
  }
}

export function samePlan(a: QualityPlan | null, b: QualityPlan): boolean {
  if (!a) return false
  return (
    a.maxBitrateKbps === b.maxBitrateKbps &&
    a.scaleDown === b.scaleDown &&
    a.maxFramerate === b.maxFramerate &&
    a.degradation === b.degradation
  )
}

/** Push a plan onto one video sender. Browsers vary, so every field is guarded. */
export async function applyPlan(sender: RTCRtpSender, plan: QualityPlan): Promise<void> {
  try {
    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}]
    }
    const e = params.encodings[0]
    e.maxBitrate = plan.maxBitrateKbps * 1000
    e.scaleResolutionDownBy = plan.scaleDown
    e.maxFramerate = plan.maxFramerate
    // Firefox does not know this field. Setting it there is harmless.
    ;(params as unknown as { degradationPreference?: string }).degradationPreference =
      plan.degradation
    await sender.setParameters(params)
  } catch {
    // An unsupported field must never break the connection.
  }
}

/**
 * Tell the encoder what the picture is. Chrome uses this to choose between
 * sharp text and smooth motion before any bitrate maths happens.
 */
export function applyContentHint(track: MediaStreamTrack | null, mode: Mode): void {
  if (!track) return
  try {
    ;(track as MediaStreamTrack & { contentHint: string }).contentHint =
      mode === 'text' ? 'detail' : 'motion'
  } catch {
    /* older browser, no hint support */
  }
}

export type CodecChoice = 'auto' | 'AV1' | 'VP9' | 'VP8' | 'H264'

/**
 * VP9 and AV1 carry screen text far better per bit than VP8 or H264, because
 * they have screen content coding tools. VP9 first by default: AV1 encodes are
 * expensive, and a mesh host runs one encode per viewer.
 */
function codecOrder(mode: Mode, choice: CodecChoice): string[] {
  if (choice !== 'auto') return [`video/${choice}`]
  return mode === 'text'
    ? ['video/VP9', 'video/AV1', 'video/H264', 'video/VP8']
    : ['video/VP9', 'video/H264', 'video/AV1', 'video/VP8']
}

export function availableCodecs(): string[] {
  const caps = typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('video') : null
  if (!caps) return []
  const names = new Set<string>()
  for (const c of caps.codecs) {
    const short = c.mimeType.split('/')[1]?.toUpperCase()
    if (short && !['RTX', 'RED', 'ULPFEC', 'FLEXFEC-03'].includes(short)) names.add(short)
  }
  return [...names]
}

/** Returns the codec the transceiver now prefers, or null when we could not set one. */
export function preferCodecs(
  transceiver: RTCRtpTransceiver,
  mode: Mode,
  choice: CodecChoice = 'auto',
): string | null {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video')
    if (!caps || typeof transceiver.setCodecPreferences !== 'function') return null

    const wanted = codecOrder(mode, choice).map((m) => m.toLowerCase())
    const rank = (mime: string): number => {
      const i = wanted.indexOf(mime.toLowerCase())
      return i === -1 ? wanted.length + 1 : i
    }

    // Keep the helper payload types, but push them behind the real codecs.
    const helpers = ['video/rtx', 'video/red', 'video/ulpfec', 'video/flexfec-03']
    const isHelper = (m: string): boolean => helpers.includes(m.toLowerCase())

    const sorted = [...caps.codecs].sort((a, b) => {
      const ha = isHelper(a.mimeType) ? 1 : 0
      const hb = isHelper(b.mimeType) ? 1 : 0
      if (ha !== hb) return ha - hb
      return rank(a.mimeType) - rank(b.mimeType)
    })

    if (sorted.length === 0) return null
    transceiver.setCodecPreferences(sorted)
    const first = sorted.find((c) => !isHelper(c.mimeType))
    return first ? first.mimeType.split('/')[1] : null
  } catch {
    return null
  }
}
