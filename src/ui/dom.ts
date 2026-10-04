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

/** A row for `keyed`: what names it in its list, the row as it would be drawn now, and what its listeners hold that it does not show. */
export interface KeyedRow {
  key: string
  el: Element
  also?: string
}

/** The look of each row `keyed` put in a list: its key and a hash of how it was first drawn. */
const looks = new WeakMap<Element, { key: string; look: number }>()

/** A 53-bit hash of a string: enough that two looks never pass for one. */
function hash(text: string): number {
  let a = 0xdeadbeef
  let b = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 2654435761)
    b = Math.imul(b ^ c, 1597334677)
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909)
  return 4294967296 * (2097151 & b) + (a >>> 0)
}

/**
 * Puts these rows in the list in this order, and keeps each row already there that has the same
 * key and the same look. Only a row that changed goes in anew, so the row under the pointer keeps
 * its hover, its focus and whatever it is doing. Returns the rows now in the list, kept or new.
 */
export function keyed(list: Element, rows: KeyedRow[]): Element[] {
  const old = new Map<string, Element>()
  for (const child of [...list.children]) {
    const seen = looks.get(child)
    if (seen && !old.has(seen.key)) old.set(seen.key, child)
    else child.remove()
  }
  const out = rows.map((row) => {
    const look = hash(`${row.also ?? ''}\n${row.el.outerHTML}`)
    const was = old.get(row.key)
    if (was && looks.get(was)?.look === look) {
      old.delete(row.key)
      return was
    }
    looks.set(row.el, { key: row.key, look })
    return row.el
  })
  // Gone or changed: out first, so the rows that stay need not move past them.
  for (const gone of old.values()) gone.remove()
  out.forEach((el, i) => {
    const there = list.children[i]
    if (there !== el) list.insertBefore(el, there ?? null)
  })
  return out
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

/**
 * A level's colour as text. The colours were picked for a dark page, so on a light one they take
 * some of the text colour to stay readable (--who-keep in styles.css).
 */
export function roleInk(colour: string): string {
  return `color-mix(in srgb, ${colour} var(--who-keep), var(--text-primary))`
}
