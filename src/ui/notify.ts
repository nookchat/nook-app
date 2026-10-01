import { doNotDisturb } from '../store/status'
import { lookingAtNook, noteMissed } from './looking'
import { toast } from './toast'

const KEY = 'nook.notify.v1'
const WHAT_KEY = 'nook.notify.what.v1'
const TEXT_KEY = 'nook.notify.text.v1'
const ICON = 'icons/app-icon-rounded-192.png'
/** Set once the offer to turn notifications on has been made on this device. */
const OFFERED_KEY = 'nook.notify.offered.v1'
/** After the first mention's own toast, so the two do not land at once. */
const OFFER_AFTER_MS = 2500

/** Said on window when notifications are turned on or off, or what they are for changes. */
export const NOTIFY_CHANGED = 'nook:notify'

function changed(): void {
  window.dispatchEvent(new Event(NOTIFY_CHANGED))
}

/** What gets a notification: mentions and direct messages, or every message too. */
export type NotifyWhat = 'mentions' | 'all'

type NotifyState = 'off' | 'on' | 'blocked' | 'unsupported'

function supported(): boolean {
  return typeof Notification !== 'undefined'
}

export function notifyState(): NotifyState {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  try {
    if (Notification.permission !== 'granted') return 'off'
    // On unless turned off: the desktop app has the permission from the start.
    return localStorage.getItem(KEY) === 'off' ? 'off' : 'on'
  } catch {
    return 'off'
  }
}

export async function askNotify(): Promise<NotifyState> {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      /* old browsers take a callback instead */
    }
  }
  if (Notification.permission !== 'granted') return 'blocked'
  try {
    localStorage.setItem(KEY, 'on')
  } catch {
    /* storage blocked */
  }
  changed()
  return 'on'
}

export function stopNotify(): void {
  try {
    localStorage.setItem(KEY, 'off')
  } catch {
    /* storage blocked */
  }
  changed()
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage blocked */
  }
}

export function notifyWhat(): NotifyWhat {
  return read(WHAT_KEY) === 'all' ? 'all' : 'mentions'
}

export function setNotifyWhat(what: NotifyWhat): void {
  write(WHAT_KEY, what)
  changed()
}

/** Whether a notification shows what was said, or only who. */
export function notifyText(): boolean {
  return read(TEXT_KEY) !== 'off'
}

export function setNotifyText(on: boolean): void {
  write(TEXT_KEY, on ? 'on' : 'off')
  changed()
}

/**
 * A system notification, as Discord does: while you are looking at Nook there is none.
 * `tag` stops the same message showing twice; `picture` is the sender's face.
 */
export function notify(title: string, body: string, go?: () => void, more: { tag?: string; picture?: string } = {}): void {
  if (lookingAtNook()) return
  // Counted on the desktop app's icon even when no notification shows: off, or Do not disturb.
  noteMissed()
  if (notifyState() !== 'on' || doNotDisturb()) return
  try {
    const note = new Notification(title, {
      body: body.slice(0, 160),
      tag: more.tag ?? title,
      icon: more.picture || new URL(ICON, document.baseURI).href,
      silent: false,
    })
    note.onclick = () => {
      window.focus()
      go?.()
      note.close()
    }
  } catch {
    /* throws on a page that lost its permission */
  }
}

export type TestResult = 'shown' | 'blocked' | 'unsupported' | 'quiet' | 'failed'

/**
 * A notification now, from Settings, to see that this device shows them. Unlike a real one it
 * shows while you look at Nook. In a browser it goes through the service worker where there is
 * one, as a push does, and as an iPhone needs; else, and in the desktop app, through the page.
 */
export async function testNotify(): Promise<TestResult> {
  if (!supported()) return 'unsupported'
  if (notifyState() !== 'on' && (await askNotify()) !== 'on') return notifyState() === 'blocked' ? 'blocked' : 'failed'
  if (doNotDisturb()) return 'quiet'
  const title = 'Nook'
  const options: NotificationOptions = {
    body: 'Notifications work on this device.',
    tag: 'nook-test',
    icon: new URL(ICON, document.baseURI).href,
    silent: false,
  }
  try {
    // The desktop app shows the page's own, as it does every real one: Electron may not show a worker's.
    const desktop = 'nookDesktop' in window
    const worker = !desktop && 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
    if (worker) await worker.showNotification(title, options)
    else new Notification(title, options)
    return 'shown'
  } catch {
    return 'failed'
  }
}

/**
 * A browser asks for leave to notify only after a click, so the first mention or direct
 * message that arrives while they are off offers them, once per device, in a toast.
 */
export function offerNotify(): void {
  if (!supported() || Notification.permission !== 'default' || read(OFFERED_KEY)) return
  write(OFFERED_KEY, String(Date.now()))
  window.setTimeout(() => {
    toast('Get a notification when somebody mentions you or messages you, while Nook is in the background.', 'info', 20_000, {
      label: 'Turn on',
      run: () => void askNotify(),
    })
  }, OFFER_AFTER_MS)
}
