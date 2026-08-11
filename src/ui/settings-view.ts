/**
 * Settings.
 *
 * Your name lives here rather than under the chat box, because a name is
 * something you set once and forget, not a control you need beside every
 * message.
 *
 * Your ID lives here too, and it is the more important of the two. The name is
 * a label; the ID is who you are. Everything in the log is signed by and
 * attributed to the ID, so changing your name renames you everywhere, in old
 * messages as well as new ones, and nobody else can take your name by typing it.
 */

import { cleanName } from '../chat'
import { loadIdentity, saveDisplayName } from '../store/identity'
import { copyText, h } from './dom'
import { icon } from './icons'
import { applyTheme, loadTheme, THEMES } from './themes'
import { toast } from './toast'

export interface SettingsActions {
  rename(name: string): void
  back(): void
}

export function settingsView(actions: SettingsActions): HTMLElement {
  const identity = loadIdentity()

  const name = h('input', {
    type: 'text',
    value: identity.name,
    ariaLabel: 'Your name',
    placeholder: 'Your name',
  })
  const save = h('button', { class: 'primary', text: 'Save name' })
  const commit = (): void => {
    const next = cleanName(name.value)
    if (!next) {
      name.value = identity.name
      return
    }
    saveDisplayName(next)
    actions.rename(next)
    toast('Name changed. It updates everywhere, including old messages.', 'info', 5000)
  }
  save.addEventListener('click', commit)
  name.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') commit()
  })

  const idBox = h('div', { class: 'share-code', text: identity.pubkey.slice(0, 16), title: identity.pubkey })
  const copyId = h('button', { class: 'grow' }, [icon('copy', 14), 'Copy full ID'])
  copyId.addEventListener('click', async () => {
    const ok = await copyText(identity.pubkey)
    toast(ok ? 'ID copied.' : 'Could not copy the ID.', ok ? 'info' : 'warn')
  })

  const theme = h('select', { ariaLabel: 'Theme', on: { change: () => applyTheme(theme.value) } })
  for (const t of THEMES) theme.append(h('option', { value: t.id, text: t.name, title: t.note }))
  theme.value = loadTheme()

  return h('main', {}, [
    h('div', { class: 'center-page' }, [
      h('div', { class: 'sheet stack' }, [
        h('div', { class: 'row spread' }, [
          h('span', { class: 'eyebrow', text: 'Settings' }),
          h('button', { text: 'Back', on: { click: actions.back } }),
        ]),

        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Your name' }),
          h('div', { class: 'row' }, [name, save]),
          h('div', {
            class: 'tiny faint',
            text: 'A label, not an identity. Change it whenever you like: it updates everywhere, in old messages too.',
          }),
        ]),

        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Your ID' }),
          idBox,
          h('div', { class: 'row' }, [copyId]),
          h('div', {
            class: 'tiny faint',
            text: 'This is who you are. Every message you write is signed with it, so nobody can take your name by typing it, and two people called the same thing are still two people. It never leaves this device.',
          }),
        ]),

        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Look' }),
          theme,
          h('div', { class: 'tiny faint', text: 'Kept in this browser.' }),
        ]),
      ]),
    ]),
  ])
}
