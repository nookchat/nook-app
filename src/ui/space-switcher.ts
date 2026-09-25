import { spaces } from '../space/registry'
import { ROOMS_CHANGED, type RoomNote } from '../store/notes'
import { listSpaces } from '../store/spaces'
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
    /* storage blocked */
  }
}

async function orderedSpaces(): Promise<RoomNote[]> {
  const rooms = hideShadows((await listSpaces()).filter((r) => !r.closed))
  const known = loadOrder()
  const knownSet = new Set(known)
  const byRoom = new Map(rooms.map((r) => [r.room, r]))
  const fresh = rooms
    .filter((r) => !knownSet.has(r.room))
    .sort((a, b) => a.lastSeen - b.lastSeen)
    .map((r) => r.room)
  const order = [...known.filter((id) => byRoom.has(id)), ...fresh]
  if (order.join() !== known.join()) saveOrder(order)
  return order.map((id) => byRoom.get(id)!)
}

export function hideShadows(rooms: RoomNote[]): RoomNote[] {
  const locked = new Set(rooms.filter((r) => r.locked && r.password).map((r) => r.secret))
  return rooms.filter((r) => !(!r.locked && !r.title && locked.has(r.secret)))
}

export function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return [...words[0]].slice(0, 2).join('').toUpperCase()
  return ((words[0][0] ?? '') + (words[1][0] ?? '')).toUpperCase()
}

export function spaceHue(room: string): number {
  let sum = 0
  for (let i = 0; i < room.length; i++) sum = (sum * 33 + room.charCodeAt(i)) % 3600
  return sum % 360
}

export function spaceFace(room: string, title: string, size = 28): HTMLElement {
  const face = h('span', { class: 'space-face', text: initials(title || 'Unnamed space') })
  face.style.setProperty('--hue', String(spaceHue(room)))
  face.style.setProperty('--size', `${size}px`)
  return face
}

export function homeFace(size = 28): HTMLElement {
  const face = h('span', { class: 'space-face home' }, [icon('home', Math.round(size * 0.6))])
  face.style.setProperty('--size', `${size}px`)
  return face
}

const countText = (n: number): string => (n > 99 ? '99+' : String(n))
const count = (n: number): HTMLElement => h('span', { class: 'switch-count', text: countText(n) })

function waitingElsewhere(here: string | null): { news: boolean; loud: number } {
  const atHome = here === null
  let news = false
  let loud = 0
  for (const space of spaces.all()) {
    const u = space.unread()
    if (!atHome) loud += u.direct
    if (space.room?.id === here) continue
    if (u.count) news = true
    loud += u.mentions
  }
  return { news: news || loud > 0, loud }
}

export function switcherButton(options: {
  // The space's secret: its room id is not known yet when this draws.
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
    mark.textContent = loud ? countText(loud) : ''
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
      label: 'Add a space',
      lead: h('span', { class: 'space-face add' }, [icon('plus', 16)]),
      run: () => options.nav.add(),
    },
  ]
  const more = options.more?.() ?? []
  if (more.length) entries.push('line', ...more)
  openMenu(anchor, entries, { className: 'switcher' })
}
