/**
 * A menu, hanging off whatever was pressed.
 *
 * The members list used to carry a row of small icon buttons per person: an
 * arrow to promote, an arrow to move them into a voice channel, a cross to
 * remove. Three unlabelled targets a few pixels apart, one of which cannot be
 * undone, sitting in a column narrow enough that they collided with the name.
 * A menu says what each one does in words, and asks for two deliberate presses
 * instead of one hopeful one.
 *
 * It lives on the body rather than inside the row that opened it, for the same
 * reason the emoji picker does: the rail scrolls and would clip it.
 */

import { clear, h } from './dom'
import { placeNear } from './emoji'

export interface MenuItem {
  label: string
  /** Shown under the label when the label alone would be a guess. */
  note?: string
  /** Red, for the ones that take something away. */
  danger?: boolean
  /** A face or an icon before the label. */
  lead?: HTMLElement
  /** A count or a mark after it. */
  trail?: HTMLElement | null
  /** The one you are already on. */
  current?: boolean
  run(): void
}

/** A label over a group of items, or a line between two groups. */
export type MenuEntry = MenuItem | { heading: string } | 'line'

export interface MenuOptions {
  /** An extra class, for a menu that is laid out differently. */
  className?: string
}

/** Only one is ever open, for the same reason only one picker is. */
let open: (() => void) | null = null

export function closeMenu(): void {
  open?.()
}

export function openMenu(anchor: HTMLElement, items: MenuEntry[], options: MenuOptions = {}): void {
  closeMenu()
  if (items.length === 0) return

  const menu = h('div', { class: `menu${options.className ? ` ${options.className}` : ''}`, role: 'menu' })
  for (const item of items) {
    if (item === 'line') {
      menu.append(h('div', { class: 'menu-line', role: 'separator' }))
      continue
    }
    if ('heading' in item) {
      menu.append(h('div', { class: 'menu-heading', text: item.heading }))
      continue
    }
    const words = h('span', { class: 'menu-words' }, [
      h('span', { class: 'menu-label truncate', text: item.label }),
      item.note ? h('span', { class: 'tiny faint', text: item.note }) : null,
    ])
    const button = h(
      'button',
      {
        class: `menu-item${item.danger ? ' danger' : ''}${item.lead ? ' has-lead' : ''}${item.current ? ' current' : ''}`,
        role: 'menuitem',
        on: {
          click: () => {
            close()
            item.run()
          },
        },
      },
      item.lead ? [item.lead, words, item.trail ?? null] : [words, item.trail ?? null],
    )
    if (item.current) button.setAttribute('aria-current', 'true')
    menu.append(button)
  }

  function close(): void {
    if (open !== close) return
    open = null
    menu.remove()
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('pointerdown', onDown, true)
    window.removeEventListener('resize', close)
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      close()
      anchor.focus()
      return
    }
    if (!ev.key.startsWith('Arrow')) return
    const options = [...menu.querySelectorAll('.menu-item')].filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    )
    const at = options.indexOf(document.activeElement as HTMLElement)
    const step = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    const next = options[(at + step + options.length) % options.length]
    next?.focus()
    ev.preventDefault()
  }
  const onDown = (ev: Event): void => {
    const target = ev.target as Node
    if (menu.contains(target) || anchor.contains(target)) return
    close()
  }

  open = close
  document.body.append(menu)
  placeNear(menu, anchor)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('pointerdown', onDown, true)
  window.addEventListener('resize', close)
}

export { clear }
