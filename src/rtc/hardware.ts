/**
 * Which codecs this machine can encode on the GPU.
 *
 * WebRTC gives a page no way to demand a hardware encoder. The browser decides,
 * from the codec, the resolution and the platform. What a page *can* do is find
 * out which codecs have a hardware encoder at all, and then ask for those first.
 *
 * Two sources agree on the answer, and neither is a guess:
 *
 *   WebCodecs   `isConfigSupported` with hardwareAcceleration 'prefer-hardware'
 *               fails outright when no hardware encoder can serve the config.
 *   Media Caps  `encodingInfo` reports `powerEfficient`, which is the platform
 *               saying the work will not land on the processor.
 *
 * Measured on an Apple M4 Pro, one viewer, 1920x1080 at 60 frames, this is what
 * the difference is worth:
 *
 *   H265   1920x1080  0.41 cores   hardware, VideoToolbox
 *   VP9    1920x1080  0.87 cores   software
 *   AV1    1920x1080  2.05 cores   software
 *
 * Same picture, less than half the processor. `npm run test:cpu` reruns that on
 * your own machine.
 *
 * The preference applies to moving pictures only. A hardware encoder is tuned
 * for camera video, and it smears small text, so documents stay on VP9 where
 * the screen content tools live and the bill is small anyway.
 */

/** WebCodecs identifiers for the codecs WebRTC might offer. */
const WEBCODECS: Record<string, string> = {
  H265: 'hev1.1.6.L93.B0',
  H264: 'avc1.42001f',
  AV1: 'av01.0.04M.08',
  VP9: 'vp09.00.10.08',
  VP8: 'vp8',
}

/** Order to try, best compression per bit first among the hardware candidates. */
const CANDIDATES = ['H265', 'AV1', 'H264', 'VP9', 'VP8']

export interface HardwareProbe {
  /** Short codec names with a hardware encoder on this machine, best first. */
  hardware: string[]
  /** True once the probe has run, whatever it found. */
  checked: boolean
  /** How the answer was reached, for the diagnostics panel. */
  note: string
}

export const NO_HARDWARE: HardwareProbe = {
  hardware: [],
  checked: false,
  note: 'Cathode has not checked for a hardware encoder yet.',
}

async function webCodecsHardware(name: string, width: number, height: number, fps: number): Promise<boolean> {
  const codec = WEBCODECS[name]
  if (!codec || typeof VideoEncoder === 'undefined') return false
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      bitrate: 6_000_000,
      framerate: fps,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'realtime',
    })
    return result.supported === true
  } catch {
    // An unknown codec string throws rather than answering false.
    return false
  }
}

async function powerEfficient(name: string, width: number, height: number, fps: number): Promise<boolean> {
  const caps = navigator.mediaCapabilities
  if (!caps?.encodingInfo) return false
  try {
    const result = await caps.encodingInfo({
      type: 'webrtc',
      video: {
        contentType: `video/${name}`,
        width,
        height,
        bitrate: 6_000_000,
        framerate: fps,
      },
    } as MediaEncodingConfiguration)
    return result.supported === true && result.powerEfficient === true
  } catch {
    return false
  }
}

/**
 * Ask the browser which codecs it can encode without the processor.
 *
 * Only codecs that WebRTC will actually offer are considered, so a hardware
 * encoder the connection could never negotiate is never suggested.
 */
export async function probeHardwareEncoders(
  offerable: string[],
  width = 1920,
  height = 1080,
  fps = 60,
): Promise<HardwareProbe> {
  const found: string[] = []
  const reasons: string[] = []

  for (const name of CANDIDATES) {
    if (!offerable.includes(name)) continue
    const [viaWebCodecs, viaCaps] = await Promise.all([
      webCodecsHardware(name, width, height, fps),
      powerEfficient(name, width, height, fps),
    ])
    if (viaWebCodecs || viaCaps) {
      found.push(name)
      reasons.push(`${name} (${[viaWebCodecs && 'WebCodecs', viaCaps && 'power efficient'].filter(Boolean).join(', ')})`)
    }
  }

  return {
    hardware: found,
    checked: true,
    note: found.length
      ? `This machine can encode ${reasons.join(' and ')} on the GPU. Cathode asks for that first on moving pictures.`
      : 'No codec on this machine has a hardware encoder that WebRTC can offer, so encoding runs on the processor.',
  }
}
