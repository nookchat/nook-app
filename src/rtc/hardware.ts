const WEBCODECS_IDS: Record<string, string> = {
  H265: 'hev1.1.6.L93.B0',
  H264: 'avc1.42001f',
  AV1: 'av01.0.04M.08',
  VP9: 'vp09.00.10.08',
  VP8: 'vp8',
}

const CANDIDATES_BEST_FIRST = ['H265', 'AV1', 'H264', 'VP9', 'VP8']

export interface HardwareProbe {
  hardware: string[]
  checked: boolean
  note: string
}

export const NO_HARDWARE: HardwareProbe = {
  hardware: [],
  checked: false,
  note: 'The hardware encoder check has not run yet.',
}

async function webCodecsHardware(name: string, width: number, height: number, fps: number): Promise<boolean> {
  const codec = WEBCODECS_IDS[name]
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

export async function probeHardwareEncoders(
  offerable: string[],
  width = 1920,
  height = 1080,
  fps = 60,
): Promise<HardwareProbe> {
  const names = CANDIDATES_BEST_FIRST.filter((name) => offerable.includes(name))
  const results = await Promise.all(
    names.map((name) =>
      Promise.all([webCodecsHardware(name, width, height, fps), powerEfficient(name, width, height, fps)]),
    ),
  )
  const found: string[] = []
  const reasons: string[] = []
  names.forEach((name, i) => {
    const [viaWebCodecs, viaCaps] = results[i]
    if (!viaWebCodecs && !viaCaps) return
    found.push(name)
    reasons.push(`${name} (${[viaWebCodecs && 'WebCodecs', viaCaps && 'power efficient'].filter(Boolean).join(', ')})`)
  })

  return {
    hardware: found,
    checked: true,
    note: found.length
      ? `This machine can encode ${reasons.join(' and ')} on the GPU. That is asked for first on moving pictures.`
      : 'No codec on this machine has a hardware encoder that WebRTC can offer, so encoding runs on the processor.',
  }
}
