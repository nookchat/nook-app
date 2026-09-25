const FRAME = 480
// RNNoise was trained on 16 bit sample values, not the -1 to 1 of Web Audio.
const PCM16_SCALE = 32768
const OUTBOX_SIZE = FRAME * 8

class Denoise extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ready = false
    this.dying = false
    this.heap = null

    this.inbox = new Float32Array(FRAME)
    this.inboxCount = 0
    this.outbox = new Float32Array(OUTBOX_SIZE)
    this.outboxRead = 0
    this.outboxCount = 0

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
    const refuseHeapGrowth = () => 0
    let bytesView = null
    const memcpy = (dest, src, num) => {
      if (bytesView?.buffer !== this.memory.buffer) bytesView = new Uint8Array(this.memory.buffer)
      bytesView.copyWithin(dest, src, src + num)
      return dest
    }
    const imports = { a: { a: refuseHeapGrowth, b: memcpy } }

    // A WebAssembly.Module posted into an audio thread is dropped silently, so the bytes come over.
    const { instance } = await WebAssembly.instantiate(bytes, imports)
    const api = instance.exports
    this.memory = api.c
    const runStaticConstructors = api.d
    runStaticConstructors()

    const create = api.f
    const malloc = api.g
    this.processFrame = api.j

    this.state = create(0)
    if (!this.state) {
      this.port.postMessage({ type: 'failed', why: 'rnnoise_create returned nothing' })
      return
    }

    // One buffer for both directions: the network works in place.
    this.frameAddr = malloc(FRAME * 4)
    if (!this.frameAddr) {
      this.port.postMessage({ type: 'failed', why: 'no room for a frame' })
      return
    }
    this.ready = true
    this.port.postMessage({ type: 'ready' })
  }

  // The heap moves when it grows.
  heapFrame() {
    if (this.heap?.buffer !== this.memory.buffer) {
      this.heap = new Float32Array(this.memory.buffer, this.frameAddr, FRAME)
    }
    return this.heap
  }

  denoiseInbox() {
    let heap = this.heapFrame()
    for (let i = 0; i < FRAME; i++) heap[i] = this.inbox[i] * PCM16_SCALE

    this.processFrame(this.state, this.frameAddr, this.frameAddr)

    heap = this.heapFrame()
    let w = (this.outboxRead + this.outboxCount) % OUTBOX_SIZE
    for (let i = 0; i < FRAME; i++) {
      this.outbox[w] = heap[i] / PCM16_SCALE
      if (++w === OUTBOX_SIZE) w = 0
    }
    this.outboxCount += FRAME
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (!output) return !this.dying
    if (!input) {
      output.fill(0)
      return !this.dying
    }

    if (!this.ready) {
      output.set(input)
      return !this.dying
    }

    for (let i = 0; i < input.length; i++) {
      this.inbox[this.inboxCount++] = input[i]
      if (this.inboxCount === FRAME) {
        this.denoiseInbox()
        this.inboxCount = 0
      }
    }

    const take = Math.min(output.length, this.outboxCount)
    let r = this.outboxRead
    for (let i = 0; i < take; i++) {
      output[i] = this.outbox[r]
      if (++r === OUTBOX_SIZE) r = 0
    }
    this.outboxRead = r
    this.outboxCount -= take
    if (take < output.length) output.fill(0, take)

    return !this.dying
  }
}

registerProcessor('denoise', Denoise)
