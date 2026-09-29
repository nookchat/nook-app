import { avatarOf } from './chat-panel'
import { clear, h } from './dom'
import { actionRow, card, note, settingsShell, type SettingsTab } from './settings-shell'
import { icon } from './icons'
import { spaceFace } from './space-switcher'

export interface SpaceSettingsActions {
  id: string
  name: string
  picture: string
  /** What your level lets you change here. */
  can: { space: boolean; levels: boolean; remove: boolean }
  rename(): Promise<void>
  /** null takes the picture away. */
  setPicture(file: File | null): Promise<void>
  reset(): Promise<void>
  remove(): Promise<void>
  removed: { key: string; name: string; restore(): void }[]
  /** Everybody in the space, as it is now. */
  members(): MemberRow[]
  setLevel(key: string, level: string): Promise<void>
  /** Asks first. */
  kick(key: string): Promise<void>
  levels(): HTMLElement
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
      build: () => {
        const list = h('div', { class: 'action-list' })
        for (const p of actions.removed) {
          const row = h('div', { class: 'action-row' }, [
            h('span', { class: 'switch-label truncate', text: p.name }),
            h('button', {
              class: 'small',
              text: 'Unban',
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
          card('Removed people', actions.removed.length ? list : note('Nobody is removed from this space.')),
        ])
      },
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
  if (tabs[0]) tabs[0].group = group
  return tabs
}

export function spaceSettingsView(actions: SpaceSettingsActions): HTMLElement {
  return settingsShell({ title: 'Space settings', tabs: spaceTabs(actions), start: actions.start, close: actions.back })
}
