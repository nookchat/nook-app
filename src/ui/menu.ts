import { h } from './dom'
import { placeNear } from './emoji'

export interface MenuItem {
  label: string
  note?: string
  danger?: boolean
  lead?: HTMLElement
  trail?: HTMLElement | null
  current?: boolean
  run(): void
}

export type MenuEntry = MenuItem | { heading: string } | { custom: HTMLElement } | 'line'

interface MenuOptions {
  className?: string
}

let open: (() => void) | null = null
let openFor: HTMLElement | null = null

function sameButton(a: HTMLElement | null, b: HTMLElement): boolean {
  return !!a && (a === b || (!!a.dataset.menu && a.dataset.menu === b.dataset.menu))
}

export function openMenu(anchor: HTMLElement, items: MenuEntry[], options: MenuOptions = {}): void {
  if (open && sameButton(openFor, anchor)) {
    open()
    return
  }
  open?.()
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
    if ('custom' in item) {
      menu.append(item.custom)
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
    openFor = null
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
    const step = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    const buttons = [...menu.querySelectorAll<HTMLElement>('.menu-item')]
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    buttons[(at + step + buttons.length) % buttons.length]?.focus()
    ev.preventDefault()
  }
  const onDown = (ev: Event): void => {
    const target = ev.target as Node
    if (menu.contains(target) || anchor.contains(target)) return
    const button = (target as Element).closest?.('[data-menu]')
    if (button instanceof HTMLElement && sameButton(anchor, button)) return
    close()
  }

  open = close
  openFor = anchor
  document.body.append(menu)
  placeNear(menu, anchor)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('pointerdown', onDown, true)
  window.addEventListener('resize', close)
}
