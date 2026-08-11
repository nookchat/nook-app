/**
 * RNNoise, running on the audio thread.
 *
 * The browser's own noise suppression takes out steady sound: a fan, traffic,
 * a room's hum. It has nothing to say about a keyboard, a door, or somebody
 * talking behind you, because those are not steady and it was never built to
 * find them. RNNoise is a small recurrent network trained on exactly that, and
 * it is what the well known call applications use a version of.
 *
 * It is loaded here as bare WebAssembly rather than through its emscripten
 * loader. The loader is 1.8 MB because it carries the same module again as
 * base64; the module itself is 112 KB and imports two functions, both of which
 * are a few lines. So the two are written out below and the loader is not
 * shipped at all.
 *
 * The network works on 480 sample frames at 48 kHz. The audio thread hands
 * over 128 samples at a time, which divides into 480 no better than it sounds,
 * so samples are queued until there is a whole frame and the output runs one
 * frame behind. That is ten milliseconds of delay, against a mouth to ear
 * budget of about a hundred and fifty, and it is the whole cost.
 */

const FRAME = 480

class Denoise extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ready = false
    this.dying = false

    // Samples waiting to make up a frame, and finished samples waiting to go.
    this.inbox = new Float32Array(0)
    this.outbox = new Float32Array(0)

    this.port.onmessage = (event) => {
      const data = event.data
      if (data?.type === 'wasm') {
        this.boot(data.bytes).catch((err) =>
          this.port.postMessage({ type: 'failed', why: String(err) }),
        )
      }
      if (data?.type === 'stop') this.dying = true
    }
  }

  async boot(bytes) {
    /*
     * The two imports emscripten would have provided.
     *
     * resize_heap is asked for when the module wants more memory than it was
     * built with. This one only ever allocates a single denoiser state and two
     * small buffers, well inside the initial pages, so refusing is honest: a
     * false here makes the allocation fail loudly rather than corrupting
     * anything quietly.
     */
    const imports = {
      a: {
        a: () => 0,
        b: (dest, src, num) => {
          const heap = new Uint8Array(this.memory.buffer)
          heap.copyWithin(dest, src, src + num)
          return dest
        },
      },
    }

    /*
     * Compiled here rather than handed over ready made. A WebAssembly.Module
     * is structured cloneable everywhere except into an audio thread, where
     * the message is dropped without an error: the model never arrived, boot
     * never ran, and the sound passed through untouched, which is what this is
     * supposed to look like when it cannot run. So the bytes come over instead
     * and the compiling happens on this side.
     */
    const { instance } = await WebAssembly.instantiate(bytes, imports)
    const api = instance.exports
    this.memory = api.c

    /*
     * Static constructors, which emscripten's loader would have called and
     * which nothing here would otherwise. Without it the module's tables are
     * still empty and the first real call walks off the end of one.
     */
    api.d()

    this.create = api.f
    this.malloc = api.g
    this.destroy = api.h
    this.free = api.i
    this.processFrame = api.j

    this.state = this.create(0)
    if (!this.state) {
      this.port.postMessage({ type: 'failed', why: 'rnnoise_create returned nothing' })
      return
    }

    // One buffer, used for both directions: the network works in place.
    this.buffer = this.malloc(FRAME * 4)
    if (!this.buffer) {
      this.port.postMessage({ type: 'failed', why: 'no room for a frame' })
      return
    }
    this.ready = true
    this.port.postMessage({ type: 'ready' })
  }

  /** The heap moves when it grows, so it is never held on to. */
  view() {
    return new Float32Array(this.memory.buffer, this.buffer, FRAME)
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (!output) return !this.dying
    if (!input) {
      output.fill(0)
      return !this.dying
    }

    // Until the network is up, pass the sound through untouched. Silence while
    // a model loads is worse than a moment of the noise it was going to remove.
    if (!this.ready) {
      output.set(input)
      return !this.dying
    }

    const queued = new Float32Array(this.inbox.length + input.length)
    queued.set(this.inbox)
    queued.set(input, this.inbox.length)

    let done = this.outbox
    let at = 0
    while (queued.length - at >= FRAME) {
      const frame = queued.subarray(at, at + FRAME)
      at += FRAME

      /*
       * RNNoise works in the range of a 16 bit sample rather than the -1 to 1
       * the audio thread uses, and it is not a normalisation: the network was
       * trained on those numbers and quietly does the wrong thing on any
       * others. Scaled in, scaled out, and no clamping in between, because the
       * network's own output is already in range.
       */
      const heap = this.view()
      for (let i = 0; i < FRAME; i++) heap[i] = frame[i] * 32768

      this.processFrame(this.state, this.buffer, this.buffer)

      const out = this.view()
      const chunk = new Float32Array(done.length + FRAME)
      chunk.set(done)
      for (let i = 0; i < FRAME; i++) chunk[done.length + i] = out[i] / 32768
      done = chunk
    }

    this.inbox = queued.slice(at)

    // Hand back as much as is finished. Early on there is not a frame's worth
    // yet, and the gap is the ten milliseconds this costs.
    const take = Math.min(output.length, done.length)
    output.set(done.subarray(0, take))
    if (take < output.length) output.fill(0, take)
    this.outbox = done.slice(take)

    return !this.dying
  }
}

registerProcessor('denoise', Denoise)
