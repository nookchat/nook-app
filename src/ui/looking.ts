/**
 * Whether you look at Nook now: what decides a notification, and whether what comes into the
 * open channel is read. In a browser, the tab is shown and the window is in front. In the desktop
 * app the shell says, since a window put away in the tray can still read as visible to the page.
 */

interface DesktopLooking {
  looking?: () => boolean
  onLooking?: (fn: (looking: boolean) => void) => () => void
}

/** Said on window when you start or stop looking at Nook. */
export const LOOKING_CHANGED = 'nook:looking'

const desktop = (): DesktopLooking | undefined => (window as unknown as { nookDesktop?: DesktopLooking }).nookDesktop

let desktopLooking: boolean | null = null
/** What would have notified you since you last looked: the desktop app's count, as Discord's. */
let missedSince = 0

/** Said on window when the count of what you missed changes. */
export const MISSED_CHANGED = 'nook:missed'

export function missed(): number {
  return missedSince
}

/** Something that notifies came while you were away: one more, whether a notification shows or not. */
export function noteMissed(): void {
  missedSince += 1
  window.dispatchEvent(new Event(MISSED_CHANGED))
}

/** Whether the desktop app says when you look at it: then its icon counts what you missed. */
export function desktopSaysLooking(): boolean {
  return desktopLooking !== null
}

export function lookingAtNook(): boolean {
  if (typeof document === 'undefined') return false
  if (desktopLooking !== null) return desktopLooking
  return !document.hidden && document.hasFocus()
}

/** Whether what comes into the open channel counts as read: shown, if not in front, in a browser. */
export function nookInView(): boolean {
  if (desktopLooking !== null) return desktopLooking
  return !document.hidden
}

/** Starts listening. A desktop app from before 0.3.17 says nothing, and the page asks the browser. */
export function watchLooking(): void {
  const shell = desktop()
  const said = (): void => void window.dispatchEvent(new Event(LOOKING_CHANGED))
  if (shell?.looking && shell.onLooking) {
    desktopLooking = shell.looking()
    shell.onLooking((now) => {
      if (now === desktopLooking) return
      desktopLooking = now
      // Back at the window: what you missed is in front of you now.
      if (now && missedSince > 0) {
        missedSince = 0
        window.dispatchEvent(new Event(MISSED_CHANGED))
      }
      said()
    })
    return
  }
  document.addEventListener('visibilitychange', said)
  window.addEventListener('focus', said)
  window.addEventListener('blur', said)
}
