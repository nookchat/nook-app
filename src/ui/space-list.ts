/**
 * The opening screen: the spaces you have been in.
 *
 * Every space you visit is remembered on this device, so coming back is a click
 * rather than a hunt for a link. New space makes a code; Join takes one that
 * somebody sent you, in whatever shape they sent it.
 */

import { newSecret, parseLink } from '../room'
import { forgetRoom, listRooms, type RoomNote } from '../store/db'
import { loadIdentity } from '../store/identity'
import { clear, h } from './dom'
import { icon } from './icons'
import { toast } from './toast'

export interface SpaceListActions {
  open(secret: string, locked?: boolean, password?: string, name?: string): void
}

export async function spaceList(actions: SpaceListActions): Promise<HTMLElement> {
  const me = loadIdentity().pubkey

  const join = h('input', {
    type: 'text',
    placeholder: 'Paste a code or a link',
    ariaLabel: 'Room code',
  })
  const go = (): void => {
    const raw = join.value.trim()
    const link = parseLink(raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw)
    if (!link) {
      join.value = ''
      join.placeholder = 'That is not a code'
      return
    }
    /*
     * The password is not asked for here.
     *
     * Whoever opens the space asks, and only when this device does not already
     * have it. Asking here meant being asked for the password of a space you
     * made yourself, every time somebody pasted you its link.
     */
    actions.open(link.secret, link.locked ? true : undefined)
  }
  join.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') go()
  })

  const title = h('input', {
    type: 'text',
    placeholder: 'Name it. Weeknight raids, book club, work.',
    ariaLabel: 'Space name',
  })
  /** Make a space and walk in as its founder. */
  const make = (locked: boolean): void => {
    const name = title.value.trim().slice(0, 60)
    if (!locked) {
      actions.open(newSecret(), false, '', name)
      return
    }
    const password = window.prompt('Choose a password for this space.') ?? ''
    if (password) actions.open(newSecret(), true, password, name)
  }
  title.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') make(false)
  })

  const recent = h('div', { class: 'stack tight' })

  /**
   * Take a space off this device.
   *
   * Only off this device. Deleting a space for everybody has to be announced,
   * and announcing it means being in the space, so it lives in there. From out
   * here the honest word is leave, and it is what the button says.
   */
  const leave = async (room: RoomNote): Promise<void> => {
    const label = room.title || 'this space'
    const yours = room.founder === me
    const ok = window.confirm(
      yours
        ? `Leave ${label}? Its history goes from this device. The space itself stays: you made it, so open it and delete it there to close it for everybody.`
        : `Leave ${label}? Its history goes from this device. Anybody else in it keeps theirs, and the link still works if you want back in.`,
    )
    if (!ok) return
    await forgetRoom(room.room)
    toast('Left, and forgotten on this device.', 'info')
    await paint()
  }

  /** Draw the list from the store, so leaving a space is visible at once. */
  const paint = async (): Promise<void> => {
    // A closed space keeps a note so its link says why it is gone. It is not a
    // space any more, so it is not in the list of them.
    const rooms = withoutShadows((await listRooms()).filter((r) => !r.closed))
    clear(recent)
    for (const room of rooms.slice(0, 12)) {
      recent.append(
        h('div', { class: 'row space-row' }, [
          h(
            'button',
            {
              class: 'rail-item grow',
              // The lock and the password travel with the space, or the code
              // alone derives a different room: same code, empty, and a second
              // row in this list next time.
              on: { click: () => actions.open(room.secret, room.locked === true, room.password ?? '') },
            },
            [
              h('span', { class: 'grow truncate', text: room.title || 'Unnamed space' }),
              room.locked
                ? h('span', { class: 'tiny faint', title: 'Needs a password' }, [icon('shield', 11)])
                : null,
              h('span', { class: 'tiny faint', text: whenLabel(room.lastSeen) }),
            ],
          ),
          h('button', {
            class: 'ghost tiny-btn',
            text: 'Leave',
            title: 'Take this space off this device',
            on: { click: () => void leave(room) },
          }),
        ]),
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
  }
  await paint()

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
        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Make one' }),
          title,
          h('div', { class: 'row' }, [
            h('button', { class: 'primary big grow', on: { click: () => make(false) } }, [
              icon('plus', 16),
              'New space',
            ]),
            h('button', {
              class: 'big',
              title: 'Nobody can join with the link alone: they need the password too',
              text: 'Add a password',
              on: { click: () => make(true) },
            }),
          ]),
          h('div', {
            class: 'tiny faint',
            text: 'Whoever makes a space is its admin. Everybody else joins as a member until you say otherwise.',
          }),
        ]),
      ]),
    ]),
  ])
}

/**
 * Drop the empty twin a locked space used to leave behind.
 *
 * Opening a locked space without its password derives a different room from the
 * same code: a real room, with a real note, holding nothing. Nothing makes one
 * now, but the ones already made are still sitting in people's lists next to
 * the space they are a shadow of, and clicking either was a coin toss.
 *
 * Only ever the nameless one, only when the space it shadows is right there
 * with a password, and nothing is deleted: the note stays, and so does anything
 * that was written into it.
 */
function withoutShadows(rooms: RoomNote[]): RoomNote[] {
  const locked = new Set(rooms.filter((r) => r.locked && r.password).map((r) => r.secret))
  return rooms.filter((r) => !(!r.locked && !r.title && locked.has(r.secret)))
}

function whenLabel(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(at).toLocaleDateString()
}

export { clear }
