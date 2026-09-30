import { avatarOf } from './chat-panel'
import { clear, h } from './dom'
import { actionRow, card, note, settingsShell, type SettingsTab } from './settings-shell'
import { icon } from './icons'
import { spaceFace } from './space-switcher'
import { toast } from './toast'

export interface SpaceSettingsActions {
  id: string
  name: string
  picture: string
  /** What your level lets you change here. */
  can: { space: boolean; levels: boolean; remove: boolean; webhooks: boolean }
  rename(): Promise<void>
  /** null takes the picture away. */
  setPicture(file: File | null): Promise<void>
  reset(): Promise<void>
  remove(): Promise<void>
  removed: { key: string; name: string; banned: boolean; restore(): void }[]
  /** Somebody was banned, so only invites made since then let a new person in. */
  invitesClosed: boolean
  /** Everybody in the space, as it is now. */
  members(): MemberRow[]
  setLevel(key: string, level: string): Promise<void>
  /** Asks first. */
  kick(key: string): Promise<void>
  /** Asks first. A removal that also closes the old invites. */
  ban(key: string): Promise<void>
  levels(): HTMLElement
  hooks: HookActions
  start?: string
  back(): void
}

export interface MemberRow {
  key: string
  name: string
  picture: string
  you: boolean
  level: { id: string; name: string; colour: string }
  /** The levels you may put them on. Empty when you may not change theirs. */
  choices: { id: string; name: string }[]
  mayRemove: boolean
}

export interface HookRow {
  id: string
  name: string
  /** The channel's name, as people see it. */
  channel: string
  /** Somebody was removed since it was made, so its link no longer works. */
  stopped: boolean
  url: string
}

export interface HookActions {
  /** '' when the space has no server: then nothing can post to it. */
  server: string
  list(): HookRow[]
  channels: { name: string; label: string }[]
  make(name: string, channel: string): Promise<void>
  /** A new link for a stopped webhook, with its name and channel. The old one goes. */
  renew(id: string): Promise<void>
  rename(id: string): Promise<void>
  /** Asks first. */
  drop(id: string): Promise<void>
}

function copyLink(url: string): void {
  navigator.clipboard.writeText(url).then(
    () => toast('Link copied. Paste it where the app asks for a Discord webhook URL.'),
    () => toast('Could not copy the link.', 'warn'),
  )
}

/** The webhooks, what they do, and what stops them. */
function webhooksPage(hooks: HookActions): HTMLElement {
  if (!hooks.server) {
    return h('div', { class: 'stack settings-stack' }, [
      card('Webhooks', note('A webhook needs a server to post to, and this space has none.')),
    ])
  }
  const page = h('div', { class: 'stack settings-stack' })
  const draw = (): void => {
    const rows = hooks.list()
    const stopped = rows.filter((row) => row.stopped).length

    const name = h('input', { type: 'text', class: 'hook-name', ariaLabel: 'Name of the webhook', placeholder: 'GitHub, Grafana, a script…' })
    name.maxLength = 80
    const channel = h('select', { class: 'hook-channel', ariaLabel: 'Channel it posts in' })
    for (const c of hooks.channels) channel.append(h('option', { value: c.name, text: `# ${c.label}` }))
    const make = h('button', { class: 'small primary', on: { click: () => void hooks.make(name.value, channel.value).then(draw) } }, [
      icon('plus', 14),
      'New webhook',
    ])
    name.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') make.click()
    })

    const list = h('div', { class: 'action-list' })
    for (const row of rows) {
      list.append(
        h('div', { class: `action-row hook-row${row.stopped ? ' stopped' : ''}` }, [
          h('span', { class: 'switch-words' }, [
            h('span', { class: 'switch-label truncate', text: row.name }),
            h('span', {
              class: 'tiny faint switch-about',
              text: row.stopped ? `Stopped. Posted in # ${row.channel}. Make a new link to use it again.` : `Posts in # ${row.channel}`,
            }),
          ]),
          row.stopped
            ? h('button', { class: 'small primary', on: { click: () => void hooks.renew(row.id).then(draw) } }, [icon('refresh', 14), 'Make a new link'])
            : h('button', { class: 'small', on: { click: () => copyLink(row.url) } }, [icon('copy', 14), 'Copy link']),
          h('button', { class: 'ghost small', title: 'Rename', ariaLabel: `Rename ${row.name}`, on: { click: () => void hooks.rename(row.id).then(draw) } }, [
            icon('edit', 14),
          ]),
          h('button', { class: 'ghost small danger', title: 'Delete', ariaLabel: `Delete ${row.name}`, on: { click: () => void hooks.drop(row.id).then(draw) } }, [
            icon('trash', 14),
          ]),
        ]),
      )
    }

    const parts: HTMLElement[] = []
    if (stopped) {
      parts.push(
        h('div', { class: 'hook-warning' }, [
          icon('shield', 18),
          h('span', {
            text:
              stopped === 1
                ? 'A webhook stopped because somebody was removed from the space. Make a new link for it, then paste the new link into every app that used the old one.'
                : `${stopped} webhooks stopped because somebody was removed from the space. Make a new link for each, then paste the new links into every app that used the old ones.`,
          }),
        ]),
      )
    }
    page.replaceChildren(
      ...parts,
      card(
        'Webhooks',
        note('A webhook lets another app post into a channel. It works like a Discord webhook: paste its link where the app asks for a Discord webhook URL.'),
        h('div', { class: 'row wrap hook-new' }, [name, channel, make]),
        rows.length ? list : note('No webhooks yet.'),
      ),
      card(
        'When a link stops working',
        h('ul', { class: 'hook-rules' }, [
          h('li', {}, [
            h('strong', { text: 'Removing or banning somebody stops every webhook. ' }),
            'The space gets a new key, so the old links no longer work. Make a new link for each webhook here, then paste it into every app that used the old one.',
          ]),
          h('li', { text: 'People who join the space, or leave it by themselves, change nothing. Your webhooks keep working.' }),
          h('li', { text: 'Deleting a webhook stops its link at once. Its old messages stay.' }),
        ]),
      ),
      card(
        'Keep the links secret',
        h('ul', { class: 'hook-rules' }, [
          h('li', { text: 'Anybody with a link can post into its channel, and can read what that webhook posted. The link opens nothing else in the space.' }),
          h('li', { text: 'The server reads what a webhook posts, because the app that posts sends plain words. Everything else in the space stays end-to-end encrypted.' }),
          h('li', { text: 'Anybody in the space who knows how could find a webhook’s link, so only add webhooks to a space whose people you trust.' }),
        ]),
      ),
    )
  }
  draw()
  return page
}

