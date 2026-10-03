import { h } from './dom'
import { fitAbove } from './place'

/**
 * Names what a button does in a small tip over it, for every button in the app: its `data-tip`,
 * else its `title`, else the `aria-label` of a button that shows only an icon. The browser's own
 * title tip is slow and plain, so a title is held back while ours is up and put back after.
 */

/** Wait before the first tip, so a pointer crossing the app does not set them flashing. */
const FIRST_MS = 350
/** A tip already up, or just gone: the next one comes at once, as the pointer runs along a bar. */
const WARM_MS = 500

const ACTION = 'button, [role="button"], a[href], [data-tip]'

let tip: HTMLElement | null = null
let anchor: HTMLElement | null = null
let heldTitle = ''
let wait = 0
let watch = 0
let warmUntil = 0
let pointer: { x: number; y: number } | null = null

function words(el: HTMLElement): string {
  if (el.dataset.tip !== undefined) return el.dataset.tip
  if (el.title) return el.title
  if (el === anchor && heldTitle) return heldTitle
  const label = el.getAttribute('aria-label')
  // A button with words on it says them already; one with only an icon gets its label in a tip.
  return label && !el.textContent?.trim() ? label : ''
}

function target(node: EventTarget | null): HTMLElement | null {
  const el = node instanceof Element ? node.closest<HTMLElement>(ACTION) : null
  if (!el || el.closest('[data-no-tip]')) return null
  return words(el) ? el : null
}

function giveBackTitle(): void {
  if (anchor && heldTitle && !anchor.title) anchor.title = heldTitle
  heldTitle = ''
}

function hide(): void {
  window.clearTimeout(wait)
  window.clearInterval(watch)
  if (tip) warmUntil = Date.now() + WARM_MS
  tip?.remove()
  tip = null
  giveBackTitle()
  anchor = null
}

function show(el: HTMLElement): void {
  if (anchor === el && tip) return
  hide()
  anchor = el
  // Ours stands in for the browser's: the title goes while it is up.
  if (el.title) {
    heldTitle = el.title
    el.removeAttribute('title')
  }
  tip = h('div', { class: 'action-tip', role: 'tooltip', text: words(el) })
  document.body.append(tip)
  fitAbove(tip, el)
  watch = window.setInterval(() => {
    if (!anchor || !tip) return
    if (anchor.isConnected) {
      // Words changed under the pointer (Mute to Unmute): the tip says the new ones.
      if (anchor.title) {
        heldTitle = anchor.title
        anchor.removeAttribute('title')
      }
      const now = words(anchor)
      if (now && tip.textContent !== now) {
        tip.textContent = now
        fitAbove(tip, anchor)
      }
      return
    }
    // Drawn again under a still pointer: the new button there takes the tip.
    const again = pointer ? target(document.elementFromPoint(pointer.x, pointer.y)) : null
    heldTitle = ''
    anchor = null
    if (again) show(again)
    else hide()
  }, 250)
}

function soon(el: HTMLElement): void {
  if (anchor === el) return
  window.clearTimeout(wait)
  if (tip || Date.now() < warmUntil) {
    show(el)
    return
  }
  hide()
  wait = window.setTimeout(() => {
    if (el.isConnected) show(el)
  }, FIRST_MS)
}

/** Starts the tips for the whole page. Once is enough. */
export function installTips(): void {
  document.addEventListener(
    'pointerover',
    (ev) => {
      if (ev.pointerType !== 'mouse') return
      pointer = { x: ev.clientX, y: ev.clientY }
      const el = target(ev.target)
      if (el) soon(el)
      else if (anchor || wait) hide()
    },
    true,
  )
  document.addEventListener(
    'pointermove',
    (ev) => {
      if (ev.pointerType === 'mouse') pointer = { x: ev.clientX, y: ev.clientY }
    },
    { capture: true, passive: true },
  )
  document.addEventListener(
    'pointerout',
    (ev) => {
      const going = ev.relatedTarget instanceof Node ? ev.relatedTarget : null
      const from = anchor ?? (ev.target instanceof Element ? ev.target.closest<HTMLElement>(ACTION) : null)
      if (from && going && from.contains(going)) return
      if (!going || !target(going)) hide()
    },
    true,
  )
  document.addEventListener(
    'focusin',
    (ev) => {
      const el = target(ev.target)
      if (el?.matches(':focus-visible')) show(el)
    },
    true,
  )
  document.addEventListener('focusout', () => hide(), true)
  // Pressed, typed or scrolled: the tip is done.
  document.addEventListener('pointerdown', () => hide(), true)
  document.addEventListener('keydown', (ev) => ev.key === 'Escape' && hide(), true)
  document.addEventListener('scroll', () => hide(), { capture: true, passive: true })
  window.addEventListener('blur', () => hide())
}
