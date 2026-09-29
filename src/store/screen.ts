/**
 * The screen you were on, so a reload, an update or a restart of the desktop app
 * opens it again: a space and its channel, or home and a direct message. This
 * device only, since another device may be looking at something else.
 */

const KEY = 'nook.screen.v1'

export type LastScreen =
  | { kind: 'space'; room: string; channel: string }
  | { kind: 'home'; dm: { room: string; key: string } | null }

export function saveScreen(screen: LastScreen): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(screen))
  } catch {
    /* storage blocked: the app opens at home */
  }
}

export function lastScreen(): LastScreen | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LastScreen> | null
    if (raw?.kind === 'space' && typeof raw.room === 'string' && typeof raw.channel === 'string') {
      return { kind: 'space', room: raw.room, channel: raw.channel }
    }
    if (raw?.kind === 'home') {
      const dm = raw.dm && typeof raw.dm.room === 'string' && typeof raw.dm.key === 'string' ? raw.dm : null
      return { kind: 'home', dm }
    }
  } catch {
    /* a note from some other version: start at home */
  }
  return null
}
