import { PREFS_CHANGED } from '../store/prefs'

/**
 * The game you are playing, as the desktop shell sees it. A browser cannot see
 * other programs, so on the web there is never one.
 */

const KEY = 'nook.activity.v1'
/** Sent when the game changes, or when showing it is turned on or off. */
export const PLAYING_CHANGED = 'nook:playing'
/** The longest game name shown. */
export const GAME_NAME_MAX = 64

export interface Playing {
  name: string
  /** When it started, by this device's clock. */
  since: number
}

interface DesktopShell {
  watchGames?: (on: boolean) => void
  onPlaying?: (fn: (now: Playing | null) => void) => () => void
}

function shell(): DesktopShell | null {
  const found = (window as Window & { nookDesktop?: DesktopShell }).nookDesktop
  return found?.watchGames && found.onPlaying ? found : null
}

let now: Playing | null = null
let started = false

/** A name somebody else sent, made safe to show. */
export function cleanGameName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, GAME_NAME_MAX)
}

/** The desktop app can see games. */
export function seesGames(): boolean {
  return shell() !== null
}

export function showsPlaying(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function setShowsPlaying(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* for this visit only */
  }
  apply()
}

/** What others are told you play. Null when nothing runs, or you keep it to yourself. */
export function playingNow(): Playing | null {
  return showsPlaying() ? now : null
}

function apply(): void {
  const on = showsPlaying()
  shell()?.watchGames?.(on)
  if (!on) now = null
  window.dispatchEvent(new Event(PLAYING_CHANGED))
}

export function watchPlaying(): void {
  const desktop = shell()
  if (started || !desktop) return
  started = true
  desktop.onPlaying?.((next) => {
    const name = cleanGameName(next?.name)
    const was = now?.name ?? ''
    now = name && showsPlaying() ? { name, since: typeof next?.since === 'number' ? next.since : Date.now() } : null
    if ((now?.name ?? '') !== was) window.dispatchEvent(new Event(PLAYING_CHANGED))
  })
  window.addEventListener(PREFS_CHANGED, (ev) => {
    if (((ev as CustomEvent<string[]>).detail ?? []).includes(KEY)) apply()
  })
  apply()
}
