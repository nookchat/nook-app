import { CHANGELOG, type ChangelogEntry } from '../changelog'
import { h } from './dom'
import { ghost } from './ghost'
import { icon } from './icons'

/** The newest entry this device has shown, so each one shows once. */
const SEEN_KEY = 'nook.changelog-seen.v1'
/** At most this many entries at once, after a long time away: the rest are in Settings, About. */
const MOST_AT_ONCE = 3
/** A moment after the start, so the window comes over the app and not over its loading. */
const SETTLE_MS = 1500

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' })

function seen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    return null
  }
}

function markSeen(): void {
  try {
    if (CHANGELOG[0]) localStorage.setItem(SEEN_KEY, CHANGELOG[0].id)
  } catch {
    /* storage blocked: it shows again next time, which does no harm */
  }
}

/** The entries since this device last showed one. Somebody from before there was a changelog sees the newest. */
function unseen(): ChangelogEntry[] {
  const last = seen()
  return last === null ? CHANGELOG.slice(0, 1) : CHANGELOG.filter((entry) => entry.id > last)
}

/**
 * After an update, What's new shows what came with it, once, over the app. Somebody new, who
 * signed up just now, has nothing new to see: everything is new.
 */
export function whatsNewAfterStart(fresh: boolean): void {
  if (fresh) {
    markSeen()
    return
  }
  const entries = unseen()
  if (entries.length === 0) return
  const tryShow = (): void => {
    // Not over the loading screen, another window, or a page nobody looks at.
    if (document.hidden || document.querySelector('#boot, .scrim')) {
      window.setTimeout(tryShow, SETTLE_MS)
      return
    }
    markSeen()
    showWhatsNew(entries.slice(0, MOST_AT_ONCE), 'Since you were last here', entries.length > MOST_AT_ONCE)
  }
  window.setTimeout(tryShow, SETTLE_MS)
}

/** Every entry there is, from Settings, About. */
export function showAllChanges(): void {
  markSeen()
  showWhatsNew(CHANGELOG, 'Every update, the newest first', false)
}

function dayOf(id: string): string {
  const [year, month, day] = id.split('-').map(Number)
  return DAY.format(new Date(year, month - 1, day))
}

function showWhatsNew(entries: ChangelogEntry[], about: string, more: boolean): void {
  if (entries.length === 0) return
  document.querySelector('.whats-new-scrim')?.remove()
  const close = (): void => {
    scrim.remove()
    window.removeEventListener('keydown', onKey, true)
  }
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    ev.stopPropagation()
    close()
  }
  const done = h('button', { class: 'primary', text: 'Got it', on: { click: close } })
  const list = h(
    'div',
    { class: 'whats-new-list' },
    entries.map((entry) =>
      h('section', { class: 'whats-new-entry' }, [
        h('div', { class: 'whats-new-day', text: dayOf(entry.id) }),
        h('h3', { class: 'whats-new-title', text: entry.title }),
        h('ul', { class: 'whats-new-items' }, entry.items.map((item) => h('li', { text: item }))),
      ]),
    ),
  )
  const scrim = h('div', { class: 'scrim whats-new-scrim', on: { click: (ev) => ev.target === scrim && close() } }, [
    h('div', { class: 'modal whats-new', role: 'dialog', ariaLabel: 'What’s new in Nook' }, [
      h('div', { class: 'whats-new-head' }, [
        ghost({ entrance: 'peek', size: 36 }),
        h('div', { class: 'whats-new-words' }, [
          h('div', { class: 'whats-new-heading', text: 'What’s new in Nook' }),
          h('div', { class: 'tiny faint', text: about }),
        ]),
        h('button', { class: 'ghost icon-only', ariaLabel: 'Close', on: { click: close } }, [icon('close', 18)]),
      ]),
      list,
      h('div', { class: 'whats-new-foot' }, [
        more ? h('span', { class: 'tiny faint', text: 'More in Settings, About.' }) : h('span'),
        done,
      ]),
    ]),
  ])
  window.addEventListener('keydown', onKey, true)
  document.body.append(scrim)
  // Ready for Enter, with no ring until the keys are used.
  done.focus({ focusVisible: false } as FocusOptions)
}
