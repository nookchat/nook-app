import { PREFS_CHANGED } from './prefs'

/**
 * What you tell people about yourself: here, idle, do not disturb, or seen as away, and a few
 * words of your own. It is one of the synced preferences, so it follows you to every device.
 */
export type Presence = 'online' | 'idle' | 'dnd' | 'invisible'

export interface MyStatus {
  mode: Presence
  /** A few words of your own, or empty. */
  text: string
}

export const STATUS_KEY = 'nook.status.v1'
/** Said on window when your status changes, here or on another of your devices. */
export const STATUS_CHANGED = 'nook:status'
export const MAX_STATUS_TEXT = 80

export const PRESENCES: { id: Presence; label: string; about: string }[] = [
  { id: 'online', label: 'Online', about: '' },
  { id: 'idle', label: 'Idle', about: '' },
  { id: 'dnd', label: 'Do not disturb', about: 'No notifications, and no sounds for messages' },
  { id: 'invisible', label: 'Invisible', about: 'You show as away, and you can still use Nook' },
]

export function cleanPresence(raw: unknown): Presence {
  return raw === 'idle' || raw === 'dnd' || raw === 'invisible' ? raw : 'online'
}

export function cleanStatusText(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_STATUS_TEXT) : ''
}

export function loadStatus(): MyStatus {
  try {
    const raw = JSON.parse(localStorage.getItem(STATUS_KEY) ?? '{}') as Record<string, unknown>
    return { mode: cleanPresence(raw?.mode), text: cleanStatusText(raw?.text) }
  } catch {
    return { mode: 'online', text: '' }
  }
}

export function saveStatus(patch: Partial<MyStatus>): void {
  const next = { ...loadStatus(), ...patch }
  const clean = { mode: cleanPresence(next.mode), text: cleanStatusText(next.text) }
  try {
    if (clean.mode === 'online' && !clean.text) localStorage.removeItem(STATUS_KEY)
    else localStorage.setItem(STATUS_KEY, JSON.stringify(clean))
  } catch {
    /* storage blocked: it lasts until the page closes */
  }
  window.dispatchEvent(new Event(STATUS_CHANGED))
}

/** Do not disturb: no notifications, and no sounds for messages. Calls still ring. */
export function doNotDisturb(): boolean {
  return loadStatus().mode === 'dnd'
}

/** What a dot shows for a status, and what it says on hover. */
export function presenceLook(mode: Presence, away: boolean): { dot: string; words: string } {
  if (mode === 'dnd') return { dot: 'bad', words: 'Do not disturb' }
  if (mode === 'invisible') return { dot: 'idle', words: 'Invisible' }
  if (mode === 'idle' || away) return { dot: 'warn', words: mode === 'idle' ? 'Idle' : 'Here, but looking at something else' }
  return { dot: 'good', words: 'Online' }
}

// A change on another device arrives as a preference: say it the same way.
if (typeof window !== 'undefined') {
  window.addEventListener(PREFS_CHANGED, (ev) => {
    const which = (ev as CustomEvent<string[]>).detail ?? []
    if (which.includes(STATUS_KEY)) window.dispatchEvent(new Event(STATUS_CHANGED))
  })
}
