import { h } from './dom'
import { icon } from './icons'

const MAC = /Mac|iPhone|iPad/.test(navigator.platform)

/** The keys, with Mod as Cmd on a Mac and Ctrl everywhere else. */
const LIST: { keys: string[]; does: string }[] = [
  { keys: ['Mod', 'K'], does: 'Search this space' },
  { keys: ['Mod', '1–9'], does: 'Open a text channel by its place' },
  { keys: ['Alt', '↑'], does: 'Open the text channel above' },
  { keys: ['Alt', '↓'], does: 'Open the text channel below' },
  { keys: ['Mod', 'Shift', 'M'], does: 'Mute or unmute your microphone' },
  { keys: ['Mod', 'Shift', 'D'], does: 'Deafen or undeafen' },
  { keys: ['Mod', 'Shift', 'S'], does: 'Share your screen, or stop' },
  { keys: ['↑'], does: 'Edit your last message, from an empty message box' },
  { keys: ['Esc'], does: 'Stop an edit or a reply, or close a screen' },
  { keys: ['Mod', '/'], does: 'Show these shortcuts' },
]

function keyName(key: string): string {
  if (key === 'Mod') return MAC ? '⌘' : 'Ctrl'
  if (key === 'Shift') return MAC ? '⇧' : 'Shift'
  if (key === 'Alt') return MAC ? '⌥' : 'Alt'
  return key
}

let shown: (() => void) | null = null

export function showShortcuts(): void {
  if (shown) {
    shown()
    return
  }
  const was = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const close = (): void => {
    shown = null
    scrim.remove()
    window.removeEventListener('keydown', onKey, true)
    was?.focus()
  }
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    ev.stopPropagation()
    close()
  }
  const rows = LIST.map((one) =>
    h('div', { class: 'shortcut-row' }, [
      h('span', { class: 'shortcut-does', text: one.does }),
      h(
        'span',
        { class: 'shortcut-keys' },
        one.keys.map((key) => h('kbd', { text: keyName(key) })),
      ),
    ]),
  )
  const closeButton = h('button', { class: 'ghost icon-only', ariaLabel: 'Close', on: { click: close } }, [icon('close', 18)])
  const sheet = h('div', { class: 'modal shortcuts-modal', role: 'dialog', ariaLabel: 'Keyboard shortcuts', tabIndex: -1 }, [
    h('div', { class: 'invite-head' }, [
      h('div', { class: 'invite-words' }, [h('div', { class: 'invite-title', text: 'Keyboard shortcuts' })]),
      closeButton,
    ]),
    h('div', { class: 'shortcut-list' }, rows),
  ])
  const scrim = h('div', { class: 'scrim', on: { click: (ev) => ev.target === scrim && close() } }, [sheet])
  shown = close
  window.addEventListener('keydown', onKey, true)
  document.body.append(scrim)
  sheet.focus()
}
