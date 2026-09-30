import { h } from './dom'

/**
 * Words that do not fit slide slowly to their end, wait, and slide back, as Discord's long song
 * names do. Words that fit stay still. It measures itself again whenever its width changes.
 */
export function marquee(text: string, cls = ''): HTMLElement {
  const inner = h('span', { class: 'marquee-text', text })
  const box = h('span', { class: `marquee${cls ? ` ${cls}` : ''}`, title: text }, [inner])
  const measure = (): void => {
    // The box's own scroll width: the words inside are inline while they are still.
    const over = Math.max(box.scrollWidth, inner.scrollWidth) - box.clientWidth
    const moving = box.clientWidth > 0 && over > 2
    box.classList.toggle('moving', moving)
    if (!moving) return
    box.style.setProperty('--shift', `${-over}px`)
    // About 30 pixels a second, with the waits at each end.
    const seconds = Math.max(6, 4 + over / 30)
    box.style.setProperty('--marquee-s', `${seconds.toFixed(1)}s`)
    // In step with the clock, so a list drawn again carries on where it was, and does not start over.
    inner.style.animationDelay = `${-((performance.now() / 1000) % seconds).toFixed(2)}s`
  }
  new ResizeObserver(measure).observe(box)
  return box
}
