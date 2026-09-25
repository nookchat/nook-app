export type UplinkSource = 'default' | 'browser-hint' | 'measured'

export interface UplinkEstimate {
  kbps: number
  source: UplinkSource
}

const MIN_KBPS = 800
const MAX_KBPS = 25_000
const DEFAULT_KBPS = 6000

interface NetworkInformation {
  effectiveType?: string
  saveData?: boolean
  type?: string
}

function networkInformation(): NetworkInformation | null {
  const nav = navigator as Navigator & {
    connection?: NetworkInformation
    mozConnection?: NetworkInformation
    webkitConnection?: NetworkInformation
  }
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null
}

function clamp(kbps: number): number {
  return Math.max(MIN_KBPS, Math.min(MAX_KBPS, Math.round(kbps)))
}

/**
 * The hints describe the downlink, never the uplink, so they only spot a clearly small connection.
 * The numeric `downlink` is ignored: on a fresh page it often reads far below the truth.
 */
export function initialUplink(): UplinkEstimate {
  const c = networkInformation()
  if (!c) return { kbps: DEFAULT_KBPS, source: 'default' }
  if (c.saveData) return { kbps: 1500, source: 'browser-hint' }
  const type = c.effectiveType ?? ''
  if (type === 'slow-2g' || type === '2g') return { kbps: MIN_KBPS, source: 'browser-hint' }
  if (type === '3g') return { kbps: 2500, source: 'browser-hint' }
  if (c.type === 'cellular') return { kbps: 4000, source: 'browser-hint' }
  return { kbps: DEFAULT_KBPS, source: 'browser-hint' }
}

export interface Observation {
  /** What the encoders would use if the budget were unlimited. */
  demandKbps: number
  sendingKbps: number
  /** What WebRTC reports the path will carry, summed over the viewers. */
  availableKbps: number
  lossPct: number
}

const SETTLE_MS = 4000
const CONGESTED_SAMPLES = 2
const LOSSY_PCT = 3

export class UplinkMeter {
  private kbps: number
  private src: UplinkSource
  private congested = 0
  private lastChange = 0

  constructor(initial: UplinkEstimate = initialUplink()) {
    this.kbps = initial.kbps
    this.src = initial.source
  }

  get estimateKbps(): number {
    return this.kbps
  }

  get source(): UplinkSource {
    return this.src
  }

  /** True when the estimate moved. */
  observe(o: Observation, now = Date.now()): boolean {
    if (o.sendingKbps <= 0) return false

    if (o.lossPct > LOSSY_PCT) {
      this.congested += 1
      if (this.congested >= CONGESTED_SAMPLES) {
        this.congested = 0
        const next = clamp(o.sendingKbps * 0.8)
        if (next < this.kbps) {
          this.moveTo(next, now)
          return true
        }
      }
      return false
    }
    this.congested = 0

    if (o.demandKbps <= this.kbps * 0.9) return false
    if (now - this.lastChange < SETTLE_MS) return false
    if (o.availableKbps <= this.kbps * 1.1) return false

    this.moveTo(clamp(Math.min(o.availableKbps, this.kbps * 1.25)), now)
    return true
  }

  private moveTo(kbps: number, now: number): void {
    this.kbps = kbps
    this.src = 'measured'
    this.lastChange = now
  }
}