/** Everybody in the space, with their level, which whoever may change it changes here. */
function membersList(actions: SpaceSettingsActions): HTMLElement {
  const filter = h('input', { type: 'text', class: 'members-filter', ariaLabel: 'Find a member', placeholder: 'Find a member' })
  const list = h('div', { class: 'action-list members' })
  const draw = (): void => {
    clear(list)
    const wanted = filter.value.trim().toLowerCase()
    const rows = actions.members().filter((m) => !wanted || m.name.toLowerCase().includes(wanted))
    for (const m of rows) {
      const name = h('span', { class: 'switch-label truncate', text: m.you ? `${m.name} (you)` : m.name })
      if (m.level.colour) name.style.color = m.level.colour
      let level: HTMLElement
      if (m.choices.length > 1) {
        const pick = h('select', { class: 'member-level', ariaLabel: `Level for ${m.name}` })
        for (const c of m.choices) pick.append(h('option', { value: c.id, text: c.name }))
        pick.value = m.level.id
        pick.addEventListener('change', () => void actions.setLevel(m.key, pick.value).then(draw))
        level = pick
      } else {
        level = h('span', { class: 'tiny faint', text: m.level.name })
      }
      list.append(
        h('div', { class: 'action-row member-row' }, [
          h('div', { class: 'row grow member-who' }, [avatarOf(m.key, m.name, m.picture, 28), name]),
          m.mayRemove
            ? h('button', { class: 'ghost small danger', text: 'Remove', on: { click: () => void actions.kick(m.key).then(draw) } })
            : null,
          m.mayRemove
            ? h('button', { class: 'ghost small danger', text: 'Ban', on: { click: () => void actions.ban(m.key).then(draw) } })
            : null,
          level,
        ]),
      )
    }
    if (rows.length === 0) list.append(note(wanted ? 'Nobody by that name.' : 'Nobody is in this space yet.'))
  }
  filter.addEventListener('input', draw)
  draw()
  return h('div', { class: 'stack' }, [filter, list])
}

