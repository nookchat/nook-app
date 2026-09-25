type Child = Node | string | number | null | undefined | false

interface Props {
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
  rows?: number
  tabIndex?: number
  ariaLabel?: string
  role?: string
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
  if (props.role) el.setAttribute('role', props.role)
  if (props.tabIndex !== undefined) el.tabIndex = props.tabIndex
  if (props.data) for (const [k, v] of Object.entries(props.data)) el.dataset[k] = v
  if (props.style) Object.assign(el.style, props.style)

  const anyEl = el as unknown as Record<string, unknown>
  for (const key of ['type', 'value', 'min', 'max', 'step', 'placeholder', 'disabled', 'readOnly', 'rows'] as const) {
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
  node.replaceChildren()
}

export function fmtKbps(kbps: number): string {
  if (kbps <= 0) return '0'
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${Math.round(kbps)} kb/s`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard write fails without permission or focus.
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

// A list redrawn between press and release never gets the click, so act on the press.
export function onPress(el: HTMLElement, fn: (ev: Event) => void): void {
  let pressed = 0
  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    pressed = Date.now()
    fn(ev)
  })
  el.addEventListener('click', (ev) => {
    if (Date.now() - pressed > 600) fn(ev)
  })
}
