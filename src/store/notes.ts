export interface RoomNote {
  room: string
  secret: string
  server?: string
  lastSeen: number
  title: string
  /** The space's picture, as the last visit saw it. */
  picture?: string
  locked?: boolean
  password?: string
  founder?: string
  closed?: boolean
  /** The pass of the invite this device came in with, after a ban. */
  pass?: string
  read?: Record<string, number>
  readDm?: Record<string, number>
}

export const ROOMS_CHANGED = 'nook:rooms'

export function roomsChanged(): void {
  try {
    window.dispatchEvent(new Event(ROOMS_CHANGED))
  } catch {}
}
