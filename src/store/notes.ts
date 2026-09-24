/**
 * What this device knows about one space it is in, kept on the space's
 * server in your sealed record (see server-spaces.ts).
 */

export interface RoomNote {
  /** The space's id: a hash of its code and password, and all a server sees of either. */
  room: string
  /** The code, so the space can be opened from the list without the link. */
  secret: string
  /** The server the space lives on. */
  server?: string
  lastSeen: number
  title: string
  /** Whether the code alone is enough to open it. */
  locked?: boolean
  /**
   * The password for a locked space, so you are asked once rather than every
   * time. Sealed with the rest of your record, like the code beside it.
   */
  password?: string
  /** Pinned the first time this device saw the space, and never moved after. */
  founder?: string
  /** Set when an admin shut this space down, so its link says why it is gone. */
  closed?: boolean
  /** How far you have read in each channel, by log clock. */
  read?: Record<string, number>
  /** The same, for private conversations, keyed by the other person's key. */
  readDm?: Record<string, number>
}

/**
 * Said when the list of spaces, or anything drawn from it, may have changed,
 * so the rail and home can look again.
 */
export const ROOMS_CHANGED = 'cathode:rooms'

export function roomsChanged(): void {
  try {
    window.dispatchEvent(new Event(ROOMS_CHANGED))
  } catch {
    /* nobody to tell */
  }
}
