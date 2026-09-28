import { clear, h } from './dom'
import { icon, type IconName } from './icons'

export interface SettingsTab {
  id: string
  label: string
  icon: IconName
  /** A heading over this tab and the ones after it in the list. */
  group?: string
  /** Built each time the tab opens, so it shows what is true now. */
  build(): HTMLElement
}

interface ShellOptions {
  title: string
  tabs: SettingsTab[]
  start?: string
  /** Under the tabs, such as Leave space. */
  foot?: HTMLElement | null
  close(): void
}

/** Settings as Discord lays them out: the tabs on the left, one page at a time on the right. */
export function settingsShell(options: ShellOptions): HTMLElement {
  const nav = h('nav', { class: 'settings-nav', ariaLabel: `${options.title} tabs` })
  const page = h('div', { class: 'settings-page' })
  const heading = h('h1', { class: 'settings-title grow' })
  const buttons = new Map<string, HTMLButtonElement>()

  const onEscape = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || ev.defaultPrevented) return
    if (document.querySelector('.scrim, .menu, .emoji-picker, .emoji-pop, .viewer, .gif-pop')) return
    close()
  }
  const close = (): void => {
    window.removeEventListener('keydown', onEscape, true)
    options.close()
  }
  window.addEventListener('keydown', onEscape, true)

  const show = (id: string): void => {
    const tab = options.tabs.find((t) => t.id === id) ?? options.tabs[0]
    if (!tab) return
    for (const [key, button] of buttons) {
      button.classList.toggle('on', key === tab.id)
      button.setAttribute('aria-current', key === tab.id ? 'page' : 'false')
    }
    heading.textContent = tab.label
    clear(page)
    page.append(tab.build())
    page.scrollTop = 0
  }

  nav.append(h('div', { class: 'settings-nav-title', text: options.title }))
  for (const tab of options.tabs) {
    if (tab.group) nav.append(h('div', { class: 'settings-nav-group', text: tab.group }))
    const button = h('button', { class: 'settings-tab', on: { click: () => show(tab.id) } }, [
      icon(tab.icon, 17),
      h('span', { class: 'truncate', text: tab.label }),
    ])
    button.dataset.tab = tab.id
    buttons.set(tab.id, button)
    nav.append(button)
  }
  if (options.foot) nav.append(h('div', { class: 'settings-nav-foot' }, [options.foot]))

  const root = h('main', { class: 'settings' }, [
    h('div', { class: 'settings-frame' }, [
      nav,
      h('section', { class: 'settings-main' }, [
        h('div', { class: 'row settings-head' }, [
          heading,
          h(
            'button',
            { class: 'ghost icon-only settings-close', ariaLabel: 'Close settings', title: 'Close (Esc)', on: { click: close } },
            [icon('close', 20)],
          ),
        ]),
        page,
      ]),
    ]),
  ])

  show(options.start ?? options.tabs[0]?.id ?? '')
  return root
}

export const card = (title: string, ...children: (Node | null)[]): HTMLElement =>
  h('section', { class: 'settings-section stack tight' }, [h('span', { class: 'eyebrow', text: title }), ...children])

export const note = (text: string): HTMLElement => h('div', { class: 'tiny faint', text })

export function actionRow(label: string, about: string, button: HTMLButtonElement): HTMLElement {
  return h('div', { class: 'action-row' }, [
    h('span', { class: 'switch-words' }, [
      h('span', { class: 'switch-label', text: label }),
      h('span', { class: 'tiny faint switch-about', text: about }),
    ]),
    button,
  ])
}

export function switchRow(label: string, about = ''): HTMLButtonElement {
  return h('button', { class: 'switch-row', role: 'switch' }, [
    h('span', { class: 'switch-words' }, [
      h('span', { class: 'switch-label', text: label }),
      about ? h('span', { class: 'tiny faint switch-about', text: about }) : null,
    ]),
    h('span', { class: 'switch' }, [h('i')]),
  ])
}

export function toggle(label: string, on: () => boolean, set: (next: boolean) => void, about = ''): HTMLButtonElement {
  const button = switchRow(label, about)
  const paint = (): void => button.setAttribute('aria-checked', String(on()))
  button.addEventListener('click', () => {
    set(!on())
    paint()
  })
  paint()
  return button
}
