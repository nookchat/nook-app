import { clear, h } from './dom'
import { card, note } from './settings-shell'

const KEY = 'nook.keys.v1'
const MAC = /Mac|iPhone|iPad/.test(navigator.platform)

export type Action = 'search' | 'channel-up' | 'channel-down' | 'mute' | 'deafen' | 'share' | 'leave'

/** Keys are written as "Mod+Shift+M", with Mod as Cmd on a Mac and Ctrl everywhere else. */
const ACTIONS: { id: Action; does: string; keys: string }[] = [
  { id: 'search', does: 'Search this space', keys: 'Mod+K' },
  { id: 'channel-up', does: 'Open the text channel above', keys: 'Alt+ArrowUp' },
  { id: 'channel-down', does: 'Open the text channel below', keys: 'Alt+ArrowDown' },
  { id: 'mute', does: 'Mute or unmute your microphone', keys: 'Mod+Shift+M' },
  { id: 'deafen', does: 'Deafen or undeafen', keys: 'Mod+Shift+D' },
  { id: 'share', does: 'Share your screen, or stop', keys: 'Mod+Shift+S' },
  { id: 'leave', does: 'Leave the voice channel', keys: '' },
]

/** These stay as they are. */
const FIXED: { does: string; keys: string }[] = [
  { does: 'Open a text channel by its place', keys: 'Mod+1–9' },
  { does: 'Edit your last message, from an empty message box', keys: 'ArrowUp' },
  { does: 'Stop an edit or a reply, or close a screen', keys: 'Escape' },
]

/** Only the ones you changed. An empty string is a shortcut you turned off. */
function changed(): Partial<Record<Action, string>> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Partial<Record<Action, string>>) : {}
  } catch {
    return {}
  }
}

function save(next: Partial<Record<Action, string>>): void {
  try {
    if (Object.keys(next).length) localStorage.setItem(KEY, JSON.stringify(next))
    else localStorage.removeItem(KEY)
  } catch {}
}

function keysFor(id: Action): string {
  return changed()[id] ?? ACTIONS.find((a) => a.id === id)?.keys ?? ''
}

function setKeys(id: Action, keys: string): void {
  const next = changed()
  // One set of keys does one thing: whatever had these keys loses them.
  if (keys) for (const other of ACTIONS) if (other.id !== id && keysFor(other.id) === keys) next[other.id] = ''
  const plain = ACTIONS.find((a) => a.id === id)?.keys ?? ''
  if (keys === plain) delete next[id]
  else next[id] = keys
  for (const other of ACTIONS) if (next[other.id] === other.keys) delete next[other.id]
  save(next)
}

const CODES: Record<string, string> = {
  Slash: '/',
  Backslash: '\\',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
}

/** The key without what Shift or Option does to it, so Option M is M and not µ. */
function baseKey(ev: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(ev.code)) return ev.code.slice(3)
  if (/^Digit[0-9]$/.test(ev.code)) return ev.code.slice(5)
  return CODES[ev.code] ?? (ev.key.length === 1 ? ev.key.toUpperCase() : ev.key)
}

