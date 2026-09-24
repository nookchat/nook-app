/**
 * A transport carries opaque strings between everybody in one space. There is
 * one: a space's Channel on the server connection (net/connection.ts).
 *
 * A transport never sees plain text. Look at envelope.ts for the seal.
 */

export type TransportStatus = 'idle' | 'connecting' | 'open' | 'retrying' | 'failed'

export interface TransportEvents {
  onWire: (wire: string) => void
  onStatus: (transport: Transport, status: TransportStatus, detail?: string) => void
}

export interface Transport {
  /** Short human name for the diagnostics panel. */
  readonly name: string
  readonly status: TransportStatus
  /** True when publish has somewhere to go. */
  readonly ready: boolean
  connect(topic: string, events: TransportEvents): void
  publish(wire: string): void
  /**
   * Who this session is and what it is doing. The server keeps the latest,
   * hands it to whoever arrives, and says when the session goes.
   */
  publishState?(wire: string, session: string): void
  close(): void
}

/**
 * Backoff with jitter, so many viewers do not retry in lockstep.
 *
 * A transport never gives up. A relay that dies during a session must be able
 * to come back, otherwise a host and a viewer can end up with no relay in
 * common and a room that looks connected but carries nothing. After a long
 * outage the interval widens to a minute, which is kind to a dead endpoint and
 * still fast enough to recover.
 */
export function backoffDelay(attempt: number): number {
  const ceiling = attempt > 8 ? 60_000 : 15_000
  const base = Math.min(ceiling, 600 * 2 ** Math.min(attempt, 7))
  return Math.round(base * (0.7 + Math.random() * 0.6))
}
