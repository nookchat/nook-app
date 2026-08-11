/**
 * The opening screen: the spaces you have been in.
 *
 * Every space you visit is remembered on this device, so coming back is a click
 * rather than a hunt for a link. New space makes a code; Join takes one that
 * somebody sent you, in whatever shape they sent it.
 */

import { newSecret, parseSecret } from '../room'
import { listRooms } from '../store/db'
import { clear, h } from './dom'
import { icon } from './icons'

export interface SpaceListActions {
  open(secret: string): void
}

export async function spaceList(actions: SpaceListActions): Promise<HTMLElement> {
  const rooms = await listRooms()

  const join = h('input', {
    type: 'text',
    placeholder: 'Paste a code or a link',
    ariaLabel: 'Room code',
  })
  const go = (): void => {
    const raw = join.value.trim()
    const code = parseSecret(raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw)
    if (!code) {
      join.value = ''
      join.placeholder = 'That is not a code'
      return
    }
    actions.open(code)
  }
  join.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') go()
  })

  const recent = h('div', { class: 'stack tight' })
  for (const room of rooms.slice(0, 12)) {
    recent.append(
      h(
        'button',
        { class: 'rail-item', on: { click: () => actions.open(room.secret) } },
        [
          h('span', { class: 'grow truncate mono', text: room.secret.slice(0, 5) + '...' }),
          h('span', { class: 'tiny faint', text: whenLabel(room.lastSeen) }),
        ],
      ),
    )
  }
  if (rooms.length === 0) {
    recent.append(
      h('div', { class: 'empty' }, [
        h('div', { class: 'small', text: 'No spaces yet.' }),
        h('div', { class: 'tiny faint', text: 'Make one, or paste an invite.' }),
      ]),
    )
  }

  return h('main', {}, [
    h('div', { class: 'center-page' }, [
      h('div', { class: 'sheet stack' }, [
        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Your spaces' }),
          recent,
        ]),
        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Join one' }),
          h('div', { class: 'row' }, [
            join,
            h('button', { text: 'Join', on: { click: go } }),
          ]),
        ]),
        h('div', { class: 'row' }, [
          h(
            'button',
            { class: 'primary big grow', on: { click: () => actions.open(newSecret()) } },
            [icon('plus', 16), 'New space'],
          ),
        ]),
      ]),
    ]),
  ])
}

function whenLabel(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(at).toLocaleDateString()
}

export { clear }
