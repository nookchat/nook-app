/**
 * The rail of spaces, down the left edge.
 *
 * One button per space, a tile with its initials on it, so going from one to
 * another is a click rather than a trip back through the list. The mark at the
 * top goes home, and the plus at the bottom makes or joins one.
 *
 * The order is this device's own and it holds still. The store lists spaces by
 * when they were last opened, which is right for a list and wrong for a rail:
 * a row of buttons that reshuffles every time one is pressed is a row you
 * cannot learn. A new space goes on the end.
 */

import { ROOMS_CHANGED, type RoomNote } from '../store/db'
import { listSpaces } from '../store/spaces'
import { serverTag } from '../backend'
import { h } from './dom'
import { icon, logo } from './icons'

const ORDER_KEY = 'cathode.rail.v1'

export interface SpaceRailActions {
  home(): void
  /** Make or join one: the home screen, with the name field ready. */
  add(): void
  open(room: RoomNote): void
}

function loadOrder(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveOrder(order: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order))
  } catch {
    /* the order lasts for this visit */
  }
}

/** The spaces worth a button, in the rail's own order. */
export async function railRooms(): Promise<RoomNote[]> {
  const rooms = hideShadows((await listSpaces()).filter((r) => !r.closed))
  const known = loadOrder()
  const byRoom = new Map(rooms.map((r) => [r.room, r]))
  // Newest first from the store, so the ones not in the order yet go on the
  // end in the order they were made.
  const fresh = rooms
    .filter((r) => !known.includes(r.room))
    .sort((a, b) => a.lastSeen - b.lastSeen)
    .map((r) => r.room)
  const order = [...known.filter((id) => byRoom.has(id)), ...fresh]
  if (order.join() !== known.join()) saveOrder(order)
  return order.map((id) => byRoom.get(id)!).filter(Boolean)
}

/**
 * Drop the empty twin a locked space used to leave behind: the nameless room
 * opening a locked code without its password made. See space-list.ts.
 */
export function hideShadows(rooms: RoomNote[]): RoomNote[] {
  const locked = new Set(rooms.filter((r) => r.locked && r.password).map((r) => r.secret))
  return rooms.filter((r) => !(!r.locked && !r.title && locked.has(r.secret)))
}

/** One or two letters for a tile. */
export function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return [...words[0]].slice(0, 2).join('').toUpperCase()
  return ((words[0][0] ?? '') + (words[1][0] ?? '')).toUpperCase()
}

/** A hue per space, worked out from its id so it is the same on every visit. */
export function spaceHue(room: string): number {
  let sum = 0
  for (let i = 0; i < room.length; i++) sum = (sum * 33 + room.charCodeAt(i)) % 3600
  return sum % 360
}

/**
 * Draw the rail into its slot, and keep it up to date until the slot goes.
 * `active` is the code of the space on screen, or null at home. The code
 * rather than the room id, because the id is not known until the key has
 * been made, and the rail is drawn before that.
 */
export function mountSpaceRail(slot: HTMLElement, active: string | null, actions: SpaceRailActions): void {
  let drawn = ''
  let queued = 0

  const paint = async (): Promise<void> => {
    const rooms = await railRooms()
    // Nothing that shows has changed: leave the buttons alone, hover and all.
    const sig = `${active}|${rooms.map((r) => `${r.room}:${r.title}:${r.server ?? ''}`).join('|')}`
    if (sig === drawn) return
    drawn = sig

    const home = h('button', {
      class: `rail-tile home${active === null ? ' on' : ''}`,
      ariaLabel: 'Home',
      data: { tip: 'Home' },
      on: { click: () => actions.home() },
    })
    home.append(logo(26))

    const tiles = rooms.map((room) => {
      const title = room.title || 'Unnamed space'
      const tile = h(
        'button',
        {
          class: `rail-tile${room.secret === active ? ' on' : ''}`,
          ariaLabel: title,
          data: { tip: room.server ? `${title} · ${serverTag(room.server)}` : title },
          on: { click: () => actions.open(room) },
        },
        [h('span', { class: 'rail-tile-face', text: initials(title) })],
      )
      tile.style.setProperty('--hue', String(spaceHue(room.room)))
      if (room.server) {
        tile.append(h('span', { class: 'rail-tile-badge' }, [icon('server', 9)]))
      }
      return tile
    })

    const add = h('button', {
      class: 'rail-tile add',
      ariaLabel: 'Make or join a space',
      data: { tip: 'Make or join a space' },
      on: { click: () => actions.add() },
    })
    add.append(icon('plus', 20))

    slot.replaceChildren(home, h('div', { class: 'rail-sep' }), ...tiles, add)
  }

  const later = (): void => {
    if (!slot.isConnected && drawn) {
      window.removeEventListener(ROOMS_CHANGED, later)
      return
    }
    window.clearTimeout(queued)
    queued = window.setTimeout(() => void paint(), 120)
  }
  window.addEventListener(ROOMS_CHANGED, later)
  void paint()
}