function comboOf(ev: KeyboardEvent): string {
  const key = baseKey(ev)
  if (['Meta', 'Control', 'Alt', 'Shift', 'OS'].includes(key)) return ''
  const parts: string[] = []
  if (MAC ? ev.metaKey : ev.ctrlKey) parts.push('Mod')
  if (MAC && ev.ctrlKey) parts.push('Ctrl')
  if (ev.altKey) parts.push('Alt')
  if (ev.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/** The action these keys do, if they do one. */
export function actionFor(ev: KeyboardEvent): Action | null {
  if (recording) return null
  const combo = comboOf(ev)
  if (!combo) return null
  return ACTIONS.find((a) => keysFor(a.id) === combo)?.id ?? null
}

const NAMES: Record<string, [mac: string, other: string]> = {
  Mod: ['⌘', 'Ctrl'],
  Ctrl: ['⌃', 'Ctrl'],
  Alt: ['⌥', 'Alt'],
  Shift: ['⇧', 'Shift'],
  ArrowUp: ['↑', '↑'],
  ArrowDown: ['↓', '↓'],
  ArrowLeft: ['←', '←'],
  ArrowRight: ['→', '→'],
  Escape: ['Esc', 'Esc'],
  Enter: ['↵', 'Enter'],
  Backspace: ['⌫', 'Backspace'],
}

function drawKeys(keys: string): HTMLElement {
  if (!keys) return h('span', { class: 'shortcut-keys tiny faint', text: 'None' })
  return h(
    'span',
    { class: 'shortcut-keys' },
    keys.split('+').map((part) => h('kbd', { text: NAMES[part]?.[MAC ? 0 : 1] ?? part })),
  )
}

/** Set while a row waits for keys, so they do nothing else. */
let recording = false

/** The Keyboard tab in your settings: every shortcut, and new keys for most of them. */
export function shortcutSettings(): HTMLElement {
  const list = h('div', { class: 'shortcut-list' })
  let stopRecording: (() => void) | null = null

  const record = (id: Action, row: HTMLElement, button: HTMLButtonElement): void => {
    stopRecording?.()
    recording = true
    row.classList.add('recording')
    button.textContent = 'Press the keys'
    const onKey = (ev: KeyboardEvent): void => {
      ev.preventDefault()
      ev.stopPropagation()
      if (ev.key === 'Escape' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
        stop()
        return
      }
      const combo = comboOf(ev)
      if (!combo) return
      // A plain key would fire as you type, so a shortcut needs Cmd, Ctrl or Alt, or a function key.
      if (!/(^|\+)(Mod|Ctrl|Alt)\+/.test(combo) && !/^(Shift\+)?F\d{1,2}$/.test(combo)) {
        button.textContent = MAC ? 'Add ⌘, ⌃ or ⌥' : 'Add Ctrl or Alt'
        return
      }
      setKeys(id, combo)
      stop()
    }
    const onDown = (ev: PointerEvent): void => {
      if (ev.target !== button) stop()
    }
    const stop = (): void => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
      recording = false
      stopRecording = null
      draw()
    }
    stopRecording = stop
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
  }

  const draw = (): void => {
    clear(list)
    const mine = changed()
    for (const action of ACTIONS) {
      const keys = keysFor(action.id)
      const button = h('button', { class: 'ghost tiny-btn', text: 'Change' })
      const row = h('div', { class: 'shortcut-row' }, [
        h('span', { class: 'shortcut-does', text: action.does }),
        drawKeys(keys),
        h('span', { class: 'shortcut-tools' }, [
          button,
          keys
            ? h('button', {
                class: 'ghost tiny-btn',
                text: 'Clear',
                title: 'No keys for this',
                on: {
                  click: () => {
                    setKeys(action.id, '')
                    draw()
                  },
                },
              })
            : null,
          action.id in mine
            ? h('button', {
                class: 'ghost tiny-btn',
                text: 'Reset',
                title: `Back to ${action.keys || 'none'}`,
                on: {
                  click: () => {
                    const next = changed()
                    delete next[action.id]
                    save(next)
                    draw()
                  },
                },
              })
            : null,
        ]),
      ])
      button.addEventListener('click', () => record(action.id, row, button))
      list.append(row)
    }
  }
  draw()

  const fixed = h(
    'div',
    { class: 'shortcut-list' },
    FIXED.map((one) =>
      h('div', { class: 'shortcut-row' }, [h('span', { class: 'shortcut-does', text: one.does }), drawKeys(one.keys)]),
    ),
  )
  const resetAll = h('button', {
    class: 'ghost',
    text: 'Reset all',
    on: {
      click: () => {
        save({})
        draw()
      },
    },
  })

  return h('div', { class: 'stack settings-stack' }, [
    card('Shortcuts', note('Click Change, then press the new keys. Esc stops without a change.'), list, h('div', { class: 'row' }, [resetAll])),
    card('Fixed', fixed),
  ])
}
