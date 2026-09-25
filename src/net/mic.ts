const KEY = 'nook.mic.v1'

export interface MicSettings {
  echo: boolean
  denoise: boolean
  gain: boolean
  /** The neural denoiser, on top of the driver's own noise suppression. */
  smart: boolean
  /** A device id. Empty is the system's own choice. */
  input?: string
  /** A device id. Empty is the system's own choice. */
  output?: string
}

const DEFAULTS: MicSettings = { echo: true, denoise: true, gain: true, smart: true }

export function micSettings(): MicSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const saved = JSON.parse(raw) as Partial<MicSettings>
    return {
      echo: saved.echo !== false,
      denoise: saved.denoise !== false,
      gain: saved.gain !== false,
      smart: saved.smart !== false,
      input: typeof saved.input === 'string' ? saved.input : '',
      output: typeof saved.output === 'string' ? saved.output : '',
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setMicSettings(next: MicSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* the choice lasts for this session only */
  }
}

export async function explainMicRefusal(err: unknown): Promise<string> {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found on this device.'
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    try {
      const state = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      })
      if (state.state === 'denied') {
        return (
          'The browser has the microphone blocked for this site. ' +
          'Click the icon by the address bar, allow the microphone, then join again.'
        )
      }
    } catch {
      /* not every browser lets this be asked */
    }
    return 'The microphone was refused. Join again to be asked again.'
  }
  if (name === 'NotReadableError') {
    return 'Another app is holding the microphone. Close it and join again.'
  }
  return 'Nook could not open your microphone.'
}

export function micConstraints(): MediaTrackConstraints {
  const s = micSettings()
  return {
    echoCancellation: s.echo,
    noiseSuppression: s.denoise,
    autoGainControl: s.gain,
    // Exact: a browser may treat "ideal" as a suggestion and open the default instead.
    ...(s.input ? { deviceId: { exact: s.input } } : {}),
  }
}

export const DEVICES_CHANGED = 'nook:devices'

export async function openMic(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (!micSettings().input || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw err
    const { deviceId: _gone, ...rest } = micConstraints()
    return navigator.mediaDevices.getUserMedia({ audio: rest, video: false })
  }
}

export function playOn(el: HTMLMediaElement): void {
  const output = micSettings().output
  const media = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
  if (output && media.setSinkId) void media.setSinkId(output).catch(() => undefined)
}

export async function audioDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return {
      inputs: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications'),
      outputs: all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications'),
    }
  } catch {
    return { inputs: [], outputs: [] }
  }
}
