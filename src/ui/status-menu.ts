import { loadStatus, MAX_STATUS_TEXT, presenceLook, PRESENCES, saveStatus } from '../store/status'
import { ask } from './ask'
import { h } from './dom'
import { openMenu, type MenuEntry } from './menu'

/** The dot for your own status, over your face at the foot of the channels. */
export function myStatusDot(): HTMLElement {
  const { mode } = loadStatus()
  const look = presenceLook(mode, false)
  return h('i', { class: `dot ${look.dot}`, title: look.words })
}

/** Online, idle, do not disturb or invisible, and a few words of your own. */
export function openStatusMenu(anchor: HTMLElement): void {
  const now = loadStatus()
  const items: MenuEntry[] = [{ heading: 'Your status' }]
  for (const p of PRESENCES) {
    items.push({
      label: p.label,
      note: p.about || undefined,
      current: now.mode === p.id,
      lead: h('span', { class: 'menu-icon' }, [h('i', { class: `dot status-dot ${presenceLook(p.id, false).dot}` })]),
      run: () => saveStatus({ mode: p.id }),
    })
  }
  items.push('line')
  items.push({
    label: now.text ? 'Change your status words' : 'Say what you are up to',
    note: now.text || undefined,
    run: async () => {
      const said = await ask('What are you up to?', {
        value: now.text,
        placeholder: 'Out for lunch',
        ok: 'Save',
      })
      if (said === null) return
      saveStatus({ text: said.slice(0, MAX_STATUS_TEXT) })
    },
  })
  if (now.text) items.push({ label: 'Clear your status words', run: () => saveStatus({ text: '' }) })
  openMenu(anchor, items)
}
