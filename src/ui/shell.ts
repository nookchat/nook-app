/**
 * The window.
 *
 * Cathode is not a page with a header on it. It is a window on a desktop, with a
 * title bar, caption buttons, and a status bar, the way software looked before
 * everything became a website.
 *
 * All three caption buttons do something real. A decorative control that does
 * nothing is worse than no control at all.
 */

import { checkSupport, supportRows } from '../diagnostics'
import { fmtBytes, fmtDuration, h } from './dom'
import { applyTheme, loadTheme, THEMES } from './themes'

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

const ns = 'http://www.w3.org/2000/svg'

/** The caption glyphs, drawn the way XP drew them: small, square, and white. */
function capGlyph(kind: 'min' | 'max' | 'close'): SVGSVGElement {
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 10 10')
  svg.setAttribute('width', '10')
  svg.setAttribute('height', '10')
  svg.setAttribute('aria-hidden', 'true')

  const add = (d: string, stroke: number): void => {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', d)
    p.setAttribute('stroke', '#fff')
    p.setAttribute('stroke-width', String(stroke))
    p.setAttribute('fill', 'none')
    p.setAttribute('shape-rendering', 'crispEdges')
    svg.append(p)
  }

  if (kind === 'min') add('M2 8h6', 2)
  if (kind === 'max') {
    add('M1.5 2.5h7v6h-7z', 1.4)
    add('M1.5 4h7', 1.4)
  }
  if (kind === 'close') add('M2 2l6 6M8 2l-6 6', 1.6)
  return svg
}

export function createWindow(title: string): WindowChrome {
  /*
   * The title bar carries the caption buttons and nothing else. No icon, no
   * wordmark, no caption text. What the window is doing is already on the status
   * bar along the bottom, where it does not have to compete with the controls.
   *
   * setTitle still exists and still means something: it names the browser tab.
   */
  let actions: WindowActions = {}
  document.title = title

  const cap = (kind: 'min' | 'max' | 'close', label: string): HTMLButtonElement => {
    const button = h('button', {
      class: `xp-cap${kind === 'close' ? ' close' : ''}`,
      ariaLabel: label,
      title: label,
      on: {
        click: () => {
          if (kind === 'min') actions.minimise?.()
          if (kind === 'max') actions.maximise?.()
          if (kind === 'close') actions.close?.()
        },
      },
    })
    button.append(capGlyph(kind))
    return button
  }

  const titlebar = h('div', { class: 'xp-titlebar' }, [
    h('div', { class: 'grow' }),
    h('div', { class: 'xp-title-buttons' }, [
      cap('min', 'Hide the controls'),
      cap('max', 'Fullscreen'),
      cap('close', 'Stop and go back'),
    ]),
  ])

  const body = h('div', { class: 'xp-body' })
  const status = h('div', { class: 'xp-status' })
  const win = h('div', { class: 'xp-window' }, [titlebar, body, status])
  const root = h('div', { class: 'xp-desktop' }, [win])

  // The skin picker lives on the status bar, where it is always reachable and
  // never in the way, whichever screen is up.
  const picker = h('select', {
    class: 'theme-picker',
    ariaLabel: 'Theme',
    title: 'Change the look',
    on: { change: () => applyTheme(picker.value) },
  })
  for (const theme of THEMES) {
    picker.append(h('option', { value: theme.id, text: theme.name, title: theme.note }))
  }
  picker.value = loadTheme()

  const setStatus = (panels: (HTMLElement | string)[]): void => {
    status.replaceChildren()
    panels.forEach((panel, i) => {
      const cell = h('div', { class: `xp-status-panel${i === 0 ? ' grow' : ''}` })
      cell.append(typeof panel === 'string' ? panel : panel)
      status.append(cell)
    })
    status.append(h('div', { class: 'xp-status-panel tight' }, [picker]))
  }

  setStatus(['Ready'])

  return {
    root,
    body,
    setTitle: (text) => {
      document.title = text
    },
    setStatus,
    setActions: (next) => {
      actions = next
    },
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
