/**
 * The opening screen: the spaces you have been in.
 *
 * Every space you visit is remembered on this device, so coming back is a click
 * rather than a hunt for a link. New space makes a code; Join takes one that
 * somebody sent you, in whatever shape they sent it.
 *
 * Making one is also where you say where it runs, peer to peer or on a
 * server. The choice is the space's for good and goes out in its invite, so
 * it is asked once, here, and nowhere else. See backend.ts.
 */

import { checkServer, lastChoice, lastServer, rememberChoice, serverTag, serverUrl } from '../backend'
import { newSecret, parseLink } from '../room'
import { forgetRoom, listRooms, type RoomNote } from '../store/db'
import { loadIdentity } from '../store/identity'
import { clear, h } from './dom'
import { icon, logo } from './icons'
import { hideShadows, initials, spaceHue } from './space-rail'
import { toast } from './toast'

export interface SpaceListActions {
  /** A name means the space is being made. A server means it runs on one. */
  open(secret: string, locked?: boolean, password?: string, name?: string, server?: string): void
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
    actions.open(link.secret, link.locked ? true : undefined, undefined, undefined, link.server)
  }
  join.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') go()
  })

  const title = h('input', {
    type: 'text',
    placeholder: 'Name it. Weeknight raids, book club, work.',
    ariaLabel: 'Space name',
  })
  /*
   * Where it runs. Whatever was picked last time, which on a page built with
   * a server is that server until somebody says otherwise.
   */
  let onServer = lastChoice().server !== ''
  const serverInput = h('input', {
    type: 'text',
    placeholder: 'cathode.example.org',
    ariaLabel: 'Server address',
    value: serverTag(lastChoice().server || lastServer()),
  })
  const p2pButton = h('button', { class: 'chip', text: 'Peer to peer' })
  const serverButton = h('button', { class: 'chip' }, [icon('server', 13), 'Server'])
  const whereNote = h('div', { class: 'tiny faint' })
  const serverRow = h('div', { class: 'row' }, [serverInput])
  const paintWhere = (): void => {
    p2pButton.classList.toggle('on', !onServer)
    serverButton.classList.toggle('on', onServer)
    p2pButton.setAttribute('aria-pressed', String(!onServer))
    serverButton.setAttribute('aria-pressed', String(onServer))
    serverRow.classList.toggle('hidden', !onServer)
    whereNote.textContent = onServer
      ? 'Chat, history and every handshake go through this server, sealed so it cannot read them. It works on networks that block peer to peer, and it remembers what was said while everybody was away.'
      : 'Nothing runs anywhere. Everybody connects straight to everybody else, and every device keeps the history.'
  }
  p2pButton.addEventListener('click', () => {
    onServer = false
    paintWhere()
  })
  serverButton.addEventListener('click', () => {
    onServer = true
    paintWhere()
    if (!serverInput.value) serverInput.focus()
  })
  paintWhere()

  /** The server to make the space on, checked, or null when it cannot be used. */
  const pickServer = async (): Promise<string | null> => {
    if (!onServer) return ''
    const url = serverUrl(serverInput.value)
    if (!url) {
      toast('Say which server. It looks like cathode.example.org.', 'warn')
      serverInput.focus()
      return null
    }
    if (!(await checkServer(url))) {
      toast(`No Cathode server answered at ${serverTag(url)}.`, 'bad', 6000)
      return null
    }
    return url
  }

  /** Make a space and walk in as its founder. */
  const make = async (locked: boolean): Promise<void> => {
    const name = title.value.trim().slice(0, 60)
    const server = await pickServer()
    if (server === null) return
    rememberChoice({ server })
    if (!locked) {
      actions.open(newSecret(), false, '', name, server)
      return
    }
    const password = window.prompt('Choose a password for this space.') ?? ''
    if (password) actions.open(newSecret(), true, password, name, server)
  }
  title.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') void make(false)
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
    const rooms = hideShadows((await listRooms()).filter((r) => !r.closed))
    clear(recent)
    for (const room of rooms.slice(0, 12)) {
      const face = h('span', { class: 'space-tile', text: initials(room.title || 'Unnamed space') })
      face.style.setProperty('--hue', String(spaceHue(room.room)))
      recent.append(
        h('div', { class: 'row space-row' }, [
          h(
            'button',
            {
              class: 'rail-item grow',
              // The lock and the password travel with the space, or the code
              // alone derives a different room: same code, empty, and a second
              // row in this list next time.
              on: {
                click: () =>
                  actions.open(
                    room.secret,
                    room.locked === true,
                    room.password ?? '',
                    undefined,
                    room.server ?? '',
                  ),
              },
            },
            [
              face,
              h('span', { class: 'space-row-text' }, [
                h('span', { class: 'truncate space-row-name', text: room.title || 'Unnamed space' }),
                h('span', {
                  class: 'tiny faint truncate',
                  text: `${room.server ? serverTag(room.server) : 'Peer to peer'} · ${whenLabel(room.lastSeen)}`,
                }),
              ]),
              room.server
                ? h('span', { class: 'tiny faint', title: `Runs on ${serverTag(room.server)}` }, [
                    icon('server', 13),
                  ])
                : null,
              room.locked
                ? h('span', { class: 'tiny faint', title: 'Needs a password' }, [icon('shield', 13)])
                : null,
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
        h('div', { class: 'empty home-empty' }, [
          h('div', { class: 'small', text: 'No spaces yet.' }),
          h('div', { class: 'tiny faint', text: 'Make one, or paste an invite.' }),
        ]),
      )
    }
  }
  await paint()

  return h('main', { class: 'home' }, [
    h('div', { class: 'home-page' }, [
      h('header', { class: 'home-hero' }, [
        h('span', { class: 'home-mark' }, [logo(40)]),
        h('div', { class: 'stack tight' }, [
          h('h1', { class: 'home-title', text: 'Cathode' }),
          h('div', {
            class: 'home-tag',
            text: 'Chat, voice and screen sharing. Peer to peer, or on your own server. Sealed end to end either way.',
          }),
        ]),
      ]),
      h('div', { class: 'home-grid' }, [
        h('section', { class: 'card stack tight home-spaces' }, [
          h('span', { class: 'eyebrow', text: 'Your spaces' }),
          recent,
        ]),
        h('div', { class: 'stack home-side' }, [
        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Make one' }),
          title,
          h('div', { class: 'chips', role: 'group', ariaLabel: 'Where it runs' }, [
            p2pButton,
            serverButton,
          ]),
          serverRow,
          whereNote,
          h('div', { class: 'row' }, [
            h('button', { class: 'primary big grow', on: { click: () => void make(false) } }, [
              icon('plus', 16),
              'New space',
            ]),
            h('button', {
              class: 'big',
              title: 'Nobody can join with the link alone: they need the password too',
              text: 'Add a password',
              on: { click: () => void make(true) },
            }),
          ]),
          h('div', {
            class: 'tiny faint',
            text: 'Whoever makes a space is its admin. Everybody else joins as a member until you say otherwise.',
          }),
        ]),
        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Join one' }),
          h('div', { class: 'row' }, [
            join,
            h('button', { class: 'join-button', text: 'Join', on: { click: go } }, [icon('enter', 15)]),
          ]),
        ]),
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