/** The tabs your level may see. Empty means the space settings are not for you. */
export function spaceTabs(actions: SpaceSettingsActions): SettingsTab[] {
  const tabs: SettingsTab[] = []
  const group = actions.name
  if (actions.can.space) {
    tabs.push({
      id: 'overview',
      label: 'Overview',
      icon: 'settings',
      group,
      build: () => {
        const picker = h('input', { type: 'file', class: 'hidden', ariaLabel: 'Choose a picture for the space' })
        picker.accept = 'image/png,image/jpeg,image/webp,image/gif'
        picker.addEventListener('change', () => {
          const chosen = picker.files?.[0]
          picker.value = ''
          if (chosen) void actions.setPicture(chosen)
        })
        const face = h(
          'button',
          {
            class: 'space-face-button',
            title: 'Change the picture',
            ariaLabel: 'Change the picture of the space',
            on: { click: () => picker.click() },
          },
          [spaceFace(actions.id, actions.name, 64, actions.picture), h('span', { class: 'welcome-face-edit' }, [icon('edit', 12)])],
        )
        return h('div', { class: 'stack settings-stack' }, [
          card(
            'Name and picture',
            note('Everybody in the space sees these, next to the space in their list.'),
            h('div', { class: 'space-card-head' }, [
              face,
              h('div', { class: 'space-card-words' }, [
                h('span', { class: 'space-card-name truncate', text: actions.name }),
                h('div', { class: 'row wrap' }, [
                  actions.picture
                    ? h('button', { class: 'ghost small', text: 'Remove picture', on: { click: () => void actions.setPicture(null) } })
                    : null,
                  h('button', { class: 'small', on: { click: () => void actions.rename() } }, [icon('edit', 14), 'Rename']),
                  h('button', { class: 'small', on: { click: () => picker.click() } }, [
                    icon('image', 14),
                    actions.picture ? 'Change picture' : 'Add a picture',
                  ]),
                ]),
              ]),
            ]),
            picker,
          ),
        ])
      },
    })
  }
  if (actions.can.levels || actions.can.remove) {
    tabs.push({
      id: 'members',
      label: 'Members',
      icon: 'people',
      group: 'People',
      build: () =>
        h('div', { class: 'stack settings-stack' }, [
          card('Members', note('Everybody in the space, and their level. Levels are changed here.'), membersList(actions)),
        ]),
    })
  }
  if (actions.can.levels) {
    tabs.push({
      id: 'levels',
      label: 'Levels',
      icon: 'crown',
      group: 'People',
      build: () =>
        h('div', { class: 'stack settings-stack' }, [
          card('Levels', actions.levels()),
        ]),
    })
  }
  if (actions.can.remove) {
    tabs.push({
      id: 'removed',
      label: 'Removed people',
      icon: 'shield',
      group: 'People',
      build: () => {
        const list = h('div', { class: 'action-list' })
        for (const p of actions.removed) {
          const row = h('div', { class: 'action-row' }, [
            h('span', { class: 'switch-label truncate', text: p.name }),
            p.banned ? h('span', { class: 'tiny faint', text: 'Banned' }) : null,
            h('button', {
              class: 'small',
              text: p.banned ? 'Unban' : 'Let back in',
              on: {
                click: () => {
                  p.restore()
                  row.remove()
                  if (list.childElementCount === 0) list.replaceWith(note('Nobody is removed from this space.'))
                },
              },
            }),
          ])
          list.append(row)
        }
        return h('div', { class: 'stack settings-stack' }, [
          card(
            'Removed people',
            note(
              'Remove: everything they write after it is ignored, and the space gets a new key. Ban: the same, and the old invite links stop letting new people in.',
            ),
            actions.removed.length ? list : note('Nobody is removed from this space.'),
          ),
          actions.invitesClosed
            ? card(
                'Invites',
                note('Somebody was banned, so an old invite link lets nobody new in. Send a new link from Invite people.'),
              )
            : null,
        ])
      },
    })
  }
  if (actions.can.webhooks) {
    tabs.push({
      id: 'webhooks',
      label: 'Webhooks',
      icon: 'link',
      build: () => webhooksPage(actions.hooks),
    })
  }
  if (actions.can.space) {
    tabs.push({
      id: 'danger',
      label: 'Clear or delete',
      icon: 'trash',
      build: () =>
        h('div', { class: 'stack settings-stack' }, [
          card(
            'For everybody',
            h('div', { class: 'action-list' }, [
              actionRow(
                'Clear history',
                'Messages, polls and pins go for everybody. Names, channels and levels stay.',
                h('button', { class: 'small danger', text: 'Clear history', on: { click: () => void actions.reset() } }),
              ),
              actionRow(
                'Delete the space',
                'It goes for everybody, on every device. This cannot be undone.',
                h('button', { class: 'small danger', text: 'Delete space', on: { click: () => void actions.remove() } }),
              ),
            ]),
          ),
        ]),
    })
  }
  return tabs
}

export function spaceSettingsView(actions: SpaceSettingsActions): HTMLElement {
  return settingsShell({ title: 'Space settings', tabs: spaceTabs(actions), start: actions.start, close: actions.back })
}
