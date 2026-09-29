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

/**
 * Quick at first, since a server that restarts for an update is back in seconds: every 3 s
 * for the first two minutes or so, then every 15 s, then every 30 s for one that stays down.
 * Jittered, so many clients do not retry in lockstep.
 */
export function backoffDelay(attempt: number): number {
  const ceiling = attempt < 40 ? 3000 : attempt < 80 ? 15_000 : 30_000
  const base = Math.min(ceiling, 500 * 2 ** Math.min(attempt, 6))
  return Math.round(base * (0.7 + Math.random() * 0.6))
}
