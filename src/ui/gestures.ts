/**
 * What a finger does on a phone: a drawer pulled out from the side, a sheet or a picture pulled
 * down and away. Touch events, not pointer events: a list that can scroll takes a pointer for
 * itself once it moves, and a touch can still say no to the scroll when it is ours.
 */

/** Narrow enough that the side bars are drawers and a popup is a sheet from the bottom. */
export const PHONE = '(max-width: 780px)'

export const phone = (): boolean => window.matchMedia(PHONE).matches

/** How far a finger goes before it is a drag and not a tap. */
const SLOP = 10

export interface Drag {
  dx: number
  dy: number
  /** Pixels a millisecond, over the last moments of the drag. */
  vx: number
  vy: number
}

export interface DragHandlers {
  /** The first movement past a tap: true takes the touch, and the page does not scroll with it. */
  take(dx: number, dy: number, target: Element): boolean
  move(drag: Drag): void
  /** The finger came up, or the touch was taken away (cancelled). */
  end(drag: Drag, cancelled: boolean): void
}

/** Follows one finger on the element, once take says the drag is ours. Gives back the undo. */
export function onDrag(el: HTMLElement, handlers: DragHandlers): () => void {
  let from: { x: number; y: number; target: Element } | null = null
  let taken = false
  let last = { x: 0, y: 0, t: 0 }
  let drag: Drag = { dx: 0, dy: 0, vx: 0, vy: 0 }

  const start = (ev: TouchEvent): void => {
    if (ev.touches.length !== 1) {
      // A second finger is a pinch: whatever the first one was doing stops.
      if (taken) handlers.end(drag, true)
      from = null
      taken = false
      return
    }
    const p = ev.touches[0]
    from = { x: p.clientX, y: p.clientY, target: ev.target as Element }
    last = { x: p.clientX, y: p.clientY, t: ev.timeStamp }
    drag = { dx: 0, dy: 0, vx: 0, vy: 0 }
    taken = false
  }
  const move = (ev: TouchEvent): void => {
    if (!from || ev.touches.length !== 1) return
    const p = ev.touches[0]
    const dx = p.clientX - from.x
    const dy = p.clientY - from.y
    if (!taken) {
      if (Math.hypot(dx, dy) < SLOP) return
      // The page is already scrolling, and keeps the touch.
      if (!ev.cancelable || !handlers.take(dx, dy, from.target)) {
        from = null
        return
      }
      taken = true
    }
    ev.preventDefault()
    const dt = Math.max(1, ev.timeStamp - last.t)
    // Smoothed, so one late event does not make a flick out of a slow drag.
    drag = {
      dx,
      dy,
      vx: drag.vx * 0.4 + ((p.clientX - last.x) / dt) * 0.6,
      vy: drag.vy * 0.4 + ((p.clientY - last.y) / dt) * 0.6,
    }
    last = { x: p.clientX, y: p.clientY, t: ev.timeStamp }
    handlers.move(drag)
  }
  const stop = (ev: TouchEvent): void => {
    if (taken) {
      // A finger that stopped before it let go throws nothing.
      if (ev.timeStamp - last.t > 90) drag = { ...drag, vx: 0, vy: 0 }
      handlers.end(drag, ev.type === 'touchcancel')
    }
    from = null
    taken = false
  }

  el.addEventListener('touchstart', start, { passive: true })
  el.addEventListener('touchmove', move, { passive: false })
  el.addEventListener('touchend', stop)
  el.addEventListener('touchcancel', stop)
  return () => {
    el.removeEventListener('touchstart', start)
    el.removeEventListener('touchmove', move)
    el.removeEventListener('touchend', stop)
    el.removeEventListener('touchcancel', stop)
  }
}

