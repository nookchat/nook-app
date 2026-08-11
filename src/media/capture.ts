/**
 * Screen and microphone capture.
 *
 * System audio is a Chromium feature, and it needs a tab share, or a whole
 * screen share on Windows. Firefox and Safari give no system audio at all. We
 * ask for it every time and we tell the host what actually arrived.
 */

export interface CaptureOptions {
  /** Cap the source height. 0 means keep whatever the display gives. */
  maxHeight: number
  fps: number
  wantSystemAudio: boolean
}

export interface ScreenCapture {
  stream: MediaStream
  video: MediaStreamTrack
  systemAudio: MediaStreamTrack | null
}

export class CaptureError extends Error {
  readonly kind: 'denied' | 'unsupported' | 'none' | 'other'

  constructor(kind: 'denied' | 'unsupported' | 'none' | 'other', message: string) {
    super(message)
    this.kind = kind
    this.name = 'CaptureError'
  }
}

export function supportsScreenCapture(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
}

export function supportsMicrophone(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
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
    surfaceSwitching: 'include', // The host can switch tab without a reconnect.
    preferCurrentTab: false,
  } as unknown as DisplayMediaStreamOptions

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(constraints)
  } catch (err) {
    throw toCaptureError(err, 'screen')
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

export async function captureMicrophone(deviceId?: string): Promise<MediaStream> {
  if (!supportsMicrophone()) {
    throw new CaptureError('unsupported', 'This browser cannot open a microphone.')
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      video: false,
    })
  } catch (err) {
    throw toCaptureError(err, 'microphone')
  }
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'audioinput')
  } catch {
    return []
  }
}

function toCaptureError(err: unknown, what: string): CaptureError {
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CaptureError('denied', `You did not allow the ${what} share.`)
  }
  if (name === 'NotFoundError' || name === 'NotReadableError') {
    return new CaptureError('none', `Found no ${what} to use.`)
  }
  if (name === 'AbortError') {
    return new CaptureError('denied', `The ${what} share stopped before it started.`)
  }
  return new CaptureError('other', `The ${what} share failed: ${String(err)}`)
}
