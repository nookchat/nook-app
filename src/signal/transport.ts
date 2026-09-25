export type TransportStatus = 'idle' | 'connecting' | 'open' | 'retrying' | 'failed'

export interface TransportEvents {
  onWire: (wire: string) => void
  onStatus: (transport: Transport, status: TransportStatus, detail?: string) => void
}

export interface Transport {
  readonly name: string
  connect(events: TransportEvents): void
  publish(wire: string): void
  publishState?(wire: string, session: string): void
  close(): void
}

/** Jittered, so many clients do not retry in lockstep. */
export function backoffDelay(attempt: number): number {
  const ceiling = attempt > 8 ? 60_000 : 15_000
  const base = Math.min(ceiling, 600 * 2 ** Math.min(attempt, 7))
  return Math.round(base * (0.7 + Math.random() * 0.6))
}
