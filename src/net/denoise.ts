/**
 * Better noise suppression than the browser's own.
 *
 * The browser's is built into the audio driver and costs nothing, and it only
 * knows how to remove steady sound. RNNoise is a small recurrent network that
 * was trained on the rest: keys, doors, a dog, somebody talking behind you. It
 * is the same idea as the one in the well known call applications, and close
 * enough in practice to be worth the 112 KB it weighs.
 *
 * It runs on the audio thread, in a worklet, so a busy page cannot make it
 * stutter. This file is only the plumbing: fetch the module, start the worklet,
 * and route the microphone through it.
 *
 * Everything here fails soft. A browser without worklets, a blocked fetch, a
 * refused allocation: any of them and the microphone is used exactly as it
 * came, which is the behaviour this replaced rather than a broken call.
 */

const WORKLET = '/denoise-worklet.js'
const MODEL = '/rnnoise.wasm'

/** RNNoise was trained at this rate and works properly at no other. */
const RATE = 48_000

let fetched: Promise<ArrayBuffer> | null = null

/**
 * The model, as bytes.
 *
 * Kept as bytes rather than as a compiled module because a compiled module
 * cannot be handed to an audio thread: the message is dropped silently. Each
 * worklet gets its own copy of the bytes and compiles them itself, which costs
 * a few milliseconds once per call.
 */
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
  /** The microphone, cleaned up, ready to send. */
  stream: MediaStream
  /**
   * Resolves true once the network is actually running.
   *
   * Until it does the sound passes through untouched, which is the right way
   * to fail but looks identical to working. Anything that wants to know the
   * difference, the settings screen and the tests, has to be able to ask.
   */
  running: Promise<boolean>
  close(): void
}

/**
 * Put a microphone through the network.
 *
 * Returns null when it cannot be done, and the caller then uses the microphone
 * as it is. Never throws: a call with the noise still in it beats no call.
 */
export async function denoise(mic: MediaStream): Promise<Denoiser | null> {
  try {
    if (typeof AudioWorkletNode === 'undefined') return null

    const bytes = await model()
    const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' })
    await ctx.audioWorklet.addModule(WORKLET)

    /*
     * A new context starts suspended, and a suspended context has no audio
     * thread, so the processor is never built and the message carrying the
     * model sits in a queue for ever. The symptom is the quietest possible
     * failure: sound passes through untouched, which is exactly what this is
     * supposed to look like when it cannot run, so nothing appears wrong at
     * all. Joining a voice channel is a click, so this normally succeeds.
     */
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
      const done = window.setTimeout(() => resolve(false), 8000)
      node.onprocessorerror = (e) => {
        window.clearTimeout(done)
        console.warn('Cathode denoiser worklet died:', e)
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
          console.warn('Cathode could not start the denoiser:', data.why)
          resolve(false)
        }
      }
    })

    // A fresh copy each time: the transfer would empty the cached one.
    node.port.postMessage({ type: 'wasm', bytes: bytes.slice(0) })

    /*
     * Keep the microphone's own track settings by handing back its track for
     * anything other than the audio, and the cleaned track for the audio. In
     * practice that is one track either way.
     */
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