/** Whether something between the target and the element can still scroll that way, and so keeps the touch. */
export function scrollsThatWay(target: Element, within: Element, dx: number, dy: number): boolean {
  for (let el: Element | null = target; el && el !== within.parentElement; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue
    const style = getComputedStyle(el)
    if (dx !== 0 && /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
      // A finger going right scrolls back toward the start.
      if (dx > 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true
    }
    if (dy !== 0 && /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) {
      if (dy > 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true
    }
  }
  return false
}

const still = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Lets a finger pull the element down and away, as a sheet or a picture goes on a phone. It
 * follows the finger, and goes past a quarter of its height or with a flick; short of that it
 * springs back. The backdrop, when there is one, fades as it goes.
 */
export function pullDownToClose(
  el: HTMLElement,
  close: () => void,
  options: { grab?: HTMLElement; moves?: HTMLElement; backdrop?: HTMLElement; ignore?: () => boolean } = {},
): () => void {
  const moves = options.moves ?? el
  const reset = (): void => {
    moves.style.transition = ''
    moves.style.transform = ''
    if (options.backdrop) options.backdrop.style.opacity = ''
  }
  return onDrag(options.grab ?? el, {
    take: (dx, dy, target) =>
      dy > 0 && dy > Math.abs(dx) * 1.2 && !options.ignore?.() && !scrollsThatWay(target, options.grab ?? el, 0, dy),
    move: ({ dy }) => {
      const y = Math.max(0, dy)
      moves.style.transition = 'none'
      moves.style.transform = `translateY(${y}px)`
      if (options.backdrop) options.backdrop.style.opacity = String(Math.max(0, 1 - y / (moves.offsetHeight || 1)))
    },
    end: ({ dy, vy }, cancelled) => {
      const away = !cancelled && dy > 0 && (dy > moves.offsetHeight * 0.25 || vy > 0.5)
      if (!away) {
        moves.style.transition = 'transform 180ms var(--ease-out)'
        moves.style.transform = ''
        if (options.backdrop) options.backdrop.style.opacity = ''
        window.setTimeout(reset, 200)
        return
      }
      if (still()) {
        close()
        return
      }
      moves.style.transition = 'transform 160ms ease-in'
      moves.style.transform = `translateY(${Math.max(window.innerHeight, moves.offsetHeight)}px)`
      if (options.backdrop) {
        options.backdrop.style.transition = 'opacity 160ms ease-in'
        options.backdrop.style.opacity = '0'
      }
      window.setTimeout(close, 160)
    },
  })
}

/**
 * Turns a popup into a sheet from the bottom of the screen, as a phone shows a menu: a handle
 * to pull it down by, a dim page behind it, and a tap on the page that only closes it. The
 * popup's own close takes it away; the sheet goes with it. Call it before the popup adds its
 * own window listeners.
 */
export function asSheet(pop: HTMLElement, close: () => void): void {
  pop.classList.add('sheet')
  // Placed as a popup first: the sheet keeps none of it.
  for (const prop of ['left', 'top', 'maxHeight', 'overflowY'] as const) pop.style[prop] = ''
  delete pop.dataset.fitted
  const grab = document.createElement('div')
  grab.className = 'sheet-grab'
  grab.setAttribute('aria-hidden', 'true')
  pop.prepend(grab)
  pullDownToClose(pop, close)

  // A tap on the dim page closes the sheet and nothing else: not the message under it. These
  // listen before the popup's own, which take it away on the same press.
  let swallow = false
  const onDown = (ev: Event): void => {
    if (!pop.isConnected) return done()
    if (!pop.contains(ev.target as Node)) swallow = true
  }
  const onClick = (ev: Event): void => {
    if (swallow) {
      ev.preventDefault()
      ev.stopPropagation()
    }
    swallow = false
    if (!pop.isConnected) done()
  }
  const done = (): void => {
    window.removeEventListener('pointerdown', onDown, true)
    window.removeEventListener('click', onClick, true)
  }
  window.addEventListener('pointerdown', onDown, true)
  window.addEventListener('click', onClick, true)
}

/**
 * Opens the element's menu on a long press of a finger, as a phone does, and keeps the browser's
 * own long press (the text selection, the callout, Android's right click) out of it.
 */
export function onLongPress(el: HTMLElement, open: (ev: { target: Element; clientX: number; clientY: number }) => boolean): void {
  let timer = 0
  let from: { x: number; y: number } | null = null
  let fired = 0
  const cancel = (): void => {
    window.clearTimeout(timer)
    from = null
  }
  el.addEventListener(
    'touchstart',
    (ev) => {
      if (ev.touches.length !== 1) return cancel()
      const p = ev.touches[0]
      const target = ev.target as Element
      if (target.closest?.('input, textarea, [contenteditable="true"]')) return
      from = { x: p.clientX, y: p.clientY }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (!from) return
        if (!open({ target, clientX: from.x, clientY: from.y })) return
        fired = Date.now()
        navigator.vibrate?.(8)
        from = null
      }, 450)
    },
    { passive: true },
  )
  el.addEventListener(
    'touchmove',
    (ev) => {
      const p = ev.touches[0]
      if (from && p && Math.hypot(p.clientX - from.x, p.clientY - from.y) > SLOP) cancel()
    },
    { passive: true },
  )
  el.addEventListener('touchend', (ev) => {
    cancel()
    // The finger coming up is not a tap on what it held: not a link opened, not a picture.
    if (Date.now() - fired < 1500) ev.preventDefault()
  })
  el.addEventListener('touchcancel', cancel)
  // Android sends its own right click for the same press: the menu is already open.
  el.addEventListener('contextmenu', (ev) => {
    if (Date.now() - fired < 1500) {
      ev.preventDefault()
      ev.stopImmediatePropagation()
    }
  })
}

/**
 * On a phone, the back button or the back gesture closes what is open, as it does in an app,
 * before it leaves the page. Gives back what to call when it closes some other way: that takes
 * its step back out of the history again, unless the page has moved on since.
 */
export function closeOnBack(close: () => void): (stepBack?: boolean) => void {
  if (!phone()) return () => undefined
  const mark = `layer-${Math.random().toString(36).slice(2)}`
  history.pushState({ nookLayer: mark }, '')
  let gone = false
  const onPop = (): void => {
    if (gone || (history.state as { nookLayer?: string } | null)?.nookLayer === mark) return
    gone = true
    window.removeEventListener('popstate', onPop)
    close()
  }
  window.addEventListener('popstate', onPop)
  return (stepBack = true) => {
    if (gone) return
    gone = true
    window.removeEventListener('popstate', onPop)
    if (stepBack && (history.state as { nookLayer?: string } | null)?.nookLayer === mark) history.back()
  }
}
