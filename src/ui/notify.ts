const KEY = 'cathode.notify.v1'

type NotifyState = 'off' | 'on' | 'blocked' | 'unsupported'

function supported(): boolean {
  return typeof Notification !== 'undefined'
}

export function notifyState(): NotifyState {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  try {
    return localStorage.getItem(KEY) === 'on' && Notification.permission === 'granted' ? 'on' : 'off'
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

export function notify(title: string, body: string, go?: () => void): void {
  if (notifyState() !== 'on') return
  if (typeof document !== 'undefined' && !document.hidden) return
  try {
    const note = new Notification(title, {
      body: body.slice(0, 160),
      tag: title,
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
