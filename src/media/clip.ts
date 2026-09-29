// A clip from a recording: the part you chose, as an MP4 every browser plays, small enough for
// the server. When it can, the clip is copied as it is, which takes as long as reading it. When the
// part is too big for the server, or its video is one some browsers cannot show (HEVC, which Steam
// and NVIDIA can record in), the browser's own encoder makes it H.264, at the bitrate that fits.
// It all happens on this device: the clip is sealed after, as any file is.

/** Video every browser plays in an MP4, so it is copied, not made again. */
const PLAYS_EVERYWHERE = ['avc', 'vp9', 'av1']
/** A clip is made to fill this much of the server's limit, for the MP4's own boxes and a bad guess. */
const FILL = 0.9
const AUDIO_BPS = 128_000
/** Past this, more bits do not make a game clip look better. */
const MOST_VIDEO_BPS = 12_000_000
/** Below this a clip is mush, and a shorter one is the better answer. */
const LEAST_VIDEO_BPS = 450_000

export interface ClipSource {
  url: string
  title: string
  /** The whole recording, to guess the size of a part of it. */
  size: number
  duration: number | null
  at: number
}

export interface ClipRange {
  start: number
  end: number
}

export interface ClipOptions {
  /** The server's limit, in bytes. */
  max: number
  onPart?: (part: number, words: string) => void
  signal?: AbortSignal
}

/** Why a clip could not be made, in words for a toast. */
export class ClipRefused extends Error {}

/** How the clip is made: copied, or made again at this size and bitrate. */
export interface ClipPlan {
  copy: boolean
  /** The longest side, when it is made again. */
  longest?: number
  videoBps?: number
  frameRate?: number
}

/** H.264 needs about this many more bits than HEVC for the same picture. */
const FROM_HEVC = 1.5

/**
 * The plan for a part this long, whose copy would be `copyBytes`. Null when no clip of it fits.
 * Made again, it takes no more bits than the recording had, give or take what H.264 needs more.
 */
export function planClip(copyBytes: number, seconds: number, max: number, playsEverywhere: boolean, fps = 60): ClipPlan | null {
  if (playsEverywhere && copyBytes <= max * FILL) return { copy: true }
  const fits = (max * FILL * 8) / Math.max(0.5, seconds) - AUDIO_BPS
  const had = Number.isFinite(copyBytes) ? ((copyBytes * 8) / Math.max(0.5, seconds)) * FROM_HEVC : Infinity
  return planAt(Math.min(fits, Math.max(LEAST_VIDEO_BPS, had)), fps)
}

/** Made again at this video bitrate, at the size and frame rate that suit it. */
function planAt(bps: number, fps: number): ClipPlan | null {
  const videoBps = Math.min(MOST_VIDEO_BPS, bps)
  if (videoBps < LEAST_VIDEO_BPS) return null
  const longest = videoBps >= 5_000_000 ? 1920 : videoBps >= 2_500_000 ? 1280 : 854
  // Few bits spread over sixty frames a second look worse than the same bits over thirty.
  const frameRate = videoBps < 4_000_000 && fps > 31 ? 30 : undefined
  return { copy: false, longest, videoBps: Math.round(videoBps), frameRate }
}

/** The longest part that still makes a clip for this server, in whole seconds. */
export function longestClip(max: number): number {
  return Math.floor((max * FILL * 8) / (LEAST_VIDEO_BPS + AUDIO_BPS))
}

/** A name for the clip file: the game, and when it was recorded. */
export function clipName(source: ClipSource): string {
  const when = new Date(source.at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}.${pad(when.getMinutes())}`
  const base = source.title.replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Clip'
  return `${base} ${stamp}.mp4`
}

export async function makeClip(source: ClipSource, range: ClipRange, options: ClipOptions): Promise<File> {
  const mb = await import('mediabunny')
  const { signal, onPart } = options
  const seconds = Math.max(0.1, range.end - range.start)
  const input = new mb.Input({ source: new mb.UrlSource(source.url), formats: mb.ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new ClipRefused('This recording has no picture.')
    const total = source.duration ?? (await input.computeDuration())
    const copyGuess = total > 0 ? (source.size * seconds) / total : source.size
    const fps = (await video.computePacketStats(120).catch(() => null))?.averagePacketRate ?? 60
    const everywhere = PLAYS_EVERYWHERE.includes(video.codec ?? '')

    let plan = planClip(copyGuess, seconds, options.max, everywhere, fps)
    if (!plan) throw new ClipRefused(`That part is too long for this server. Pick ${longestClip(options.max)} seconds or less.`)
    // A picture this browser cannot decode cannot be made again: copied as it is, if it fits.
    if (!plan.copy && !(await video.canDecode())) {
      if (copyGuess > options.max * FILL) throw new ClipRefused('This browser cannot compress that part. Pick a shorter part.')
      plan = { copy: true }
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError')
      const bytes = await convert(mb, input, video, range, plan, onPart, signal)
      if (bytes.byteLength <= options.max) {
        return new File([bytes], clipName(source), { type: 'video/mp4', lastModified: source.at })
      }
      // The guess was wrong: made again, smaller, by how far over it came out.
      const made = plan.copy ? (bytes.byteLength * 8) / seconds - AUDIO_BPS : (plan.videoBps ?? 0)
      const next = planAt(made / (bytes.byteLength / (options.max * FILL)) / 1.1, fps)
      if (!next || !(await video.canDecode())) break
      plan = next
    }
    throw new ClipRefused('That part would not fit on this server. Pick a shorter part.')
  } finally {
    input.dispose()
  }
}

type Mediabunny = typeof import('mediabunny')

async function convert(
  mb: Mediabunny,
  input: InstanceType<Mediabunny['Input']>,
  video: Awaited<ReturnType<InstanceType<Mediabunny['Input']>['getPrimaryVideoTrack']>>,
  range: ClipRange,
  plan: ClipPlan,
  onPart: ClipOptions['onPart'],
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  const target = new mb.BufferTarget()
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  let size: { width?: number; height?: number } = {}
  if (!plan.copy && video && plan.longest) {
    const across = await video.getDisplayWidth()
    const down = await video.getDisplayHeight()
    const scale = Math.min(1, plan.longest / Math.max(across, down))
    size = { width: Math.round((across * scale) / 2) * 2, height: Math.round((down * scale) / 2) * 2 }
  }
  const conversion = await mb.Conversion.init({
    input,
    output,
    tracks: 'primary',
    trim: { start: range.start, end: range.end },
    // A copy starts on the key frame at or before the start, and the clip starts at nought.
    copy: plan.copy ? { shiftTolerance: Infinity } : false,
    video: plan.copy
      ? {}
      : {
          codec: 'avc',
          ...size,
          fit: 'contain',
          quality: new mb.Quality({ bitrate: plan.videoBps, bitrateMode: 'variable' }),
          frameRate: plan.frameRate,
          keyFrameInterval: 2,
          forceTranscode: true,
        },
    // AAC is copied as it is; anything else becomes AAC.
    audio: { codec: 'aac', quality: new mb.Quality({ bitrate: AUDIO_BPS }) },
    showWarnings: false,
  })
  if (!conversion.isValid) throw new ClipRefused('This recording cannot be made into a clip here.')
  const words = plan.copy ? 'Cutting' : 'Compressing'
  onPart?.(0, words)
  conversion.onProgress = (part) => onPart?.(part, words)
  const stop = (): void => void conversion.cancel()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    await conversion.execute()
  } finally {
    signal?.removeEventListener('abort', stop)
  }
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError')
  if (!target.buffer) throw new ClipRefused('The clip came out empty.')
  return target.buffer
}
