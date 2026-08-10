/**
 * A transport carries opaque strings between everybody who joined one topic.
 *
 * Beam ships two of them, on different protocols and different ports, so one
 * blocked port does not kill the room:
 *
 *   mqtt.ts   MQTT 3.1.1 over WSS on port 8084 and 8884, public test brokers
 *   nostr.ts  Nostr ephemeral events over WSS on port 443
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
  close(): void
}

/** Backoff with jitter, so many viewers do not retry in lockstep. */
export function backoffDelay(attempt: number): number {
  const base = Math.min(15_000, 600 * 2 ** Math.min(attempt, 5))
  return Math.round(base * (0.7 + Math.random() * 0.6))
}
