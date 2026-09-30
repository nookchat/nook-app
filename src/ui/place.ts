/** Room kept between a popup and the edge of what it may cover. */
const MARGIN = 6

export interface ViewArea {
  top: number
  left: number
  right: number
  bottom: number
}

/** The part of the window a popup may use: inside its edges, and below the desktop app's title bar. */
export function viewArea(): ViewArea {
  const bar = document.getElementById('nook-titlebar')
  const under = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0
  return { top: under + MARGIN, left: MARGIN, right: window.innerWidth - MARGIN, bottom: window.innerHeight - MARGIN }
}

/**
 * Puts a fixed popup with its top left corner as near this point as it can go, pushed back
 * into view wherever it would stick out. One taller than the view scrolls inside itself.
 */
export function fitInView(pop: HTMLElement, left: number, top: number): void {
  const area = viewArea()
  const room = area.bottom - area.top
  if (pop.dataset.fitted) {
    pop.style.maxHeight = ''
    pop.style.overflowY = ''
  }
  let box = pop.getBoundingClientRect()
  if (box.height > room) {
    pop.dataset.fitted = '1'
    pop.style.maxHeight = `${Math.floor(room)}px`
    pop.style.overflowY = 'auto'
    box = pop.getBoundingClientRect()
  }
  const x = Math.min(Math.max(left, area.left), Math.max(area.left, area.right - box.width))
  const y = Math.min(Math.max(top, area.top), Math.max(area.top, area.bottom - box.height))
  pop.style.left = `${Math.round(x)}px`
  pop.style.top = `${Math.round(y)}px`
}

/** Below the anchor, or above it when there is more room there, and always in view. */
export function fitNear(pop: HTMLElement, anchor: HTMLElement, gap = MARGIN): void {
  const at = anchor.getBoundingClientRect()
  const area = viewArea()
  const height = pop.getBoundingClientRect().height
  const below = area.bottom - at.bottom - gap
  const above = at.top - area.top - gap
  const under = height <= below || below >= above
  // The side it opens to, so it grows out of the anchor and not toward it.
  pop.dataset.side = under ? 'below' : 'above'
  fitInView(pop, at.left, under ? at.bottom + gap : at.top - gap - height)
}

/**
 * Beside the anchor, its top level with the anchor's, as Discord opens a profile: to the left of
 * the people list, to the right of a name in the chat. The other side when there is no room.
 */
export function fitBeside(pop: HTMLElement, anchor: HTMLElement, side: 'left' | 'right', gap = 12): void {
  const at = anchor.getBoundingClientRect()
  const area = viewArea()
  const width = pop.getBoundingClientRect().width
  const leftRoom = at.left - gap - area.left
  const rightRoom = area.right - at.right - gap
  const left = side === 'left' ? width <= leftRoom || leftRoom >= rightRoom : !(width <= rightRoom || rightRoom >= leftRoom)
  pop.dataset.side = left ? 'left' : 'right'
  fitInView(pop, left ? at.left - gap - width : at.right + gap, at.top)
}

/** At the pointer, as a right click menu opens: down and right, or flipped where it has no room. */
export function fitAtPoint(pop: HTMLElement, x: number, y: number): void {
  const area = viewArea()
  const box = pop.getBoundingClientRect()
  const left = x + box.width > area.right ? x - box.width : x
  const up = y + box.height > area.bottom
  pop.dataset.side = up ? 'above' : 'below'
  fitInView(pop, left, up ? y - box.height : y)
}
