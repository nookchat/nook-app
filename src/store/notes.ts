export interface RoomNote {
  room: string
  secret: string
  server?: string
  lastSeen: number
  title: string
  locked?: boolean
  password?: string
  founder?: string
  closed?: boolean
  read?: Record<string, number>
  readDm?: Record<string, number>
}

export const ROOMS_CHANGED = 'nook:rooms'

export function roomsChanged(): void {
  try {
    window.dispatchEvent(new Event(ROOMS_CHANGED))
  } catch {}
}
