import { avatarOf } from './chat-panel'
import { clear, h } from './dom'
import { actionRow, card, note, settingsShell, type SettingsTab } from './settings-shell'
import { icon } from './icons'
import { spaceFace } from './space-switcher'
import { volumeRow } from './soundboard'
import { toast } from './toast'

export interface SpaceSettingsActions {
  id: string
  name: string
  picture: string
  /** What your level lets you change here. */
  can: { space: boolean; channels: boolean; levels: boolean; remove: boolean; webhooks: boolean; soundboard: boolean }
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
  board: SoundboardActions
  channels: ChannelListActions
  start?: string
  back(): void
}

export interface ChannelRow {
  name: string
  label: string
  emoji: string
  topic: string
  /** Kept to some levels. */
  kept: boolean
  mediaOnly: boolean
}

export interface ChannelListActions {
  /** In their order, as the list of channels shows them. */
  list(voice: boolean): ChannelRow[]
  /** Puts them in this order, for everybody. */
  order(names: string[], voice: boolean): Promise<void>
  /** Opens the channel's own settings. */
  edit(name: string, voice: boolean): void
  /** Asks for its name and who can see it, then makes it. */
  create(voice: boolean): Promise<void>
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

export interface SoundboardActions {
  groups(): { id: string; label: string; emoji: string; mayChange: boolean }[]
  /** Ids are the wire ids. `group` is '' for none, or a group that is gone. */
  sounds(): { id: string; label: string; emoji: string; group: string; by: string; mayChange: boolean }[]
  /** Plays it here only, for whoever has the settings open. */
  play(id: string): void
  /** Each resolves once the change is made, or it is cancelled. */
  add(group: string): Promise<void>
  addGroup(): Promise<void>
  edit(id: string): Promise<void>
  /** Asks first. */
  remove(id: string): Promise<void>
  move(id: string, group: string): Promise<void>
  editGroup(id: string): Promise<void>
  /** Asks first. Its sounds stay, outside any group. */
  removeGroup(id: string): Promise<void>
}

/**
 * Every text or voice channel, in its order. A drag puts one in another place, and so do the
 * arrows, which a touch screen needs: it has no drag. Edit opens the channel's own settings.
 */
function channelList(actions: ChannelListActions, voice: boolean): HTMLElement {
  const rows = actions.list(voice)
  let names = rows.map((r) => r.name)
  const byName = new Map(rows.map((r) => [r.name, r]))
  const list = h('div', { class: 'action-list channel-order-list' })
  let dragged: string | null = null

  const move = (name: string, to: number): void => {
    const from = names.indexOf(name)
    if (from < 0 || to < 0 || to >= names.length || to === from) return
    names = names.filter((n) => n !== name)
    names.splice(to, 0, name)
    paint()
    void actions.order(names, voice)
  }

  const rowOf = (row: ChannelRow, at: number): HTMLElement => {
    const mark = row.emoji
      ? h('span', { class: 'channel-emoji', text: row.emoji, style: { width: '18px', height: '18px' } })
      : icon(voice ? 'volume' : row.mediaOnly ? 'image' : 'hash', 18)
    const up = h('button', { class: 'ghost small', title: 'Move up', ariaLabel: `Move ${row.label} up`, on: { click: () => move(row.name, at - 1) } }, [
      icon('arrow-up', 14),
    ])
    const down = h('button', { class: 'ghost small', title: 'Move down', ariaLabel: `Move ${row.label} down`, on: { click: () => move(row.name, at + 1) } }, [
      icon('arrow-down', 14),
    ])
    up.disabled = at === 0
    down.disabled = at === names.length - 1
    const el = h('div', { class: 'action-row board-row channel-order-row', title: 'Drag to put it in another place' }, [
      h('span', { class: 'channel-order-mark' }, [mark]),
      h('span', { class: 'switch-words' }, [
        h('span', { class: 'switch-label truncate', text: row.label }),
        row.topic || row.kept
          ? h('span', { class: 'tiny faint switch-about truncate', text: [row.kept ? 'Kept to some levels' : '', row.topic].filter(Boolean).join(' · ') })
          : null,
      ]),
      up,
      down,
      h('button', { class: 'ghost small', title: 'Edit channel', ariaLabel: `Edit ${row.label}`, on: { click: () => actions.edit(row.name, voice) } }, [
        icon('edit', 14),
      ]),
    ])
    el.dataset.channel = row.name
    el.draggable = true
    const below = (ev: DragEvent): boolean => {
      const box = el.getBoundingClientRect()
      return ev.clientY > box.top + box.height / 2
    }
    const unmark = (): void => el.classList.remove('drop-before', 'drop-after')
    el.addEventListener('dragstart', (ev) => {
      dragged = row.name
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move'
        ev.dataTransfer.setData('text/plain', row.name)
      }
      el.classList.add('dragging')
    })
    el.addEventListener('dragend', () => {
      dragged = null
      el.classList.remove('dragging')
    })
    el.addEventListener('dragover', (ev) => {
      if (!dragged || dragged === row.name) return
      ev.preventDefault()
      const after = below(ev)
      el.classList.toggle('drop-after', after)
      el.classList.toggle('drop-before', !after)
    })
    el.addEventListener('dragleave', (ev) => {
      if (!(ev.relatedTarget instanceof Node && el.contains(ev.relatedTarget))) unmark()
    })
    el.addEventListener('drop', (ev) => {
      unmark()
      const name = dragged
      if (!name || name === row.name) return
      ev.preventDefault()
      dragged = null
      const rest = names.filter((n) => n !== name)
      const target = rest.indexOf(row.name) + (below(ev) ? 1 : 0)
      move(name, target)
    })
    return el
  }

