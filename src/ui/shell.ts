/**
 * The shell.
 *
 * The app fills the window, and along the bottom there is one line saying what
 * is happening: where you are, how many people are here, how many relays are
 * up. That is the whole chrome.
 *
 * There was more of it once. A desktop with a wallpaper, a window floating on
 * it with a frame and a title bar, and three caption buttons, two of which
 * repeated what the browser already does. A strip of furniture that repeats the
 * furniture above it is wasted height, and on a phone it was a tenth of the
 * screen.
 */

import { checkSupport, supportRows } from '../diagnostics'
import { fmtBytes, fmtDuration, h } from './dom'

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
  setTitle(text: string): void
  setStatus(panels: (HTMLElement | string)[]): void
  setActions(actions: WindowActions): void
}

export function createWindow(title: string): WindowChrome {
  // setTitle still means something: it names the browser tab.
  document.title = title

  const body = h('div', { class: 'app-body' })
  const status = h('div', { class: 'status-bar' })
  const root = h('div', { class: 'app-shell' }, [body, status])

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

/** Browser support and the short version of how Cathode works, behind a disclosure. */
export function aboutCard(): HTMLElement {
  const support = checkSupport()
  return h('details', { class: 'adv' }, [
    h('summary', { text: 'Browser check and how it works' }),
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
          text: 'Free public relays carry the first handshake only, and every message on them is encrypted with the key in your link.',
        }),
        h('li', { text: 'That key sits after the # in the link, so the webserver never receives it.' }),
        h('li', {
          text: 'Your screen goes out once per viewer, so your upload speed sets the viewer limit.',
        }),
        h('li', {
          text: 'There is no relay for the media itself. On a strict network a connection can fail, and you are told when it does.',
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
