import { doNotDisturb } from '../store/status'
import { lookingAtNook, noteMissed } from './looking'
import type { SpaceFiles } from '../net/files'
import type { Attachment } from '../store/log'
import { phoneShell } from './phone-shell'
import { toast } from './toast'

const KEY = 'nook.notify.v1'
const WHAT_KEY = 'nook.notify.what.v1'
const TEXT_KEY = 'nook.notify.text.v1'
const ICON = 'icons/app-icon-rounded-192.png'
/** Set once the offer to turn notifications on has been made on this device. */
const OFFERED_KEY = 'nook.notify.offered.v1'
/** After the first mention's own toast, so the two do not land at once. */
const OFFER_AFTER_MS = 2500

/** A notification does not wait longer than this for the picture it shows. */
const IMAGE_WAIT_MS = 2500
/** The picture in a notification is no wider than this. */
const IMAGE_PX = 640
const STILL = /^image\/(jpeg|png|gif|webp|avif|bmp)$/
const MOST_PICTURE_BYTES = 30 * 1024 * 1024

/**
 * The first picture of a message, opened on this device and made small, as a JPEG data URL for
 * the desktop app to show in a notification. A video gives its first frame. '' when there is none.
 */
export async function noticePicture(files: Attachment[], source: SpaceFiles): Promise<string> {
  const pick = files.find((f) => STILL.test(f.type) && f.size <= MOST_PICTURE_BYTES) ?? files.find((f) => f.poster)
  if (!pick) return ''
  try {
    const blob = STILL.test(pick.type) ? await source.open(pick) : await source.poster(pick)
    if (!blob) return ''
    const bitmap = await createImageBitmap(blob)
    try {
      const scale = Math.min(1, IMAGE_PX / bitmap.width)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/jpeg', 0.82)
    } finally {
      bitmap.close()
    }
  } catch {
    return ''
  }
}

/** Said on window when notifications are turned on or off, or what they are for changes. */
export const NOTIFY_CHANGED = 'nook:notify'

function changed(): void {
  window.dispatchEvent(new Event(NOTIFY_CHANGED))
}

/** What gets a notification: mentions and direct messages, or every message too. */
export type NotifyWhat = 'mentions' | 'all'

type NotifyState = 'off' | 'on' | 'blocked' | 'unsupported'

function supported(): boolean {
  return !!phoneShell || typeof Notification !== 'undefined'
}

/** The browser's leave to notify, or the Android app's. */
function permission(): NotificationPermission {
  if (phoneShell) {
    const now = phoneShell.notifyPermission()
    return now === 'prompt' ? 'default' : now
  }
  return Notification.permission
}

// The Android app says what it may do a moment after the page starts.
void phoneShell?.ready.then(changed)

export function notifyState(): NotifyState {
  if (!supported()) return 'unsupported'
  if (permission() === 'denied') return 'blocked'
  try {
    if (permission() !== 'granted') return 'off'
    // On unless turned off: the desktop app has the permission from the start.
    return localStorage.getItem(KEY) === 'off' ? 'off' : 'on'
  } catch {
    return 'off'
  }
}

export async function askNotify(): Promise<NotifyState> {
  if (!supported()) return 'unsupported'
  if (phoneShell && permission() !== 'granted') await phoneShell.askNotify()
  else if (permission() === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      /* old browsers take a callback instead */
    }
  }
  if (permission() !== 'granted') return 'blocked'
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

interface DesktopNotify {
  notify?: (note: { id: string; title: string; body: string; picture: string; image: string }) => void
  onNotifyClick?: (fn: (id: string) => void) => () => void
}

const shell = (): DesktopNotify | undefined =>
  (window as unknown as { nookDesktop?: DesktopNotify }).nookDesktop ?? phoneShell ?? undefined

/** What a notification the desktop app shows does when clicked, by its id. */
const clicks = new Map<string, () => void>()
let hearing = false
let counted = 0

/**
 * Shows a notification through the desktop app, which keeps showing them with its window put away
 * in the tray, or through the Android app, whose page has no notifications of its own. False when
 * this desktop app is too old to, and the page shows it itself.
 */
function showInShell(
  title: string,
  body: string,
  go: (() => void) | undefined,
  picture: string | undefined,
  image = '',
): boolean {
  const desktop = shell()
  if (!desktop?.notify || !desktop.onNotifyClick) return false
  if (!hearing) {
    hearing = true
    desktop.onNotifyClick((id) => {
      const run = clicks.get(id)
      clicks.delete(id)
      window.focus()
      run?.()
    })
  }
  const id = String(++counted)
  if (go) clicks.set(id, go)
  // The oldest go when many pile up.
  if (clicks.size > 50) clicks.delete(clicks.keys().next().value as string)
  desktop.notify({ id, title, body: body.slice(0, 160), picture: picture?.startsWith('data:image/') ? picture : '', image })
  return true
}

/**
 * A system notification, as Discord does: while you are looking at Nook there is none.
 * `tag` stops the same message showing twice; `picture` is the sender's face.
 */
export function notify(
  title: string,
  body: string,
  go?: () => void,
  more: { tag?: string; picture?: string; image?: Promise<string> } = {},
): void {
  if (lookingAtNook()) return
  // Counted on the desktop app's icon even when no notification shows: off, or Do not disturb.
  noteMissed()
  if (notifyState() !== 'on' || doNotDisturb()) return
  if (more.image && shell()?.notify) {
    // The picture is opened first, but the notification does not wait for it for long.
    void Promise.race([more.image, new Promise<string>((done) => window.setTimeout(() => done(''), IMAGE_WAIT_MS))]).then(
      (image) => void showInShell(title, body, go, more.picture, image),
    )
    return
  }
  if (showInShell(title, body, go, more.picture)) return
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
    if (showInShell(title, options.body ?? '', undefined, undefined)) return 'shown'
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
  if (!supported() || permission() !== 'default' || read(OFFERED_KEY)) return
  write(OFFERED_KEY, String(Date.now()))
  window.setTimeout(() => {
    toast('Get a notification when somebody mentions you or messages you, while Nook is in the background.', 'info', 20_000, {
      label: 'Turn on',
      run: () => void askNotify(),
    })
  }, OFFER_AFTER_MS)
}