  function paint(): void {
    list.replaceChildren(...names.map((name, at) => rowOf(byName.get(name)!, at)))
  }
  paint()
  return card(
    voice ? 'Voice channels' : 'Text channels',
    note('Drag one to put it in another place, or use the arrows. Everybody sees this order.'),
    list,
    h('div', { class: 'row' }, [
      h('button', { class: 'small', on: { click: () => void actions.create(voice) } }, [
        icon('plus', 14),
        voice ? 'Create voice channel' : 'Create text channel',
      ]),
    ]),
  )
}

/** Every sound and group on the soundboard, to play, rename, sort into groups, or take off. */
function soundboardPage(board: SoundboardActions): HTMLElement {
  const groups = board.groups()
  const sounds = board.sounds()
  const known = new Set(groups.map((g) => g.id))

  const soundRow = (sound: ReturnType<SoundboardActions['sounds']>[number]): HTMLElement => {
    const place = h('select', { class: 'board-row-group', ariaLabel: `Group of ${sound.label}` }, [
      h('option', { value: '', text: 'No group' }),
      ...groups.map((g) => h('option', { value: g.id, text: `${g.emoji} ${g.label}` })),
    ])
    place.value = known.has(sound.group) ? sound.group : ''
    place.addEventListener('change', () => void board.move(sound.id, place.value))
    return h('div', { class: 'action-row board-row' }, [
      h('button', {
        class: 'ghost icon-only board-row-play',
        title: 'Hear it, only you',
        ariaLabel: `Hear ${sound.label}`,
        on: { click: () => board.play(sound.id) },
      }, [h('span', { class: 'board-row-emoji', text: sound.emoji })]),
      h('span', { class: 'switch-words' }, [
        h('span', { class: 'switch-label truncate', text: sound.label }),
        h('span', { class: 'tiny faint switch-about', text: `Added by ${sound.by}` }),
      ]),
      groups.length ? place : null,
      sound.mayChange
        ? h('button', { class: 'ghost small', title: 'Change the name or emoji', ariaLabel: `Change ${sound.label}`, on: { click: () => void board.edit(sound.id) } }, [
            icon('edit', 14),
          ])
        : null,
      sound.mayChange
        ? h('button', { class: 'ghost small danger', title: 'Take it off', ariaLabel: `Take ${sound.label} off`, on: { click: () => void board.remove(sound.id) } }, [
            icon('trash', 14),
          ])
        : null,
    ])
  }

  const section = (title: string, tools: HTMLElement[], inIt: typeof sounds, group: string): HTMLElement =>
    card(
      title,
      inIt.length ? h('div', { class: 'action-list' }, inIt.map(soundRow)) : note(group ? 'No sounds in this group yet.' : groups.length ? 'No sounds outside a group.' : 'No sounds yet.'),
      h('div', { class: 'row board-card-foot' }, [
        h('button', { class: 'small', on: { click: () => void board.add(group) } }, [icon('plus', 14), 'Add a sound']),
        h('span', { class: 'grow' }),
        ...tools,
      ]),
    )

  const page = h('div', { class: 'stack settings-stack' }, [
    card(
      'Soundboard',
      note(
        'Sounds play for the people in your voice channel. Anybody whose level has the soundboard may add a sound or a group, and sort the sounds. Whoever added one, or a channel keeper, may rename it or take it off.',
      ),
      h('div', { class: 'row board-card-foot' }, [
        h('button', { class: 'small', on: { click: () => void board.addGroup() } }, [icon('plus', 14), 'New group']),
      ]),
    ),
    card('Volume', note('How loud the soundboard is for you, on this device. Nobody else hears the change.'), volumeRow()),
  ])
  for (const group of groups) {
    const tools = group.mayChange
      ? [
          h('button', { class: 'ghost small', ariaLabel: `Change the group ${group.label}`, on: { click: () => void board.editGroup(group.id) } }, [
            icon('edit', 14),
            'Rename',
          ]),
          h('button', { class: 'ghost small danger', ariaLabel: `Take the group ${group.label} off`, on: { click: () => void board.removeGroup(group.id) } }, [
            icon('trash', 14),
            'Take the group off',
          ]),
        ]
      : []
    page.append(section(`${group.emoji} ${group.label}`, tools, sounds.filter((b) => b.group === group.id), group.id))
  }
  page.append(section(groups.length ? 'No group' : 'Sounds', [], sounds.filter((b) => !known.has(b.group)), ''))
  return page
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
              text: row.stopped ? `Stopped · # ${row.channel}` : `Posts in # ${row.channel}`,
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
                ? 'Somebody was removed, so a webhook stopped. Make a new link for it.'
                : `Somebody was removed, so ${stopped} webhooks stopped. Make a new link for each.`,
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
      h('ul', { class: 'hook-rules' }, [
        h('li', { text: 'Keep webhook links secret. Anybody with a link can post in its channel.' }),
        h('li', { text: 'Webhooks are part of the space’s encryption. When you remove or ban somebody, every webhook stops. Make a new link, and put it where you used the old one.' }),
      ]),
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
  if (actions.can.channels) {
    tabs.push({
      id: 'channels',
      label: 'Channels',
      icon: 'hash',
      group,
      build: () =>
        h('div', { class: 'stack settings-stack' }, [
          channelList(actions.channels, false),
          channelList(actions.channels, true),
        ]),
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
  if (actions.can.soundboard) {
    tabs.push({
      id: 'soundboard',
      label: 'Soundboard',
      icon: 'music',
      build: () => soundboardPage(actions.board),
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
