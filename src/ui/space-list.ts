import { SELF_HOSTING_URL, checkServer, serverTag, serverUrl } from '../backend'
import { newSecret, parseLink } from '../room'
import { discordTemplateCode } from '../space/discord'
import type { SpaceMaking } from '../space/runtime'
import { ROOMS_CHANGED } from '../store/notes'
import { addServer, newSpaceServer, ownServers } from '../store/server-spaces'
import { spaces } from '../space/registry'
import { bookFor } from '../store/server-spaces'
import { listSpaces } from '../store/spaces'
import { onContextMenu } from './menu'
import { confirmDanger } from './ask'
import { h } from './dom'
import { ghost, lockup } from './ghost'
import { icon } from './icons'
import { spinner } from './spinner'
import { hideShadows, initials } from './space-switcher'
import { toast } from './toast'

interface SpaceListActions {
  open(secret: string, locked?: boolean, password?: string, newSpaceName?: string, server?: string, made?: SpaceMaking): void
  refresh(): void
  /** Opens the steps to make a space at once, as Add a space does. */
  making?: boolean
}

/** Takes a space off your list on every device, with no need to open it. The link still works. */
async function leave(room: string, server: string, name: string): Promise<void> {
  if (!server) return
  if (!(await confirmDanger(`Leave ${name}?`, 'It comes off your list on every device. The link still works if you want back in.', 'Leave'))) return
  spaces.drop(room)
  const book = bookFor(server)
  await book.forget(room)
  await book.flush()
  toast('Left. It is off your list.', 'info')
}

export async function spaceList(actions: SpaceListActions): Promise<HTMLElement> {
  const servers = ownServers()

  /** The steps to make a space. A Discord template link starts them at the copy. */
  let making = false
  const makeSpace = async (discordLink = ''): Promise<void> => {
    const server = newSpaceServer()
    if (!server || making) {
      if (!server) toast('Add a server first. Your spaces live on it.', 'warn')
      return
    }
    making = true
    const { newSpaceFlow } = await import('./new-space')
    const made = await newSpaceFlow(servers, server, discordLink)
    making = false
    if (made) actions.open(newSecret(), made.password !== '', made.password, made.name, made.server, made.made)
  }
  if (actions.making && servers.length) queueMicrotask(() => void makeSpace())

  const join = h('input', { type: 'text', placeholder: 'Paste an invite link or code', ariaLabel: 'Room code' })
  const go = (): void => {
    const raw = join.value.trim()
    if (discordTemplateCode(raw)) {
      join.value = ''
      void makeSpace(raw)
      return
    }
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

  const recent = h('div', { class: 'stack tight' })

  const paint = async (): Promise<void> => {
    const rooms = hideShadows((await listSpaces()).filter((r) => !r.closed))
    const rows = rooms.slice(0, 24).map((room) => {
      const face = h('span', { class: 'space-tile', text: room.picture ? '' : initials(room.title || 'Unnamed space') })
      if (room.picture) {
        const img = h('img', { class: 'space-face-img' })
        img.alt = ''
        img.src = room.picture
        face.append(img)
      }
      const row = h('div', { class: 'row space-row' }, [
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
          ],
        ),
      ])
      // A right click leaves it, as on Discord, with no need to open it first.
      onContextMenu(row, () => [
        {
          label: 'Leave',
          danger: true,
          lead: h('span', { class: 'menu-icon' }, [icon('leave', 16)]),
          run: () => void leave(room.room, room.server ?? '', room.title || 'this space'),
        },
      ])
      return row
    })
    // A slow server has not sent the list yet: that is not the same as no spaces.
    if (rows.length === 0 && !spaces.listed) rows.push(spinner('Loading your spaces', 'big'))
    else if (rows.length === 0) {
      rows.push(
        h('div', { class: 'empty home-empty' }, [
          ghost({ mood: 'idle', size: 96 }),
          h('div', { class: 'empty-title', text: 'No spaces yet' }),
          h('div', { class: 'small faint', text: 'Make one for your friends, or paste an invite.' }),
          servers.length ? h('button', { class: 'secondary', on: { click: () => void makeSpace() } }, [icon('plus', 16), 'Make a space']) : null,
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
      h('header', { class: 'home-hero' }, [h('h1', { class: 'home-title' }, [lockup(40)])]),
      h('div', { class: 'home-grid' }, [
        h('section', { class: 'card stack tight home-spaces' }, [h('span', { class: 'eyebrow', text: 'Your spaces' }), recent]),
        h('div', { class: 'stack home-side' }, [
          servers.length === 0
            ? addServerCard(actions)
            : h('div', { class: 'card stack tight' }, [
                h('span', { class: 'eyebrow', text: 'New space' }),
                h('div', { class: 'tiny faint', text: 'Start from a template for friends, gaming, study and more, or from scratch.' }),
                h('button', { class: 'primary big new-space', on: { click: () => void makeSpace() } }, [icon('plus', 16), 'New space']),
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
  const input = h('input', { type: 'text', placeholder: 'nook.example.org', ariaLabel: 'Your server' })
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
