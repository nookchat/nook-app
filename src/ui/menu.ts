import { h } from './dom'
import { icon } from './icons'
import { placeNear } from './emoji'
import { asSheet, onLongPress, phone } from './gestures'
import { fitAtPoint, fitBeside } from './place'

export interface MenuItem {
  label: string
  note?: string
  danger?: boolean
  lead?: HTMLElement
  trail?: HTMLElement | null
  current?: boolean
  /** A flyout of these, beside this item: hover opens it, like a submenu in a desktop app. */
  submenu?: MenuEntry[]
  run?(): void
}

export type MenuEntry = MenuItem | { heading: string } | { custom: HTMLElement } | 'line'

interface MenuOptions {
  className?: string
  /** Opens at this point, as a right click menu does, instead of under the anchor. */
  at?: { x: number; y: number }
  /** Opens beside the anchor, as a profile does, instead of under it. */
  beside?: 'left' | 'right'
}

let open: (() => void) | null = null
let openFor: HTMLElement | null = null

function sameButton(a: HTMLElement | null, b: HTMLElement): boolean {
  return !!a && (a === b || (!!a.dataset.menu && a.dataset.menu === b.dataset.menu))
}

/** How long a mouse may be off the trigger and the flyout, on its way from one to the other. */
const SUB_GRACE_MS = 220

/**
 * One item's button, for the root menu or a flyout alike. `pick` fires once a leaf item is
 * chosen; an item with its own `submenu` opens a flyout instead, so `pick` never sees it.
 */
function buildItem(item: MenuItem, pick: (item: MenuItem) => void, openSub: (button: HTMLElement, items: MenuEntry[]) => void): HTMLElement {
  const words = h('span', { class: 'menu-words' }, [
    h('span', { class: 'menu-label truncate', text: item.label }),
    item.note ? h('span', { class: 'tiny faint', text: item.note }) : null,
  ])
  const trail = item.submenu ? h('span', { class: 'menu-chevron' }, [icon('chevron-right', 14)]) : (item.trail ?? null)
  const button = h(
    'button',
    {
      class: `menu-item${item.danger ? ' danger' : ''}${item.lead ? ' has-lead' : ''}${item.current ? ' current' : ''}`,
      role: 'menuitem',
      on: {
        click: () => {
          if (item.submenu) openSub(button, item.submenu)
          else pick(item)
        },
      },
    },
    item.lead ? [item.lead, words, trail] : [words, trail],
  )
  if (item.current) button.setAttribute('aria-current', 'true')
  if (item.submenu) {
    button.setAttribute('aria-haspopup', 'true')
    button.addEventListener('mouseenter', () => openSub(button, item.submenu!))
  }
  return button
}

/** Fills `menu` from `items`, wiring each leaf to `pick` and each submenu item to `openSub`. */
function fillMenu(menu: HTMLElement, items: MenuEntry[], pick: (item: MenuItem) => void, openSub: (button: HTMLElement, items: MenuEntry[]) => void): void {
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
    menu.append(buildItem(item, pick, openSub))
  }
}

export function openMenu(anchor: HTMLElement, items: MenuEntry[], options: MenuOptions = {}): void {
  if (open && !options.at && sameButton(openFor, anchor)) {
    open()
    return
  }
  open?.()
  if (items.length === 0) return

  const menu = h('div', { class: `menu${options.className ? ` ${options.className}` : ''}`, role: 'menu' })

  // At most one flyout open at a time, for whichever item last asked for one.
  let sub: { close(): void; for: HTMLElement; pane: HTMLElement } | null = null
  const closeSub = (): void => {
    sub?.close()
    sub = null
  }
  const openSub = (button: HTMLElement, subItems: MenuEntry[]): void => {
    if (sub?.for === button) return
    closeSub()
    const pane = h('div', { class: 'menu submenu', role: 'menu' })
    fillMenu(pane, subItems, (leaf) => {
      close()
      leaf.run?.()
    }, openSub)
    document.body.append(pane)
    fitBeside(pane, button, 'right')
    let grace = 0
    const hold = (): void => window.clearTimeout(grace)
    const release = (): void => {
      hold()
      grace = window.setTimeout(closeSub, SUB_GRACE_MS)
    }
    button.addEventListener('mouseleave', release)
    pane.addEventListener('mouseenter', hold)
    pane.addEventListener('mouseleave', release)
    sub = {
      for: button,
      pane,
      close: () => {
        hold()
        button.removeEventListener('mouseleave', release)
        pane.remove()
      },
    }
  }

  fillMenu(
    menu,
    items,
    (item) => {
      close()
      item.run?.()
    },
    openSub,
  )

  function close(): void {
    if (open !== close) return
    open = null
    openFor = null
    closeSub()
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
    // Cycle within whichever menu — the root, or an open flyout — currently has the focus.
    const within = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.menu') ?? menu
    const buttons = [...within.querySelectorAll<HTMLElement>('.menu-item')]
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    buttons[(at + step + buttons.length) % buttons.length]?.focus()
    ev.preventDefault()
  }
  const onDown = (ev: Event): void => {
    const target = ev.target as Node
    if (menu.contains(target) || sub?.pane.contains(target)) return
    // A right click menu closes on any click outside it, the thing it opened on too.
    if (options.at) {
      if (ev instanceof MouseEvent && ev.button === 2 && anchor.contains(target)) return
      close()
      return
    }
    if (anchor.contains(target)) return
    const button = (target as Element).closest?.('[data-menu]')
    if (button instanceof HTMLElement && sameButton(anchor, button)) return
    close()
  }

  open = close
  openFor = anchor
  document.body.append(menu)
  // On a phone the menu is a sheet from the bottom, and the keyboard coming or going resizes the window.
  const sheet = phone()
  if (sheet) asSheet(menu, close)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('pointerdown', onDown, true)
  if (sheet) return
  if (options.at) fitAtPoint(menu, options.at.x, options.at.y)
  else if (options.beside) fitBeside(menu, anchor, options.beside)
  else placeNear(menu, anchor)
  window.addEventListener('resize', close)
}

export function closeMenu(): void {
  open?.()
}

/** Where a menu was asked for: a right click, or a long press of a finger. */
export interface MenuPoint {
  target: EventTarget | null
  clientX: number
  clientY: number
}

/**
 * Puts our own menu on a right click, and on a long press on a touch screen. Shift and right
 * click, a selection, links and text boxes still get the browser menu, so copying and opening
 * links still works.
 */
export function onContextMenu(target: HTMLElement, items: (ev: MenuPoint) => MenuEntry[]): void {
  onLongPress(target, (ev) => {
    const entries = items(ev)
    if (entries.length === 0) return false
    openMenu(target, entries, { className: 'context', at: { x: ev.clientX, y: ev.clientY } })
    return true
  })
  target.addEventListener('contextmenu', (ev) => {
    if (ev.shiftKey || ev.defaultPrevented) return
    const hit = ev.target as Element
    // Fields keep the browser's menu, for paste and spelling. Links and pictures get this one.
    if (hit.closest?.('input, textarea, [contenteditable="true"]')) return
    const picked = window.getSelection()?.toString() ?? ''
    if (picked.trim() && target.contains(window.getSelection()?.anchorNode ?? null)) return
    const entries = items(ev)
    if (entries.length === 0) return
    ev.preventDefault()
    openMenu(target, entries, { className: 'context', at: { x: ev.clientX, y: ev.clientY } })
  })
}
