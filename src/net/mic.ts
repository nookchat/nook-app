/**
 * What happens to your microphone before anybody hears it.
 *
 * Chrome, Edge and Safari all ship the same three pieces of processing that
 * every call application has used for years, and they run in the audio driver
 * rather than in the page, so they cost nothing and add no delay:
 *
 *   echo cancellation   stops the far end hearing themselves through your
 *                       speakers, which is what causes howling without a headset
 *   noise suppression   takes out steady background noise: fans, traffic, a
 *                       room's hum
 *   auto gain           evens out how loud you are, so leaning back does not
 *                       make you disappear
 *
 * This is the same family of processing as the one in the well known call
 * applications, though not the same model. Theirs is a neural network trained
 * on noise, which is better at the hard cases: typing, a dog, somebody talking
 * behind you. Running one of those here means shipping a model into the page
 * and an audio worklet to run it in, which is a real piece of work rather than
 * a setting, and it is not what this file does.
 *
 * All three default to on, because for talking to people that is right almost
 * always. They are off-switches for the case they get wrong: music, a guitar,
 * anything where the processing hears the content as noise and fights it.
 */

const KEY = 'cathode.mic.v1'

export interface MicSettings {
  echo: boolean
  denoise: boolean
  gain: boolean
  /**
   * Run the neural denoiser as well as the driver's own.
   *
   * The two do different jobs and stack: the driver takes out the steady
   * sound, the network takes out the rest. On by default, because the case it
   * fixes is the common one and the cost is a tenth of a core.
   */
  smart: boolean
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

/** What to ask getUserMedia for. */
export function micConstraints(): MediaTrackConstraints {
  const s = micSettings()
  return {
    echoCancellation: s.echo,
    noiseSuppression: s.denoise,
    autoGainControl: s.gain,
  }
}

/**
 * What the browser actually did with the request.
 *
 * Asking is not getting: a device or a platform can ignore any of it, and the
 * settings screen should say what is true rather than what was wanted.
 */
export function micActual(stream: MediaStream | null): Partial<MicSettings> {
  const track = stream?.getAudioTracks()[0]
  if (!track?.getSettings) return {}
  const s = track.getSettings() as Record<string, unknown>
  const read = (k: string): boolean | undefined =>
    typeof s[k] === 'boolean' ? (s[k] as boolean) : undefined
  return {
    echo: read('echoCancellation'),
    denoise: read('noiseSuppression'),
    gain: read('autoGainControl'),
  }
}
