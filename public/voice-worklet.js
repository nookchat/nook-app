// A processor that returns true runs for as long as the page does, even with nothing joined to
// it. So each one listens for 'stop', and then returns false and lets the browser take it down.
class Stoppable extends AudioWorkletProcessor {
  constructor() {
    super()
    this.running = true
    this.port.onmessage = (ev) => {
      if (ev.data === 'stop') this.running = false
    }
  }
}

// Moves the pitch of a voice up or down as it goes by, for the voice changer.
//
// The sound is written into a ring of 50 ms. Two readers walk through the ring, half a ring apart,
// each at the speed the pitch asks for. A reader fades out as it nears the end of the ring and
// back in at the start, so the jump from one end to the other makes no click. The two fades
// always add up to one.
class Pitch extends Stoppable {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }]
  }

  constructor() {
    super()
    this.span = Math.round(sampleRate * 0.05)
    this.size = this.span * 2
    this.ring = new Float32Array(this.size)
    this.head = 0
    this.lag = 0
  }

  read(lag) {
    let at = this.head - lag
    if (at < 0) at += this.size
    const first = Math.floor(at)
    const part = at - first
    const next = first + 1 === this.size ? 0 : first + 1
    const fade = 0.5 - 0.5 * Math.cos((2 * Math.PI * lag) / this.span)
    return (this.ring[first] * (1 - part) + this.ring[next] * part) * fade
  }

  process(inputs, outputs, parameters) {
    if (!this.running) return false
    const out = outputs[0][0]
    if (!out) return true
    const input = inputs[0][0]
    const ratio = parameters.ratio[0]
    const span = this.span
    for (let i = 0; i < out.length; i++) {
      this.ring[this.head] = input ? input[i] : 0
      let other = this.lag + span / 2
      if (other >= span) other -= span
      out[i] = this.read(this.lag) + this.read(other)
      this.lag += 1 - ratio
      if (this.lag >= span) this.lag -= span
      else if (this.lag < 0) this.lag += span
      this.head = this.head + 1 === this.size ? 0 : this.head + 1
    }
    return true
  }
}

registerProcessor('pitch', Pitch)

// Makes a voice sound like an old game: each sample is held for a few, and rounded to a few levels.
class Crush extends Stoppable {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 5, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 6000, minValue: 500, maxValue: 48000, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this.held = 0
    this.step = 1
  }

  process(inputs, outputs, parameters) {
    if (!this.running) return false
    const out = outputs[0][0]
    if (!out) return true
    const input = inputs[0][0]
    const levels = 2 ** (parameters.bits[0] - 1)
    const every = sampleRate / parameters.rate[0]
    for (let i = 0; i < out.length; i++) {
      this.step += 1
      if (this.step >= every) {
        this.step -= every
        this.held = Math.round((input ? input[i] : 0) * levels) / levels
      }
      out[i] = this.held
    }
    return true
  }
}

registerProcessor('crush', Crush)
