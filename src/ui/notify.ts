/**
 * Telling somebody something happened while they were looking elsewhere.
 *
 * The browser's own notifications, which need no server and no push service and
 * work for exactly as long as the tab is alive. That is the honest limit and it
 * is worth stating plainly: close the tab and nothing reaches you, because
 * there is nobody holding your messages to send one. What this covers is the
 * common case, which is the space open behind a full screen editor.
 *
 * Only when you are named, or when somebody writes to you privately. A
 * notification for every message is a notification everybody turns off in a
 * week, and then the ones that mattered are off too.
 */

const KEY = 'cathode.notify.v1'

export type NotifyState = 'off' | 'on' | 'blocked' | 'unsupported'

function supported(): boolean {
  return typeof Notification !== 'undefined'
}

/** What this device is set to, and what the browser will actually allow. */
export function notifyState(): NotifyState {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  try {
    return localStorage.getItem(KEY) === 'on' && Notification.permission === 'granted' ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

/**
 * Turn them on, asking the browser if it has not been asked.
 *
 * Asked here, when somebody presses a button that says what it is for, rather
 * than on the way in. A permission prompt nobody asked for is refused, and a
 * refusal cannot be taken back without going into browser settings.
 */
export async function askNotify(): Promise<NotifyState> {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      /* an old browser that wants a callback. Nothing to do about it. */
    }
  }
  if (Notification.permission !== 'granted') return 'blocked'
  try {
    localStorage.setItem(KEY, 'on')
  } catch {
    /* the choice lasts for this session */
  }
  return 'on'
}

export function stopNotify(): void {
  try {
    localStorage.setItem(KEY, 'off')
  } catch {
    /* nothing to keep it in */
  }
}

/**
 * One notification, if this device is set up for them and is not being looked
 * at. Clicking it brings the window back and runs whatever was passed.
 */
export function notify(title: string, body: string, go?: () => void): void {
  if (notifyState() !== 'on') return
  if (typeof document !== 'undefined' && !document.hidden) return
  try {
    const note = new Notification(title, {
      body: body.slice(0, 160),
      // One per conversation: ten messages while you are away is one thing to
      // come back to, not ten things to dismiss.
      tag: title,
      silent: false,
    })
    note.onclick = () => {
      window.focus()
      go?.()
      note.close()
    }
  } catch {
    /* Notifications can throw on a page that lost its permission. */
  }
}
