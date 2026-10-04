export type Mode = 'text' | 'motion'
type Degradation = 'maintain-framerate' | 'maintain-resolution' | 'balanced'

export interface QualityPlan {
  maxBitrateKbps: number
  scaleDown: number
  maxFramerate: number
  degradation: Degradation
}

interface QualityInput {
  mode: Mode
  /** Total upload for all viewers together. */
  budgetKbps: number
  viewerCount: number
  width: number
  height: number
  fps: number
  bitrateScale: number
}

/** No stream goes out bigger than 1080p: its long side at most 1920, its short side at most 1080. */
export const MOST_LONG = 1920
export const MOST_SHORT = 1080

/** The height a capture asks for: what a preset or a setting says, but never past 1080. 0 was "the display's own". */
export function capHeight(height: number): number {
  return height > 0 ? Math.min(height, MOST_SHORT) : MOST_SHORT
}

/** How much a picture of this size is made smaller to fit in 1080p, or 1 when it fits already. */
export function fitScale(width: number, height: number): number {
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  return Math.max(1, long / MOST_LONG, short / MOST_SHORT)
}

export type PresetId = 'docs' | 'slides' | 'video' | 'game' | 'detail' | 'light' | 'custom'

interface Preset {
  id: PresetId
  name: string
  useWhen: string
  mode: Mode
  /** The most the capture asks for. Never past 1080: see capHeight. */
  maxHeight: number
  fps: number
  bitrateScale: number
}

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
      'The default. Use for a game, a video, or anything where the whole picture moves. Fine tuning has 60 frames if your machine and your upload can carry it.',
    mode: 'motion',
    maxHeight: 1080,
    fps: 30,
    bitrateScale: 1.3,
  },
  {
    id: 'detail',
    name: 'Maximum detail',
    useWhen:
      'Use for photo work or drawings, where every pixel counts. Needs a fast upload and a strong processor.',
    mode: 'text',
    maxHeight: 1080,
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

export const DEFAULT_PRESET: PresetId = 'game'

export function presetById(id: PresetId): Preset | null {
  return PRESETS.find((p) => p.id === id) ?? null
}

const IDEAL_KBPS_BY_PIXELS: { maxPixels: number; text: number; motion: number }[] = [
  { maxPixels: 960 * 540, text: 700, motion: 1100 },
  { maxPixels: 1280 * 720, text: 1200, motion: 2000 },
  { maxPixels: 1920 * 1080, text: 2500, motion: 4000 },
  { maxPixels: 2560 * 1440, text: 4000, motion: 6000 },
  { maxPixels: Number.MAX_SAFE_INTEGER, text: 6000, motion: 10000 },
]

const READABLE_FLOOR_KBPS = 300

function idealBitrateKbps(mode: Mode, width: number, height: number, bitrateScale: number, fps: number): number {
  const pixels = Math.max(1, width * height)
  const step =
    IDEAL_KBPS_BY_PIXELS.find((s) => pixels <= s.maxPixels) ?? IDEAL_KBPS_BY_PIXELS[IDEAL_KBPS_BY_PIXELS.length - 1]
  const base = mode === 'text' ? step.text : step.motion
  const fpsFactor = Math.min(1.35, Math.max(0.55, (fps / 30) ** 0.5))
  return Math.round(base * bitrateScale * fpsFactor)
}

export function planFor(input: QualityInput): QualityPlan {
  const { mode, budgetKbps, viewerCount, width, height, fps, bitrateScale } = input
  // A display past 1080p, or a capture the browser would not make smaller, is made smaller here.
  const fit = fitScale(width, height)
  const ideal = idealBitrateKbps(mode, width / fit, height / fit, bitrateScale, fps)
  const share = Math.floor(budgetKbps / Math.max(1, viewerCount))
  const maxBitrateKbps = Math.max(READABLE_FLOOR_KBPS, Math.min(ideal, share))

  let scaleDown = 1
  const ratio = maxBitrateKbps / ideal
  if (viewerCount > 6 || ratio < 0.3) scaleDown = 2
  else if (ratio < 0.55) scaleDown = 1.5

  return {
    maxBitrateKbps,
    scaleDown: Math.round(fit * scaleDown * 1000) / 1000,
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

// Text stays on VP9 even with a hardware encoder: hardware encoders smear small type.
function codecOrder(mode: Mode, choice: CodecChoice, hardware: string[]): string[] {
  if (choice !== 'auto') return [`video/${choice}`]
  if (mode === 'text') return ['video/VP9', 'video/AV1', 'video/H264', 'video/VP8']

  const accelerated = hardware.map((name) => `video/${name}`)
  const fallback = ['video/VP9', 'video/H264', 'video/AV1', 'video/VP8']
  return [...accelerated, ...fallback.filter((m) => !accelerated.includes(m))]
}

const HELPER_CODECS = new Set(['rtx', 'red', 'ulpfec', 'flexfec-03'])

let codecs: string[] | null = null

/** Asked of the browser once a page: the asking is slow, and the answer does not change. */
export function availableCodecs(): string[] {
  if (codecs) return [...codecs]
  const caps = typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('video') : null
  if (!caps) return []
  const names = new Set<string>()
  for (const c of caps.codecs) {
    const short = c.mimeType.split('/')[1]?.toLowerCase()
    if (short && !HELPER_CODECS.has(short)) names.add(short.toUpperCase())
  }
  codecs = [...names]
  return [...codecs]
}

export function preferCodecs(
  transceiver: RTCRtpTransceiver,
  mode: Mode,
  choice: CodecChoice,
  hardware: string[],
): void {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video')
    if (!caps || typeof transceiver.setCodecPreferences !== 'function') return

    const wanted = codecOrder(mode, choice, hardware).map((m) => m.toLowerCase())
    const rank = (mime: string): number => {
      const i = wanted.indexOf(mime.toLowerCase())
      return i === -1 ? wanted.length + 1 : i
    }
    const isHelper = (mime: string): boolean => HELPER_CODECS.has(mime.split('/')[1]?.toLowerCase() ?? '')

    // Keep the helper payload types, but push them behind the real codecs.
    const sorted = [...caps.codecs].sort((a, b) => {
      const ha = isHelper(a.mimeType) ? 1 : 0
      const hb = isHelper(b.mimeType) ? 1 : 0
      if (ha !== hb) return ha - hb
      return rank(a.mimeType) - rank(b.mimeType)
    })

    if (sorted.length > 0) transceiver.setCodecPreferences(sorted)
  } catch {}
}
