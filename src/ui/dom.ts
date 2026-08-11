/** Tiny DOM helpers. Cathode has no UI framework, because it does not need one. */

type Child = Node | string | number | null | undefined | false

export interface Props {
  class?: string
  text?: string
  html?: string
  title?: string
  id?: string
  type?: string
  value?: string
  min?: string
  max?: string
  step?: string
  placeholder?: string
  disabled?: boolean
  readOnly?: boolean
  tabIndex?: number
  ariaLabel?: string
  data?: Record<string, string>
  style?: Partial<CSSStyleDeclaration>
  on?: Partial<Record<keyof HTMLElementEventMap, EventListener>>
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props.class) el.className = props.class
  if (props.text !== undefined) el.textContent = props.text
  if (props.html !== undefined) el.innerHTML = props.html
  if (props.title) el.title = props.title
  if (props.id) el.id = props.id
  if (props.ariaLabel) el.setAttribute('aria-label', props.ariaLabel)
  if (props.tabIndex !== undefined) el.tabIndex = props.tabIndex
  if (props.data) for (const [k, v] of Object.entries(props.data)) el.dataset[k] = v
  if (props.style) Object.assign(el.style, props.style)

  const anyEl = el as unknown as Record<string, unknown>
  for (const key of ['type', 'value', 'min', 'max', 'step', 'placeholder', 'disabled', 'readOnly'] as const) {
    if (props[key] !== undefined) anyEl[key] = props[key]
  }

  if (props.on) {
    for (const [name, fn] of Object.entries(props.on)) {
      if (fn) el.addEventListener(name, fn as EventListener)
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(typeof child === 'object' ? child : String(child))
  }
  return el
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function pill(text: string, tone: 'good' | 'warn' | 'bad' | '' = ''): HTMLSpanElement {
  return h('span', { class: `pill ${tone}`.trim(), text })
}

export function labelled(labelText: string, control: HTMLElement, hint?: string): HTMLDivElement {
  return h('div', {}, [
    h('label', { text: labelText }),
    control,
    hint ? h('div', { class: 'tiny faint', text: hint, style: { marginTop: '4px' } }) : null,
  ])
}

export function fmtKbps(kbps: number): string {
  if (kbps <= 0) return '0'
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${Math.round(kbps)} kb/s`
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h2 = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h2 > 0 ? `${h2}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard permission is denied, or the page is not focused. Fall back.
    try {
      const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } })
      document.body.append(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
