import { h } from './dom'
import { openEmojiPicker } from './emoji'
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
    const rows = pickRows(choices, picked)
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

/**
 * Asks before something that cannot be undone, as window.confirm does, in Nook's own dialog.
 * Cancel is on the left, and has the focus, so Enter does no harm.
 */
export function confirmDanger(title: string, about: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    const was = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const finish = (answer: boolean): void => {
      scrim.remove()
      window.removeEventListener('keydown', onKey, true)
      was?.focus()
      resolve(answer)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      finish(false)
    }
    const cancel = h('button', { class: 'ghost', text: 'Cancel', on: { click: () => finish(false) } })
    const scrim = h('div', { class: 'scrim', on: { click: (ev) => ev.target === scrim && finish(false) } }, [
      h('div', { class: 'modal ask-modal confirm-modal', role: 'alertdialog', ariaLabel: title }, [
        h('div', { class: 'invite-head' }, [
          h('div', { class: 'invite-words' }, [h('div', { class: 'invite-title', text: title }), h('div', { class: 'small faint', text: about })]),
          h('button', { class: 'ghost icon-only', ariaLabel: 'Close', on: { click: () => finish(false) } }, [icon('close', 18)]),
        ]),
        h('div', { class: 'row ask-buttons' }, [cancel, h('button', { class: 'danger confirm-ok', text: ok, on: { click: () => finish(true) } })]),
      ]),
    ])
    window.addEventListener('keydown', onKey, true)
    document.body.append(scrim)
    cancel.focus()
  })
}

function pickRows(choices: Choice[], picked: Set<string>): HTMLElement[] {
  return choices.map((choice) => {
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
}

/** A name for a new channel, and the levels it is kept to: none is everybody. */
export function askChannel(voice: boolean, choices: Choice[]): Promise<{ name: string; levels: string[] } | null> {
  return new Promise((resolve) => {
    const was = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const question = voice ? 'Create voice channel' : 'Name the channel'
    const picked = new Set<string>()
    const input = h('input', { type: 'text', class: 'ask-input', ariaLabel: question, placeholder: voice ? 'lounge' : 'general' })
    input.autocomplete = 'off'
    const done = (): void => finish({ name: input.value, levels: choices.map((c) => c.id).filter((id) => picked.has(id)) })
    const finish = (answer: { name: string; levels: string[] } | null): void => {
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
        done()
      }
    }
    const scrim = h('div', { class: 'scrim', on: { click: (ev) => ev.target === scrim && finish(null) } }, [
      h('div', { class: 'modal ask-modal', role: 'dialog', ariaLabel: question }, [
        h('div', { class: 'invite-head' }, [
          h('div', { class: 'invite-words' }, [h('div', { class: 'invite-title', text: question })]),
          h('button', { class: 'ghost icon-only', ariaLabel: 'Close', on: { click: () => finish(null) } }, [icon('close', 18)]),
        ]),
        input,
        choices.length
          ? h('div', { class: 'stack tight' }, [
              h('div', { class: 'eyebrow', text: voice ? 'Who can see and join it' : 'Who can see it' }),
              h('div', { class: 'tiny faint', text: 'Tick nobody for everybody. The owner, and whoever can change channels, always get in.' }),
              h('div', { class: 'pick-list' }, pickRows(choices, picked)),
            ])
          : null,
        h('div', { class: 'row ask-buttons' }, [
          h('button', { class: 'ghost', text: 'Cancel', on: { click: () => finish(null) } }),
          h('button', { class: 'primary', text: voice ? 'Create channel' : 'Make', on: { click: done } }),
        ]),
      ]),
    ])
    window.addEventListener('keydown', onKey, true)
    document.body.append(scrim)
    input.focus()
  })
}

/** A sound's name and its emoji. Null when it is closed or cancelled. */
export function askSound(title: string, name: string, emoji: string, ok: string): Promise<{ name: string; emoji: string } | null> {
  return new Promise((resolve) => {
    const was = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let chosen = emoji
    const input = h('input', { type: 'text', class: 'ask-input grow', ariaLabel: 'The sound\'s name', value: name, placeholder: 'Its name' })
    input.autocomplete = 'off'
    const face = h('button', { class: 'sound-face', ariaLabel: 'Its emoji', title: 'Pick its emoji', text: chosen })
    face.addEventListener('click', () =>
      openEmojiPicker({
        anchor: face,
        title: 'The sound\'s emoji',
        onPick: (picked) => {
          chosen = picked
          face.textContent = picked
          input.focus()
        },
      }),
    )
    const done = (): void => finish({ name: input.value, emoji: chosen })
    const finish = (answer: { name: string; emoji: string } | null): void => {
      if (document.querySelector('.emoji-pop')) return
      scrim.remove()
      window.removeEventListener('keydown', onKey, true)
      was?.focus()
      resolve(answer)
    }
    const onKey = (ev: KeyboardEvent): void => {
      // The emoji picker takes its own Escape and Enter while it is open.
      if (document.querySelector('.emoji-pop')) return
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        finish(null)
      } else if (ev.key === 'Enter' && !ev.isComposing && document.activeElement === input) {
        ev.preventDefault()
        done()
      }
    }
    const scrim = h('div', { class: 'scrim', on: { click: (ev) => ev.target === scrim && finish(null) } }, [
      h('div', { class: 'modal ask-modal', role: 'dialog', ariaLabel: title }, [
        h('div', { class: 'invite-head' }, [
          h('div', { class: 'invite-words' }, [h('div', { class: 'invite-title', text: title })]),
          h('button', { class: 'ghost icon-only', ariaLabel: 'Close', on: { click: () => finish(null) } }, [icon('close', 18)]),
        ]),
        h('div', { class: 'row sound-fields' }, [face, input]),
        h('div', { class: 'row ask-buttons' }, [
          h('button', { class: 'ghost', text: 'Cancel', on: { click: () => finish(null) } }),
          h('button', { class: 'primary', text: ok, on: { click: done } }),
        ]),
      ]),
    ])
    window.addEventListener('keydown', onKey, true)
    document.body.append(scrim)
    input.focus()
    input.select()
  })
}
