import { SELF_HOSTING_URL, checkServer, serverTag, serverUrl } from '../backend'
import { newSecret, parseLink } from '../room'
import { spaces } from '../space/registry'
import { loadIdentity } from '../store/identity'
import { ROOMS_CHANGED, type RoomNote } from '../store/notes'
import { addServer, newSpaceServer, ownServers } from '../store/server-spaces'
import { forgetSpace, listSpaces } from '../store/spaces'
import { h } from './dom'
import { icon } from './icons'
import { hideShadows, initials, spaceHue } from './space-switcher'
import { toast } from './toast'

interface SpaceListActions {
  open(secret: string, locked?: boolean, password?: string, newSpaceName?: string, server?: string): void
  refresh(): void
}

export async function spaceList(actions: SpaceListActions): Promise<HTMLElement> {
  const me = loadIdentity().pubkey

  const join = h('input', { type: 'text', placeholder: 'Paste an invite link or code', ariaLabel: 'Room code' })
  const go = (): void => {
    const raw = join.value.trim()
    const link = parseLink(raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw)
    if (!link) {
      join.value = ''
      join.placeholder = 'That is not an invite'
      return
    }
    actions.open(link.secret, link.locked ? true : undefined, undefined, undefined, link.server)
  }
  join.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') go()
  })

  const title = h('input', { type: 'text', placeholder: 'Name your space', ariaLabel: 'Space name' })

  const servers = ownServers()
  const where = h('select', { ariaLabel: 'Server' })
  for (const server of servers) where.append(h('option', { value: server, text: serverTag(server) }))
  where.value = newSpaceServer()

  const make = (locked: boolean): void => {
    const server = where.value || newSpaceServer()
    if (!server) return
    const name = title.value.trim().slice(0, 60)
    if (!locked) {
      actions.open(newSecret(), false, '', name, server)
      return
    }
    const password = window.prompt('Choose a password for this space.') ?? ''
    if (password) actions.open(newSecret(), true, password, name, server)
  }
  title.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') make(false)
  })

  const recent = h('div', { class: 'stack tight' })

  const leave = async (room: RoomNote): Promise<void> => {
    const label = room.title || 'this space'
    const yours = room.founder === me
    const ok = window.confirm(
      yours
        ? `Leave ${label}? It comes off your list. You made it, so it keeps going for everybody else: delete it from inside to close it.`
        : `Leave ${label}? It comes off your list. The link still works if you want back in.`,
    )
    if (!ok) return
    spaces.drop(room.room)
    await forgetSpace(room)
    toast('Left.', 'info')
    await paint()
  }

  const paint = async (): Promise<void> => {
    const rooms = hideShadows((await listSpaces()).filter((r) => !r.closed))
    const rows = rooms.slice(0, 24).map((room) => {
      const face = h('span', { class: 'space-tile', text: initials(room.title || 'Unnamed space') })
      face.style.setProperty('--hue', String(spaceHue(room.room)))
      return h('div', { class: 'row space-row' }, [
        h(
          'button',
          {
            class: 'rail-item grow',
            on: {
              click: () =>
                actions.open(room.secret, room.locked === true, room.password ?? '', undefined, room.server ?? ''),
            },
          },
          [
            face,
            h('span', { class: 'space-row-text' }, [
              h('span', { class: 'truncate space-row-name', text: room.title || 'Unnamed space' }),
              h('span', { class: 'tiny faint truncate', text: whenLabel(room.lastSeen) }),
            ]),
            room.locked ? h('span', { class: 'tiny faint', title: 'Needs a password' }, [icon('shield', 13)]) : null,
          ],
        ),
        h('button', {
          class: 'ghost tiny-btn',
          text: 'Leave',
          title: 'Take this space off your list',
          on: { click: () => void leave(room) },
        }),
      ])
    })
    if (rows.length === 0) {
      rows.push(
        h('div', { class: 'empty home-empty' }, [
          h('div', { class: 'small', text: 'No spaces yet.' }),
          h('div', { class: 'tiny faint', text: 'Make one, or paste an invite.' }),
        ]),
      )
    }
    recent.replaceChildren(...rows)
  }
  await paint()
  let queued = 0
  let shown = false
  const again = (): void => {
    if (!recent.isConnected && shown) {
      window.removeEventListener(ROOMS_CHANGED, again)
      return
    }
    shown ||= recent.isConnected
    window.clearTimeout(queued)
    queued = window.setTimeout(() => void paint(), 150)
  }
  window.addEventListener(ROOMS_CHANGED, again)

  return h('main', { class: 'home' }, [
    h('div', { class: 'home-page' }, [
      h('header', { class: 'home-hero' }, [
        h('div', { class: 'stack tight' }, [
          h('h1', { class: 'home-title', text: 'Nook' }),
          h('div', { class: 'home-tag', text: 'Chat, voice and screen sharing. End to end encrypted.' }),
        ]),
      ]),
      h('div', { class: 'home-grid' }, [
        h('section', { class: 'card stack tight home-spaces' }, [h('span', { class: 'eyebrow', text: 'Your spaces' }), recent]),
        h('div', { class: 'stack home-side' }, [
          servers.length === 0
            ? addServerCard(actions)
            : h('div', { class: 'card stack tight' }, [
                h('span', { class: 'eyebrow', text: 'New space' }),
                title,
                servers.length > 1 ? where : null,
                h('div', { class: 'row' }, [
                  h('button', { class: 'primary big grow', on: { click: () => make(false) } }, [icon('plus', 16), 'New space']),
                  h('button', {
                    class: 'big',
                    title: 'People need the password as well as the link',
                    text: 'Password',
                    on: { click: () => make(true) },
                  }),
                ]),
              ]),
          h('div', { class: 'card stack tight' }, [
            h('span', { class: 'eyebrow', text: 'Join' }),
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

function addServerCard(actions: SpaceListActions): HTMLElement {
  const input = h('input', { type: 'text', placeholder: 'cathode.example.org', ariaLabel: 'Your server' })
  const add = h('button', { class: 'primary', text: 'Add' })
  const submit = async (): Promise<void> => {
    const url = serverUrl(input.value)
    if (!url) {
      toast('That is not a server address.', 'warn')
      return
    }
    add.disabled = true
    const up = await checkServer(url)
    add.disabled = false
    if (!up) {
      toast(`No Nook server answered at ${serverTag(url)}.`, 'bad', 6000)
      return
    }
    addServer(url, true)
    toast('Server added. You can make a space now.', 'good')
    actions.refresh()
  }
  add.addEventListener('click', () => void submit())
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void submit()
  })
  const guide = h('a', { class: 'button-link', text: 'How to run one' })
  guide.href = SELF_HOSTING_URL
  guide.target = '_blank'
  guide.rel = 'noopener'
  return h('div', { class: 'card stack tight' }, [
    h('span', { class: 'eyebrow', text: 'Add server' }),
    h('div', { class: 'tiny faint', text: 'Your spaces live on a Nook server that you or a friend runs.' }),
    h('div', { class: 'row' }, [input, add]),
    guide,
  ])
}

function whenLabel(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(at).toLocaleDateString()
}
