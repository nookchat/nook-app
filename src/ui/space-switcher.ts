/**
 * Going from one space to another.
 *
 * There was a rail of tiles down the left edge for this, one per space, and
 * it cost a column of the window for a thing done a few times a day. Now the
 * name at the top of the channels is the way: press it and every space is
 * there, with what is waiting in each, and Home, and making a new one. The
 * space's own actions (inviting, settings, leaving) sit under the list.
 *
 * The button says when something is waiting elsewhere, so nothing is missed
 * for the list being out of sight: a dot for news, a count for mentions and
 * direct messages.
 *
 * The order is this device's own and it holds still. The store lists spaces by
 * when they were last opened, which is right for the home page and wrong for
 * a switcher: a list that reshuffles every time it is used cannot be learned.
 * A new space goes on the end.
 */

import { ROOMS_CHANGED, type RoomNote } from '../store/notes'
import { listSpaces } from '../store/spaces'
import { spaces } from '../space/registry'
import { h } from './dom'
import { icon } from './icons'
import { openMenu, type MenuEntry } from './menu'
import type { Navigation } from './shell'

const ORDER_KEY = 'cathode.rail.v1'

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

/** Every space worth listing, in this device's own order. */
export async function orderedSpaces(): Promise<RoomNote[]> {
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

/** A space's tile: its initials on its own colour. */
export function spaceFace(room: string, title: string, size = 28): HTMLElement {
  const face = h('span', { class: 'space-face', text: initials(title || 'Unnamed space') })
  face.style.setProperty('--hue', String(spaceHue(room)))
  face.style.setProperty('--size', `${size}px`)
  return face
}

/** Home's tile, a house. */
export function homeFace(size = 28): HTMLElement {
  const face = h('span', { class: 'space-face home' }, [icon('home', Math.round(size * 0.6))])
  face.style.setProperty('--size', `${size}px`)
  return face
}

const count = (n: number): HTMLElement => h('span', { class: 'switch-count', text: n > 99 ? '99+' : String(n) })

/**
 * What is waiting, everywhere but where you are. `here` is the room on
 * screen, or null at home, where direct messages are already in view.
 */
function waitingElsewhere(here: string | null): { news: boolean; loud: number } {
  let news = false
  let loud = 0
  for (const space of spaces.all()) {
    const u = space.unread()
    // Direct messages are read at home, so they are waiting unless you are there.
    if (here !== null) loud += u.direct
    if (space.room?.id === here) continue
    if (u.count) news = true
    loud += u.mentions
  }
  return { news: news || loud > 0, loud }
}

/**
 * The name at the top of the channels, as the switcher.
 *
 * `active` is the code of the space on screen, or null at home: the code
 * rather than the room id, because the id is not known until the key has been
 * made, and this is drawn before that. `more` is what this screen adds under
 * the list, such as a space's own actions.
 */
export function switcherButton(options: {
  active: string | null
  face: HTMLElement
  name: HTMLElement
  nav: Navigation
  more?: () => MenuEntry[]
}): HTMLButtonElement {
  const mark = h('span', { class: 'switch-mark hidden' })
  const button = h(
    'button',
    {
      class: 'space-title-button',
      title: 'Switch space',
      ariaLabel: 'Switch space',
      on: { click: () => void openSwitcher(button, options) },
    },
    [options.face, options.name, mark, icon('chevron-down', 16)],
  )

  const paint = (): void => {
    if (!button.isConnected && button.dataset.drawn) {
      window.removeEventListener(ROOMS_CHANGED, paint)
      return
    }
    button.dataset.drawn = '1'
    const here = options.active === null ? null : (spaces.all().find((s) => s.secret === options.active)?.room?.id ?? '')
    const { news, loud } = waitingElsewhere(here)
    mark.classList.toggle('hidden', !news)
    mark.classList.toggle('loud', loud > 0)
    mark.textContent = loud ? (loud > 99 ? '99+' : String(loud)) : ''
    mark.title = loud ? 'Mentions and messages waiting in other spaces' : 'New messages in other spaces'
  }
  window.addEventListener(ROOMS_CHANGED, paint)
  queueMicrotask(paint)
  return button
}

async function openSwitcher(
  anchor: HTMLElement,
  options: { active: string | null; nav: Navigation; more?: () => MenuEntry[] },
): Promise<void> {
  const rooms = await orderedSpaces()
  const direct = spaces.all().reduce((sum, s) => sum + s.unread().direct, 0)
  const entries: MenuEntry[] = [
    {
      label: 'Home',
      lead: homeFace(),
      trail: direct ? count(direct) : null,
      current: options.active === null,
      run: () => options.nav.home(),
    },
    { heading: 'Spaces' },
    ...rooms.map((room): MenuEntry => {
      const here = room.secret === options.active
      const news = spaces.get(room.room)?.unread() ?? { count: 0, mentions: 0, direct: 0 }
      return {
        label: room.title || 'Unnamed space',
        lead: spaceFace(room.room, room.title),
        trail: news.mentions ? count(news.mentions) : news.count && !here ? h('span', { class: 'switch-dot' }) : null,
        current: here,
        run: () => (here ? undefined : options.nav.open(room)),
      }
    }),
    {
      label: 'Make or join a space',
      lead: h('span', { class: 'space-face add' }, [icon('plus', 16)]),
      run: () => options.nav.add(),
    },
  ]
  const more = options.more?.() ?? []
  if (more.length) entries.push('line', ...more)
  openMenu(anchor, entries, { className: 'switcher' })
}
