import { h } from './dom'
import { icon } from './icons'

interface AskOptions {
  /** What is in the box at the start. */
  value?: string
  placeholder?: string
  password?: boolean
  /** The words on the button that says yes. */
  ok?: string
}

/**
 * Asks for one line of text, as window.prompt does. The desktop app's Electron has no
 * window.prompt, so every question goes through this. Null when it is closed or cancelled.
 */
export function ask(question: string, options: AskOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const was = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const input = h('input', {
      type: options.password ? 'password' : 'text',
      class: 'ask-input',
      ariaLabel: question,
      value: options.value ?? '',
      placeholder: options.placeholder ?? '',
    })
    input.autocomplete = 'off'
    const finish = (answer: string | null): void => {
      scrim.remove()
      window.removeEventListener('keydown', onKey, true)
      was?.focus()
      resolve(answer)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        finish(null)
      } else if (ev.key === 'Enter' && !ev.isComposing && document.activeElement === input) {
        ev.preventDefault()
        finish(input.value)
      }
    }
    const scrim = h('div', { class: 'scrim', on: { click: (ev) => ev.target === scrim && finish(null) } }, [
      h('div', { class: 'modal ask-modal', role: 'dialog', ariaLabel: question }, [
        h('div', { class: 'invite-head' }, [
          h('div', { class: 'invite-words' }, [h('div', { class: 'invite-title', text: question })]),
          h('button', { class: 'ghost icon-only', ariaLabel: 'Close', on: { click: () => finish(null) } }, [icon('close', 18)]),
        ]),
        input,
        h('div', { class: 'row ask-buttons' }, [
          h('button', { class: 'ghost', text: 'Cancel', on: { click: () => finish(null) } }),
          h('button', { class: 'primary', text: options.ok ?? 'OK', on: { click: () => finish(input.value) } }),
        ]),
      ]),
    ])
    window.addEventListener('keydown', onKey, true)
    document.body.append(scrim)
    input.focus()
    input.select()
  })
}

interface Choice {
  id: string
  name: string
  colour?: string
}

/** Ticks for some of `choices`. Null when it is closed or cancelled. */
export function pickSome(title: string, about: string, choices: Choice[], chosen: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    const was = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const picked = new Set(chosen)
    const finish = (answer: string[] | null): void => {
      scrim.remove()
      window.removeEventListener('keydown', onKey, true)
      was?.focus()
      resolve(answer)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      finish(null)
    }
    const rows = choices.map((choice) => {
      const box = h('input', { type: 'checkbox', ariaLabel: choice.name })
      box.checked = picked.has(choice.id)
      box.addEventListener('change', () => {
        if (box.checked) picked.add(choice.id)
        else picked.delete(choice.id)
      })
      const dot = h('i', { class: 'pick-dot' })
      if (choice.colour) dot.style.background = choice.colour
      return h('label', { class: 'pick-row' }, [box, dot, h('span', { class: 'truncate', text: choice.name })])
    })
    const save = h('button', { class: 'primary', text: 'Save', on: { click: () => finish(choices.map((c) => c.id).filter((id) => picked.has(id))) } })
    const scrim = h('div', { class: 'scrim', on: { click: (ev) => ev.target === scrim && finish(null) } }, [
      h('div', { class: 'modal ask-modal', role: 'dialog', ariaLabel: title }, [
        h('div', { class: 'invite-head' }, [
          h('div', { class: 'invite-words' }, [h('div', { class: 'invite-title', text: title }), h('div', { class: 'tiny faint', text: about })]),
          h('button', { class: 'ghost icon-only', ariaLabel: 'Close', on: { click: () => finish(null) } }, [icon('close', 18)]),
        ]),
        h('div', { class: 'pick-list' }, rows),
        h('div', { class: 'row ask-buttons' }, [h('button', { class: 'ghost', text: 'Cancel', on: { click: () => finish(null) } }), save]),
      ]),
    ])
    window.addEventListener('keydown', onKey, true)
    document.body.append(scrim)
    save.focus()
  })
}
