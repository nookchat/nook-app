import { h } from './dom'

let host: HTMLDivElement | null = null

function container(): HTMLDivElement {
  if (!host) {
    // Said out loud as well as shown. A toast that only exists visually is a
    // message somebody using a screen reader never receives.
    host = h('div', { class: 'toasts', role: 'status' })
    host.setAttribute('aria-live', 'polite')
    document.body.append(host)
  }
  return host
}

export type ToastTone = 'info' | 'warn' | 'good' | 'bad'

/** Something for the reader to do about it, when there is something. */
export interface ToastAction {
  label: string
  run: () => void
}

export function toast(
  message: string,
  tone: ToastTone = 'info',
  ms = 5000,
  action: ToastAction | null = null,
): void {
  const box = h('div', { class: `toast ${tone === 'info' ? '' : tone}`.trim() }, [
    h('div', { class: 'grow', text: message }),
    action
      ? h('button', {
          class: 'primary tiny-btn',
          text: action.label,
          on: {
            click: () => {
              box.remove()
              action.run()
            },
          },
        })
      : null,
    h('button', {
      class: 'ghost icon',
      text: '\u2715',
      ariaLabel: 'Dismiss',
      on: { click: () => box.remove() },
    }),
  ])
  container().append(box)
  if (ms > 0) window.setTimeout(() => box.remove(), ms)
}
