import { h } from './dom'

/**
 * A sent spoiler: concealed behind an animated "encrypted" noise texture that the reader
 * scratches away like a scratch card, rather than a flat block to click through. Kept in
 * four independent pieces, so any one can change without touching the others:
 *  - the noise texture itself (`paintNoise`)
 *  - the scratch mask that remembers what's been cleared (`Scratch`)
 *  - the reveal threshold / click-through rule (the coverage check and drag-slop in `veil`)
 *  - the completion animation (the `dissolving` class, driven by CSS)
 */

/** CSS px radius a single scratch stroke clears. */
const SCRATCH_RADIUS = 14
/** How coarsely coverage is tracked; coarser cells mean a couple of swipes are enough. */
const GRID_COLS = 16
const GRID_ROWS = 5
/** Fraction of the grid that must be scratched clear before the rest dissolves on its own. */
const REVEAL_FRACTION = 0.4
/** A pointer move shorter than this, start to end, counts as a tap/click rather than a scratch. */
const CLICK_SLOP = 6
/** How often the noise redraws itself; slower than 60fps reads as "glitchy" rather than smooth. */
const FRAME_MS = 110

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** One frame of concealing noise: small random-toned blocks, redrawn fresh each call. */
function paintNoise(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h)
  const cell = 3
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      const v = Math.random()
      ctx.fillStyle = v < 0.45 ? 'rgba(18,18,24,0.93)' : v < 0.78 ? 'rgba(72,72,88,0.85)' : 'rgba(150,150,170,0.55)'
      ctx.fillRect(x, y, cell, cell)
    }
  }
}

/** Tracks scratched-clear strokes and how much of the box they cover. */
class Scratch {
  private readonly strokes: Array<{ x: number; y: number }> = []
  private readonly touched = new Set<number>()
  private readonly cells = GRID_COLS * GRID_ROWS

  constructor(private w: number, private h: number) {}

  resize(w: number, h: number): void {
    this.w = w
    this.h = h
  }

  add(x: number, y: number): void {
    this.strokes.push({ x, y })
    const col = Math.min(GRID_COLS - 1, Math.max(0, Math.floor((x / this.w) * GRID_COLS)))
    const row = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor((y / this.h) * GRID_ROWS)))
    this.touched.add(row * GRID_COLS + col)
  }

  /** Cuts every scratched stroke out of whatever's currently on `ctx`, so text shows through. */
  punch(ctx: CanvasRenderingContext2D): void {
    if (this.strokes.length === 0) return
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = '#000'
    for (const s of this.strokes) {
      ctx.beginPath()
      ctx.arc(s.x, s.y, SCRATCH_RADIUS, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  coverage(): number {
    return this.touched.size / this.cells
  }
}

/**
 * The concealed veil over a spoiler's text: an animated (or, under reduced motion, static)
 * noise canvas that scratches away under the pointer, a plain click/tap as a fallback, and a
 * dissolve once enough of it is cleared. `onReveal` fires exactly once, however it was revealed.
 */
function veil(wrap: HTMLElement, onReveal: () => void): { canvas: HTMLCanvasElement; complete(): void } {
  const canvas = document.createElement('canvas')
  canvas.className = 'spoiler-veil'
  canvas.style.touchAction = 'none'
  const ctx = canvas.getContext('2d')!
  const reduce = reducedMotion()

  let boxW = 0
  let boxH = 0
  const scratch = new Scratch(0, 0)
  let stopped = false
  let timer = 0

  const redraw = (): void => {
    paintNoise(ctx, boxW, boxH)
    scratch.punch(ctx)
  }

  const fit = (): void => {
    const rect = wrap.getBoundingClientRect()
    boxW = Math.max(1, rect.width)
    boxH = Math.max(1, rect.height)
    scratch.resize(boxW, boxH)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(boxW * dpr)
    canvas.height = Math.round(boxH * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    redraw()
  }
  const ro = new ResizeObserver(fit)
  ro.observe(wrap)
  fit()

  const loop = (): void => {
    if (stopped) return
    redraw()
    timer = window.setTimeout(loop, FRAME_MS)
  }
  if (!reduce) timer = window.setTimeout(loop, FRAME_MS)

  const complete = (): void => {
    if (stopped) return
    stopped = true
    window.clearTimeout(timer)
    ro.disconnect()
    if (reduce) {
      canvas.remove()
      onReveal()
      return
    }
    canvas.classList.add('dissolving')
    canvas.addEventListener(
      'animationend',
      () => {
        canvas.remove()
        onReveal()
      },
      { once: true },
    )
  }

  let dragging = false
  let downX = 0
  let downY = 0
  let moved = 0
  const localXY = (ev: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect()
    return [ev.clientX - rect.left, ev.clientY - rect.top]
  }
  const scratchAt = (ev: PointerEvent): void => {
    const [x, y] = localXY(ev)
    scratch.add(x, y)
    if (reduce) redraw()
    if (scratch.coverage() >= REVEAL_FRACTION) complete()
  }
  canvas.addEventListener('pointerdown', (ev) => {
    if (stopped) return
    dragging = true
    moved = 0
    downX = ev.clientX
    downY = ev.clientY
    canvas.setPointerCapture(ev.pointerId)
    scratchAt(ev)
    ev.preventDefault()
  })
  canvas.addEventListener('pointermove', (ev) => {
    if (!dragging || stopped) return
    moved = Math.max(moved, Math.hypot(ev.clientX - downX, ev.clientY - downY))
    scratchAt(ev)
  })
  const release = (): void => {
    if (!dragging) return
    dragging = false
    // A tap, or a click with no real drag, always reveals: scratching is never required.
    if (moved < CLICK_SLOP) complete()
  }
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)
  return { canvas, complete }
}

/**
 * A spoiler as it reads once sent: concealed until scratched, clicked/tapped, or activated
 * from the keyboard. `revealed` restores an already-opened spoiler (e.g. after a re-render);
 * `onReveal` is the caller's hook to remember that past this render too.
 */
export function spoilerReveal(text: string, revealed: boolean, onReveal: () => void): HTMLElement {
  const words = h('span', { class: 'spoiler-words', text })
  const wrap = h('span', { class: `spoiler-box${revealed ? ' revealed' : ''}` }, [words])
  if (revealed) return wrap

  wrap.tabIndex = 0
  wrap.setAttribute('role', 'button')
  wrap.setAttribute('aria-label', 'Hidden spoiler. Press enter or space to reveal.')
  wrap.title = 'Hidden. Scratch, click or press space to reveal.'

  const open = (): void => {
    if (wrap.classList.contains('revealed')) return
    wrap.classList.add('revealed')
    wrap.removeAttribute('role')
    wrap.removeAttribute('aria-label')
    wrap.removeAttribute('tabindex')
    wrap.title = ''
    onReveal()
  }

  const { canvas, complete } = veil(wrap, open)
  wrap.append(canvas)
  wrap.addEventListener('keydown', (ev) => {
    const key = (ev as KeyboardEvent).key
    if (key !== 'Enter' && key !== ' ') return
    ev.preventDefault()
    complete()
  })
  return wrap
}
