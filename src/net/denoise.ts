const WORKLET = '/denoise-worklet.js'
const MODEL = '/rnnoise.wasm'
const RNNOISE_RATE = 48_000
const READY_TIMEOUT_MS = 8000

let fetched: Promise<ArrayBuffer> | null = null

// Bytes, not a compiled module: a compiled module posted to an audio worklet is dropped silently.
function model(): Promise<ArrayBuffer> {
  fetched =
    fetched ??
    fetch(MODEL).then((r) => {
      if (!r.ok) throw new Error(`rnnoise: ${r.status}`)
      return r.arrayBuffer()
    })
  return fetched
}

export interface Denoiser {
  stream: MediaStream
  /** Until true, sound passes through untouched, which looks the same as working. */
  running: Promise<boolean>
  close(): void
}

export async function denoise(mic: MediaStream): Promise<Denoiser | null> {
  try {
    if (typeof AudioWorkletNode === 'undefined') return null

    const bytes = await model()
    const ctx = new AudioContext({ sampleRate: RNNOISE_RATE, latencyHint: 'interactive' })
    await ctx.audioWorklet.addModule(WORKLET)
    // A suspended context has no audio thread, so the processor would never be built.
    await ctx.resume().catch(() => undefined)

    const node = new AudioWorkletNode(ctx, 'denoise', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })

    const source = ctx.createMediaStreamSource(mic)
    const sink = ctx.createMediaStreamDestination()
    source.connect(node)
    node.connect(sink)

    const running = new Promise<boolean>((resolve) => {
      const done = window.setTimeout(() => resolve(false), READY_TIMEOUT_MS)
      node.onprocessorerror = (e) => {
        window.clearTimeout(done)
        console.warn('Nook denoiser worklet died:', e)
        resolve(false)
      }
      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; why?: string }
        if (data?.type === 'ready') {
          window.clearTimeout(done)
          resolve(true)
        }
        if (data?.type === 'failed') {
          window.clearTimeout(done)
          console.warn('Nook could not start the denoiser:', data.why)
          resolve(false)
        }
      }
    })

    // A fresh copy each time: the transfer would empty the cached one.
    node.port.postMessage({ type: 'wasm', bytes: bytes.slice(0) })

    return {
      stream: sink.stream,
      running,
      close: () => {
        try {
          node.port.postMessage({ type: 'stop' })
          source.disconnect()
          node.disconnect()
          void ctx.close()
        } catch {
          /* already gone */
        }
      },
    }
  } catch {
    return null
  }
}
