const KEY = 'nook.mic.v1'
/** Sent when a mic setting changes, so a running call picks it up at once. */
export const MIC_CHANGED = 'nook:mic'

/** The quietest and loudest a threshold can be, in dBFS. The level meters use the same scale. */
export const QUIET_DB = -60
export const LOUD_DB = -10

/** What the voice changer can make of your voice. `off` sends it as it is. */
export const VOICES = [
  { id: 'off', label: 'Off', about: 'Your own voice' },
  { id: 'deep', label: 'Deep', about: 'Lower, like a bigger person' },
  { id: 'high', label: 'High', about: 'Higher, lighter' },
  { id: 'chipmunk', label: 'Chipmunk', about: 'Much higher and quick' },
  { id: 'monster', label: 'Monster', about: 'Very low and rough' },
  { id: 'robot', label: 'Robot', about: 'A buzz in the voice' },
  { id: 'radio', label: 'Radio', about: 'Thin, like a walkie-talkie' },
  { id: 'echo', label: 'Echo', about: 'Your voice comes back after you' },
] as const

export type VoiceId = (typeof VOICES)[number]['id']

export function cleanVoice(raw: unknown): VoiceId {
  return VOICES.find((v) => v.id === raw)?.id ?? 'off'
}

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
  /** What your voice is sent at, from 0 to 2. */
  inputVolume: number
  /** Everybody you hear, from 0 to 1, on top of each person's own level. */
  outputVolume: number
  /** On: the mic is always open. Off: it opens above `threshold`. */
  autoSensitivity: boolean
  /** In dBFS, from QUIET_DB to LOUD_DB. */
  threshold: number
  /** The voice changer's effect. */
  voice: VoiceId
}

const DEFAULTS: MicSettings = {
  echo: true,
  denoise: true,
  gain: true,
  smart: true,
  inputVolume: 1,
  outputVolume: 1,
  autoSensitivity: true,
  threshold: -45,
  voice: 'off',
}

function within(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

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
      inputVolume: within(saved.inputVolume, 0, 2, DEFAULTS.inputVolume),
      outputVolume: within(saved.outputVolume, 0, 1, DEFAULTS.outputVolume),
      autoSensitivity: saved.autoSensitivity !== false,
      threshold: within(saved.threshold, QUIET_DB, LOUD_DB, DEFAULTS.threshold),
      voice: cleanVoice(saved.voice),
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
  window.dispatchEvent(new Event(MIC_CHANGED))
}

/** Changes some settings and keeps the rest. */
export function changeMic(change: Partial<MicSettings>): void {
  setMicSettings({ ...micSettings(), ...change })
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
