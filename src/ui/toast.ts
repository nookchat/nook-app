import { h } from './dom'

let host: HTMLDivElement | null = null

function container(): HTMLDivElement {
  if (!host) {
    host = h('div', { class: 'toasts' })
    document.body.append(host)
  }
  return host
}

export type ToastTone = 'info' | 'warn' | 'bad'

export function toast(message: string, tone: ToastTone = 'info', ms = 5000): void {
  const box = h('div', { class: `toast ${tone === 'info' ? '' : tone}`.trim() }, [
    h('div', { class: 'grow', text: message }),
    h('button', {
      class: 'ghost icon',
      text: '✕',
      ariaLabel: 'Dismiss',
      on: { click: () => box.remove() },
    }),
  ])
  container().append(box)
  if (ms > 0) window.setTimeout(() => box.remove(), ms)
}
