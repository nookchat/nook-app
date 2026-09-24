/**
 * The shell.
 *
 * The app fills the window, and a screen fills the app. Going from one space
 * to another is the switcher behind the name at the top of each screen (see
 * space-switcher.ts), so no column is spent on it. The line saying what is happening (where you are, how many people
 * are here, what it is connected to) is handed to the screen, which puts it
 * where it belongs: in a space, under your own name.
 *
 * There was more of it once. A desktop with a wallpaper, a window floating on
 * it with a frame and a title bar, and three caption buttons, two of which
 * repeated what the browser already does. A strip of furniture that repeats the
 * furniture above it is wasted height, and on a phone it was a tenth of the
 * screen.
 */

import { checkSupport, supportRows } from '../diagnostics'
import type { RoomNote } from '../store/notes'
import { fmtBytes, fmtDuration, h } from './dom'

/** The ways between screens, which every screen's switcher offers. */
export interface Navigation {
  home(): void
  /** Make or join one: home, with the name field ready. */
  add(): void
  open(room: RoomNote): void
}

export interface SessionSummary {
  seconds: number
  peakViewers: number
  bytesSent: number
}

export interface WindowActions {
  /** Minimise: hide the controls and give the whole window to the picture. */
  minimise?: () => void
  /** Maximise: take the picture fullscreen. */
  maximise?: () => void
  /** Close: end what is running and go back to the picker. */
  close?: () => void
}

export interface WindowChrome {
  readonly root: HTMLElement
  /** Where a screen mounts itself. */
  readonly body: HTMLElement
  /** The ways to the other screens. */
  readonly nav: Navigation
  /** The status line. Not on the page until a screen puts it somewhere. */
  readonly status: HTMLElement
  setTitle(text: string): void
  setStatus(panels: (HTMLElement | string)[]): void
  setActions(actions: WindowActions): void
}

export function createWindow(title: string, nav: Navigation): WindowChrome {
  // setTitle still means something: it names the browser tab.
  document.title = title

  const body = h('div', { class: 'app-body' })
  const status = h('div', { class: 'status-bar' })
  const root = h('div', { class: 'app-shell' }, [body])

  const setStatus = (panels: (HTMLElement | string)[]): void => {
    status.replaceChildren()
    panels.forEach((panel, i) => {
      const cell = h('div', { class: `status-cell${i === 0 ? ' grow' : ''}` })
      cell.append(typeof panel === 'string' ? panel : panel)
      status.append(cell)
    })
  }

  setStatus(['Ready'])

  return {
    root,
    body,
    nav,
    status,
    setTitle: (text) => {
      document.title = text
    },
    setStatus,
    /*
     * Kept as a no-op rather than deleted. The screens still say what they can
     * do, and something later may want somewhere to put it; taking the method
     * away would only mean editing every caller to say nothing instead.
     */
    setActions: () => undefined,
  }
}

/** Browser support and the short version of how Nook works, behind a disclosure. */
export function aboutCard(): HTMLElement {
  const support = checkSupport()
  return h('details', { class: 'adv' }, [
    h('summary', { text: 'Browser check' }),
    h('div', { class: 'card stack tight' }, [
      h(
        'div',
        { class: 'stack tight' },
        supportRows(support).map((r) =>
          h('div', { class: 'row spread' }, [
            h('span', { class: 'small', text: r.label }),
            h('span', { class: `pill ${r.ok ? 'good' : 'warn'}`, text: r.note }),
          ]),
        ),
      ),
      h('hr'),
      h('ul', { class: 'support-list' }, [
        h('li', {
          text: 'A space lives on a Nook server. Everything is encrypted with the key in your link before it leaves this browser, so the server cannot read it.',
        }),
        h('li', { text: 'That key sits after the # in the link, so the webserver never receives it.' }),
        h('li', {
          text: 'Your screen goes out once per viewer, so your upload speed sets the viewer limit.',
        }),
        h('li', {
          text: 'Calls and screen shares go through the server, encrypted between the browsers in the call.',
        }),
      ]),
    ]),
  ])
}

export function summaryCard(s: SessionSummary): HTMLElement {
  return h('div', { class: 'card summary-card stack tight' }, [
    h('div', { class: 'row spread' }, [
      h('span', { class: 'eyebrow', text: 'Last stream' }),
      h('span', { class: 'pill', text: 'ended' }),
    ]),
    h('div', { class: 'row wrap', style: { gap: '4px' } }, [
      h('span', { class: 'pill', text: fmtDuration(s.seconds * 1000) }),
      h('span', {
        class: 'pill',
        text: `${s.peakViewers} viewer${s.peakViewers === 1 ? '' : 's'} at the peak`,
      }),
      h('span', { class: 'pill', text: `${fmtBytes(s.bytesSent)} sent` }),
    ]),
    h('div', { class: 'tiny faint', text: 'No copy of the picture or the sound was kept.' }),
  ])
}
