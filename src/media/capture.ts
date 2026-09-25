export interface CaptureOptions {
  /** 0 keeps whatever the display gives. */
  maxHeight: number
  fps: number
  wantSystemAudio: boolean
}

export interface ScreenCapture {
  stream: MediaStream
  video: MediaStreamTrack
  systemAudio: MediaStreamTrack | null
}

type CaptureErrorKind = 'denied' | 'unsupported' | 'none' | 'other'

export class CaptureError extends Error {
  readonly kind: CaptureErrorKind

  constructor(kind: CaptureErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = 'CaptureError'
  }
}

function supportsScreenCapture(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
}

export async function captureScreen(options: CaptureOptions): Promise<ScreenCapture> {
  if (!supportsScreenCapture()) {
    throw new CaptureError(
      'unsupported',
      'This browser cannot capture a screen. On an iPhone or an iPad no browser can. You can still watch a stream.',
    )
  }

  const video: MediaTrackConstraints = { frameRate: { ideal: options.fps, max: 60 } }
  if (options.maxHeight > 0) {
    video.height = { max: options.maxHeight }
    video.width = { max: Math.round((options.maxHeight * 16) / 9) }
  }

  // The extra fields are Chromium only. Other browsers ignore what they do not know.
  const constraints = {
    video,
    audio: options.wantSystemAudio
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : false,
    systemAudio: options.wantSystemAudio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    preferCurrentTab: false,
  } as unknown as DisplayMediaStreamOptions

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(constraints)
  } catch (err) {
    throw toCaptureError(err)
  }

  const track = stream.getVideoTracks()[0]
  if (!track) {
    throw new CaptureError('none', 'The browser returned no picture. Try the share again.')
  }

  return {
    stream,
    video: track,
    systemAudio: stream.getAudioTracks()[0] ?? null,
  }
}

function toCaptureError(err: unknown): CaptureError {
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CaptureError('denied', 'You did not allow the screen share.')
  }
  if (name === 'NotFoundError' || name === 'NotReadableError') {
    return new CaptureError('none', 'Found no screen to use.')
  }
  if (name === 'AbortError') {
    return new CaptureError('denied', 'The screen share stopped before it started.')
  }
  return new CaptureError('other', `The screen share failed: ${String(err)}`)
}
