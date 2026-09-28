// HEVC (what iPhones record) to H.264, which every browser plays, with the browser's own video decoder and
// encoder. That runs many times faster than real time, where playing the video through and recording it
// (reencode in files.ts) takes as long as the video. It all happens on this device: the file is sealed
// after, so the server never sees it.

/** The longest side of a converted video, as reencode keeps it. */
const LONGEST = 1920

/** The video as H.264 MP4, or null when this browser cannot convert it this way. */
export async function convertQuickly(
  file: File,
  onPart: (part: number) => void,
  signal: AbortSignal,
): Promise<File | null> {
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') return null
  // Loaded only when a video needs it: it is big, and most messages have no video.
  const mb = await import('mediabunny')
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video || !(await video.canDecode())) return null
    const across = await video.getDisplayWidth()
    const down = await video.getDisplayHeight()
    if (!across || !down) return null
    const scale = Math.min(1, LONGEST / Math.max(across, down))
    const width = Math.round((across * scale) / 2) * 2
    const height = Math.round((down * scale) / 2) * 2
    if (!(await mb.canEncodeVideo('avc', { width, height }))) return null

    const target = new mb.BufferTarget()
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target })
    const conversion = await mb.Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: { codec: 'avc', width, height, fit: 'contain', quality: mb.QUALITY_MEDIUM, forceTranscode: true },
      // AAC is copied as it is; anything else becomes AAC.
      audio: { codec: 'aac' },
      showWarnings: false,
    })
    // A video that would lose its sound here goes the slow way, which keeps it.
    if (!conversion.isValid || conversion.discardedTracks.some((d) => d.track.type === 'audio')) return null

    conversion.onProgress = (part) => onPart(part)
    const stop = (): void => void conversion.cancel()
    signal.addEventListener('abort', stop, { once: true })
    try {
      await conversion.execute()
    } finally {
      signal.removeEventListener('abort', stop)
    }
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError')
    if (!target.buffer) return null
    const name = `${file.name.replace(/\.[^.]+$/, '') || 'video'}.mp4`
    return new File([target.buffer], name, { type: 'video/mp4', lastModified: file.lastModified })
  } finally {
    input.dispose()
  }
}
