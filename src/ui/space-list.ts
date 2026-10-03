import { SELF_HOSTING_URL, checkServer, serverTag, serverUrl } from '../backend'
import { newSecret, parseLink } from '../room'
import { DiscordError, discordTemplateCode, fetchDiscordTemplate, setupFromTemplate, type DiscordSetup } from '../space/discord'
import { ROOMS_CHANGED } from '../store/notes'
import { addServer, newSpaceServer, ownServers } from '../store/server-spaces'
import { spaces } from '../space/registry'
import { bookFor } from '../store/server-spaces'
import { listSpaces } from '../store/spaces'
import { onContextMenu } from './menu'
import { ask, confirmDanger } from './ask'
import { h } from './dom'
import { ghost, lockup } from './ghost'
import { icon } from './icons'
import { hideShadows, initials } from './space-switcher'
import { toast } from './toast'

interface SpaceListActions {
  open(secret: string, locked?: boolean, password?: string, newSpaceName?: string, server?: string, discord?: DiscordSetup): void
  refresh(): void
}

const DISCORD_HOW = 'In Discord: Server Settings, Server Template, Generate Template, then copy the link. Channels, roles and who can see what come over. Messages and people do not.'

/** The template's link, from what was pasted, or asked for. Empty when they gave up. */
async function askDiscordLink(): Promise<string> {
  let question = 'Copy a Discord server'
  for (;;) {
    const raw = await ask(question, { about: DISCORD_HOW, placeholder: 'https://discord.new/…', ok: 'Copy' })
    if (!raw?.trim()) return ''
    if (discordTemplateCode(raw)) return raw
    question = 'That is not a Discord template link'
  }
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
  const where = h('select', { ariaLabel: 'Server' })
  for (const server of servers) where.append(h('option', { value: server, text: serverTag(server) }))
  where.value = newSpaceServer()
  const secret = h('input', { type: 'password', placeholder: 'Password (optional)', ariaLabel: 'Space password' })
  secret.autocomplete = 'new-password'

  /** Makes a space with a Discord server's channels and roles, from its template link. */
  let copying = false
  const copyDiscord = async (link: string): Promise<void> => {
    const server = where.value || newSpaceServer()
    if (!server) {
      toast('Add a server first. The copy goes on it.', 'warn')
      return
    }
    const raw = link || (await askDiscordLink())
    const code = discordTemplateCode(raw)
    if (!code || copying) return
    copying = true
    try {
      const setup = setupFromTemplate(await fetchDiscordTemplate(code))
      const password = secret.value
      toast(`${setup.name}: ${setup.text.length + setup.voice.length} channels and ${setup.levels.length - 1} roles from Discord.`, 'good')
      actions.open(newSecret(), password !== '', password, setup.name, server, setup)
    } catch (err) {
      toast(err instanceof DiscordError ? err.message : 'That Discord template could not be read.', 'bad', 7000)
    } finally {
      copying = false
    }
  }

  const join = h('input', { type: 'text', placeholder: 'Paste an invite link or code', ariaLabel: 'Room code' })
  const go = (): void => {
    const raw = join.value.trim()
    if (discordTemplateCode(raw)) {
      void copyDiscord(raw)
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

  const title = h('input', { type: 'text', placeholder: 'Name your space', ariaLabel: 'Space name' })
  title.maxLength = 60
  const problem = h('div', { class: 'tiny field-problem hidden', role: 'alert' })

  // A password is optional: with one, people need it as well as the link.
  const make = (): void => {
    const server = where.value || newSpaceServer()
    if (!server) return
    if (discordTemplateCode(title.value)) {
      void copyDiscord(title.value)
      return
    }
    const name = title.value.trim().slice(0, 60)
    if (!name) {
      problem.textContent = 'Give the space a name.'
      problem.classList.remove('hidden')
      title.classList.add('invalid')
      title.focus()
      return
    }
    const password = secret.value
    actions.open(newSecret(), password !== '', password, name, server)
  }
  title.addEventListener('input', () => {
    problem.classList.add('hidden')
    title.classList.remove('invalid')
  })
  for (const box of [title, secret]) {
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') make()
    })
  }

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
    if (rows.length === 0) {
      rows.push(
        h('div', { class: 'empty home-empty' }, [
          ghost({ mood: 'idle', size: 96 }),
          h('div', { class: 'empty-title', text: 'No spaces yet' }),
          h('div', { class: 'small faint', text: 'Make one for your friends, or paste an invite.' }),
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
                title,
                problem,
                secret,
                h('div', { class: 'tiny faint', text: 'With a password, people need it as well as the invite link.' }),
                servers.length > 1 ? where : null,
                h('button', { class: 'primary big', on: { click: make } }, [icon('plus', 16), 'New space']),
                h('button', { class: 'ghost', text: 'Copy a Discord server', on: { click: () => void copyDiscord('') } }),
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
