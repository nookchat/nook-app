/**
 * How much upload Cathode may use.
 *
 * There is no upload speed test here, because a speed test needs a server that
 * accepts an upload and Cathode has none. A static host refuses a POST, and pushing
 * megabytes through the free public signal relays would get the room rate
 * limited, which is a poor trade for a number we can learn honestly.
 *
 * So Cathode does this instead:
 *
 *   1. On load, it reads what the browser already knows. The Network
 *      Information API reports data saver, a rough connection class, and
 *      whether the link is cellular. That gives a careful starting budget, not
 *      a measurement, and it is labelled as such.
 *   2. Once a viewer connects, real bytes flow over the real path, and the
 *      bandwidth estimator inside WebRTC reports what that path will carry.
 *      That is a true measurement of the uplink, and Cathode converges on it.
 *
 * The estimator only reaches upward when the encoders actually want more than
 * the current budget. There is no point discovering a spare 20 Mb/s to carry a
 * 1.2 Mb/s document.
 */

export type UplinkSource = 'default' | 'browser-hint' | 'measured'

export interface UplinkEstimate {
  kbps: number
  source: UplinkSource
  /** One line for the panel, saying where the number came from. */
  note: string
}

/** Never commit less than this, or a share stops being watchable. */
const MIN_KBPS = 800
/** Never commit more than this on a guess. A mesh can always be told to. */
const MAX_KBPS = 25_000

const DEFAULT_KBPS = 6000

interface Connection {
  effectiveType?: string
  downlink?: number
  saveData?: boolean
  type?: string
}

function connection(): Connection | null {
  const nav = navigator as Navigator & {
    connection?: Connection
    mozConnection?: Connection
    webkitConnection?: Connection
  }
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null
}

function clamp(kbps: number): number {
  return Math.max(MIN_KBPS, Math.min(MAX_KBPS, Math.round(kbps)))
}

/**
 * The starting budget, from browser hints alone.
 *
 * These hints describe the downlink, never the uplink, so they are used only to
 * spot a connection that is clearly small. A fast hint earns no extra budget.
 */
export function initialUplink(): UplinkEstimate {
  const c = connection()
  if (!c) {
    return {
      kbps: DEFAULT_KBPS,
      source: 'default',
      note: 'This browser reports nothing about the connection, so It starts at a safe figure and measures the real one once a viewer joins.',
    }
  }

  if (c.saveData) {
    return {
      kbps: 1500,
      source: 'browser-hint',
      note: 'Data saver is on in this browser, so it starts small.',
    }
  }

  const type = c.effectiveType ?? ''
  if (type === 'slow-2g' || type === '2g') {
    return {
      kbps: MIN_KBPS,
      source: 'browser-hint',
      note: 'The browser reports a very slow connection, so it starts at the lowest budget.',
    }
  }
  if (type === '3g') {
    return {
      kbps: 2500,
      source: 'browser-hint',
      note: 'The browser reports a 3g connection, so it starts low.',
    }
  }

  /*
   * The numeric `downlink` is deliberately ignored.
   *
   * It is an estimate built from recent traffic, rounded and capped, and on a
   * freshly opened page it often reads far below the truth. Trusting it made
   * Cathode open at 870 kb/s on a fast link and warn that the budget was holding
   * the quality down. The coarse class above is stable enough to act on; the
   * exact figure is worth waiting for real bytes to learn.
   */

  if (c.type === 'cellular') {
    return {
      kbps: 4000,
      source: 'browser-hint',
      note: 'This looks like a mobile connection, so it starts below the usual figure.',
    }
  }

  return {
    kbps: DEFAULT_KBPS,
    source: 'browser-hint',
    note: 'It starts at a safe figure and measures the real uplink once a viewer joins.',
  }
}

export interface Observation {
  /** What the encoders would use if the budget were unlimited. */
  demandKbps: number
  /** What is actually leaving this machine right now. */
  sendingKbps: number
  /** What WebRTC reports the path will carry, summed over the viewers. */
  availableKbps: number
  /** Mean packet loss the viewers report back. */
  lossPct: number
}

/** How long to hold still after a change, so one reading does not chase itself. */
const SETTLE_MS = 4000
/** Consecutive lossy samples before Cathode accepts that the path is too small. */
const CONGESTED_SAMPLES = 2

export class UplinkMeter {
  private kbps: number
  private src: UplinkSource
  private noteText: string
  private congested = 0
  private lastChange = 0
  private measuredSamples = 0

  constructor(initial: UplinkEstimate = initialUplink()) {
    this.kbps = initial.kbps
    this.src = initial.source
    this.noteText = initial.note
  }

  get estimateKbps(): number {
    return this.kbps
  }

  get source(): UplinkSource {
    return this.src
  }

  get note(): string {
    return this.noteText
  }

  /** A short word for the panel: where this number came from. */
  get label(): string {
    if (this.src === 'measured') return 'measured'
    if (this.src === 'browser-hint') return 'estimated'
    return 'default'
  }

  /** Returns true when the estimate moved, so the caller can redraw. */
  observe(o: Observation, now = Date.now()): boolean {
    if (o.sendingKbps <= 0) return false

    // Loss means the path is already smaller than what we are sending. That is
    // a real measurement, and it is always acted on.
    if (o.lossPct > 3) {
      this.congested += 1
      if (this.congested >= CONGESTED_SAMPLES) {
        this.congested = 0
        const next = clamp(o.sendingKbps * 0.8)
        if (next < this.kbps) {
          this.kbps = next
          this.src = 'measured'
          this.measuredSamples += 1
          this.noteText = `Measured the upload at about ${fmt(next)} after the viewers reported packet loss.`
          this.lastChange = now
          return true
        }
      }
      return false
    }
    this.congested = 0

    // Only look for headroom when the encoders actually want it. There is no
    // point probing for 20 Mb/s to carry a document at 1.2.
    if (o.demandKbps <= this.kbps * 0.9) return false
    if (now - this.lastChange < SETTLE_MS) return false
    if (o.availableKbps <= this.kbps * 1.1) return false

    // Step up gently. The next sample confirms the step before another one.
    this.kbps = clamp(Math.min(o.availableKbps, this.kbps * 1.25))
    this.src = 'measured'
    this.measuredSamples += 1
    this.noteText = `Measured the upload at about ${fmt(this.kbps)} on the live connection.`
    this.lastChange = now
    return true
  }

  /** True once the figure comes from real traffic rather than a guess. */
  get isMeasured(): boolean {
    return this.src === 'measured' && this.measuredSamples > 0
  }
}

function fmt(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${Math.round(kbps)} kb/s`
}
