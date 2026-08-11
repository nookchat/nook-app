/**
 * Quality control.
 *
 * A mesh host encodes and sends the picture once per viewer. Upload and
 * processor time are therefore the two hard limits. This module turns one
 * choice by the host, a preset, into concrete sender settings for every viewer.
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
  fps: number
  /** Multiplier on the ladder below. Under one means more compression. */
  bitrateScale: number
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type PresetId = 'docs' | 'slides' | 'video' | 'game' | 'detail' | 'light' | 'custom'

export interface Preset {
  id: PresetId
  name: string
  /** A concrete example, so the host does not have to guess. */
  useWhen: string
  mode: Mode
  /** Source height cap. 0 keeps whatever the display gives. */
  maxHeight: number
  fps: number
  bitrateScale: number
}

/**
 * The default is deliberately not the highest setting. A screen share is read,
 * not admired, and a smaller picture starts faster, stays sharp on text, and
 * leaves room for more viewers.
 */
export const PRESETS: Preset[] = [
  {
    id: 'docs',
    name: 'Code and documents',
    useWhen:
      'Use for an editor, a terminal, a spreadsheet, or a PDF. Text stays sharp and the picture starts fast.',
    mode: 'text',
    maxHeight: 1080,
    fps: 15,
    bitrateScale: 0.7,
  },
  {
    id: 'slides',
    name: 'Slides and walkthroughs',
    useWhen:
      'Use for a presentation, a design review, or a tour of an app. Sharp text, and smooth enough to follow a cursor.',
    mode: 'text',
    maxHeight: 1080,
    fps: 24,
    bitrateScale: 0.9,
  },
  {
    id: 'video',
    name: 'Video and motion',
    useWhen:
      'Use for a film, a game, an animation, or a call. Movement stays smooth, and fine detail gives way first.',
    mode: 'motion',
    maxHeight: 1080,
    fps: 30,
    bitrateScale: 1,
  },
  {
    id: 'game',
    name: 'Games',
    useWhen:
      'Use for a fast game at 60 frames. Every frame is new, so this needs a strong processor and a fast upload. Watch the encode figure while you play.',
    mode: 'motion',
    maxHeight: 1080,
    fps: 60,
    bitrateScale: 1.3,
  },
  {
    id: 'detail',
    name: 'Maximum detail',
    useWhen:
      'Use for photo work, drawings, or a 4K display where every pixel counts. Needs a fast upload and a strong processor.',
    mode: 'text',
    maxHeight: 0,
    fps: 30,
    bitrateScale: 1.4,
  },
  {
    id: 'light',
    name: 'Slow connection',
    useWhen:
      'Use on hotel wifi, a phone hotspot, or with many viewers. The picture is smaller, and it keeps moving.',
    mode: 'text',
    maxHeight: 720,
    fps: 10,
    bitrateScale: 0.5,
  },
]

export const DEFAULT_PRESET: PresetId = 'docs'

export function presetById(id: PresetId): Preset | null {
  return PRESETS.find((p) => p.id === id) ?? null
}

export const RESOLUTION_CHOICES: { label: string; height: number; note: string }[] = [
  { label: 'Original', height: 0, note: 'Whatever the display gives, up to 4K' },
  { label: '1440p', height: 1440, note: 'Sharp on a large monitor' },
  { label: '1080p', height: 1080, note: 'Sharp text, quick to start' },
  { label: '720p', height: 720, note: 'Kind to a slow upload' },
  { label: '540p', height: 540, note: 'Last resort, or a wide mesh' },
]

export const FPS_CHOICES: { label: string; fps: number; note: string }[] = [
  { label: '5 fps', fps: 5, note: 'Still pages only' },
  { label: '10 fps', fps: 10, note: 'Reading, very low bandwidth' },
  { label: '15 fps', fps: 15, note: 'Documents and code' },
  { label: '24 fps', fps: 24, note: 'Slides and scrolling' },
  { label: '30 fps', fps: 30, note: 'Video and games' },
  { label: '60 fps', fps: 60, note: 'Fast games, costs a lot' },
]

// ---------------------------------------------------------------------------
// The bitrate ladder
// ---------------------------------------------------------------------------

/** What one stream wants when bandwidth is free. Kilobits per second. */
const LADDER: { maxPixels: number; text: number; motion: number }[] = [
  { maxPixels: 960 * 540, text: 700, motion: 1100 },
  { maxPixels: 1280 * 720, text: 1200, motion: 2000 },
  { maxPixels: 1920 * 1080, text: 2500, motion: 4000 },
  { maxPixels: 2560 * 1440, text: 4000, motion: 6000 },
  { maxPixels: Number.MAX_SAFE_INTEGER, text: 6000, motion: 10000 },
]

/** Below this a screen share stops being readable, so we never go under it. */
const FLOOR_KBPS = 300

export function idealBitrateKbps(
  mode: Mode,
  width: number,
  height: number,
  bitrateScale = 1,
  fps = 30,
): number {
  const pixels = Math.max(1, width * height)
  const step = LADDER.find((s) => pixels <= s.maxPixels) ?? LADDER[LADDER.length - 1]
  const base = mode === 'text' ? step.text : step.motion
  // Frame rate moves the bill, but not in a straight line. Half the frames cost
  // well over half the bits, because each frame still carries new detail.
  const fpsFactor = Math.min(1.35, Math.max(0.55, (fps / 30) ** 0.5))
  return Math.round(base * bitrateScale * fpsFactor)
}

export function planFor(input: QualityInput): QualityPlan {
  const { mode, budgetKbps, viewerCount, width, height, fps, bitrateScale } = input
  const ideal = idealBitrateKbps(mode, width, height, bitrateScale, fps)
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
    maxFramerate: fps,
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

export type CodecChoice = 'auto' | 'AV1' | 'VP9' | 'VP8' | 'H264' | 'H265'

/**
 * VP9 and AV1 carry screen text far better per bit than VP8 or H264, because
 * they have screen content coding tools. VP9 first for text: AV1 encodes are
 * expensive, and a mesh host runs one encode per viewer.
 *
 * Moving pictures take a different route. If this machine has a hardware
 * encoder, that comes first, because it holds the same resolution for less than
 * half the processor and leaves the rest for the game or the video. Text stays
 * on VP9 whatever the hardware offers, since a hardware encoder is tuned for
 * camera video and smears small type.
 */
function codecOrder(mode: Mode, choice: CodecChoice, hardware: string[] = []): string[] {
  if (choice !== 'auto') return [`video/${choice}`]
  if (mode === 'text') return ['video/VP9', 'video/AV1', 'video/H264', 'video/VP8']

  const accelerated = hardware.map((name) => `video/${name}`)
  const fallback = ['video/VP9', 'video/H264', 'video/AV1', 'video/VP8']
  return [...accelerated, ...fallback.filter((m) => !accelerated.includes(m))]
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
  hardware: string[] = [],
): string | null {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video')
    if (!caps || typeof transceiver.setCodecPreferences !== 'function') return null

    const wanted = codecOrder(mode, choice, hardware).map((m) => m.toLowerCase())
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
