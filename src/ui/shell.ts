/**
 * Small pieces shared by every screen: the top bar, the panel that explains
 * itself only when asked, and the summary of the stream that just ended.
 */

import { checkSupport, supportRows } from '../diagnostics'
import { fmtBytes, fmtDuration, h } from './dom'
import { brandMark } from './icons'

export interface SessionSummary {
  seconds: number
  peakViewers: number
  bytesSent: number
}

export function topbar(right?: HTMLElement): HTMLElement {
  return h('div', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [brandMark(24), 'Beam']),
    h('div', { class: 'grow' }),
    right ?? null,
  ])
}

/** Browser support and the short version of how Beam works, behind a disclosure. */
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
          text: 'There is no relay for the media itself. On a strict network a connection can fail, and Beam says so.',
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
    h('div', { class: 'row wrap', style: { gap: '7px' } }, [
      h('span', { class: 'pill', text: fmtDuration(s.seconds * 1000) }),
      h('span', {
        class: 'pill',
        text: `${s.peakViewers} viewer${s.peakViewers === 1 ? '' : 's'} at the peak`,
      }),
      h('span', { class: 'pill', text: `${fmtBytes(s.bytesSent)} sent` }),
    ]),
    h('div', { class: 'tiny faint', text: 'Beam kept no copy of the picture or the sound.' }),
  ])
}
