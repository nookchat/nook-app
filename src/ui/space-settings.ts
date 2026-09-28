import { h } from './dom'
import { actionRow, card, note, settingsShell, type SettingsTab } from './settings-shell'
import { icon } from './icons'
import { spaceFace } from './space-switcher'

export interface SpaceSettingsActions {
  id: string
  name: string
  /** What your level lets you change here. */
  can: { space: boolean; levels: boolean; remove: boolean }
  rename(): Promise<void>
  reset(): Promise<void>
  remove(): Promise<void>
  removed: { key: string; name: string; restore(): void }[]
  levels(): HTMLElement
  start?: string
  back(): void
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
      build: () =>
        h('div', { class: 'stack settings-stack' }, [
          card(
            'Name',
            h('div', { class: 'space-card-head' }, [
              spaceFace(actions.id, actions.name, 44),
              h('div', { class: 'space-card-words' }, [
                h('span', { class: 'space-card-name truncate', text: actions.name }),
                note('Everybody in the space sees this name.'),
              ]),
              h('button', { class: 'small', on: { click: () => void actions.rename() } }, [icon('edit', 14), 'Rename']),
            ]),
          ),
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
