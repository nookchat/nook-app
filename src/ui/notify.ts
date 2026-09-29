const KEY = 'nook.notify.v1'
const WHAT_KEY = 'nook.notify.what.v1'
const TEXT_KEY = 'nook.notify.text.v1'
const ICON = 'icons/app-icon-rounded-192.png'

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
  return 'on'
}

export function stopNotify(): void {
  try {
    localStorage.setItem(KEY, 'off')
  } catch {
    /* storage blocked */
  }
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
}

/** Whether a notification shows what was said, or only who. */
export function notifyText(): boolean {
  return read(TEXT_KEY) !== 'off'
}

export function setNotifyText(on: boolean): void {
  write(TEXT_KEY, on ? 'on' : 'off')
}

/**
 * A system notification, as Discord does: while you are looking at Nook there is none.
 * `tag` stops the same message showing twice; `picture` is the sender's face.
 */
export function notify(title: string, body: string, go?: () => void, more: { tag?: string; picture?: string } = {}): void {
  if (notifyState() !== 'on') return
  if (typeof document !== 'undefined' && !document.hidden && document.hasFocus()) return
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
