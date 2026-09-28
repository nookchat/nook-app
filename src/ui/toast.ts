import { h } from './dom'
import { ghost, type GhostEntrance } from './ghost'
import { icon } from './icons'

let host: HTMLDivElement | null = null

function container(): HTMLDivElement {
  if (!host) {
    host = h('div', { class: 'toasts', role: 'status' })
    host.setAttribute('aria-live', 'polite')
    document.body.append(host)
  }
  return host
}

type ToastTone = 'info' | 'warn' | 'good' | 'bad'

interface ToastAction {
  label: string
  run: () => void
}

export function toast(
  message: string,
  tone: ToastTone = 'info',
  ms = 5000,
  action: ToastAction | null = null,
  /** For news about people: the ghost peeks in, or wiggles for a mention. */
  mascot?: GhostEntrance,
): void {
  const box = h('div', { class: `toast ${tone === 'info' ? '' : tone}`.trim() }, [
    mascot ? ghost({ entrance: mascot, size: 24 }) : null,
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
    h(
      'button',
      {
        class: 'ghost icon-only toast-close',
        ariaLabel: 'Dismiss',
        on: { click: () => box.remove() },
      },
      [icon('close', 16)],
    ),
  ])
  container().append(box)
  if (ms > 0) window.setTimeout(() => box.remove(), ms)
}
