import { checkSupport, hostBlocker, supportRows } from '../diagnostics'
import { h } from './dom'

export function topbar(right?: HTMLElement): HTMLElement {
  return h('div', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [h('span', { class: 'mark', text: 'B' }), 'Beam']),
    h('div', { class: 'grow' }),
    right ?? null,
  ])
}

export function landing(onStart: () => void): HTMLElement {
  const support = checkSupport()
  const blocker = hostBlocker(support)

  const startButton = h('button', {
    class: 'primary big',
    text: 'Share my screen',
    disabled: !!blocker,
    on: { click: onStart },
  })

  const rows = h(
    'div',
    { class: 'stack tight', style: { marginTop: '4px' } },
    supportRows(support).map((r) =>
      h('div', { class: 'row spread' }, [
        h('span', { class: 'small', text: r.label }),
        h('span', { class: `pill ${r.ok ? 'good' : 'warn'}`, text: r.note }),
      ]),
    ),
  )

  return h('main', {}, [
    topbar(),
    h('div', { class: 'center-page' }, [
      h('div', { class: 'sheet stack' }, [
        h('div', { class: 'stack tight' }, [
          h('h1', { text: 'Share your screen, peer to peer', style: { margin: '0', fontSize: '28px', letterSpacing: '-0.02em' } }),
          h('p', {
            class: 'dim',
            style: { margin: '0' },
            text:
              'Start a stream, then send the link to anybody. The picture and the sound go straight from your computer to theirs. No media server sees them, and nothing is recorded.',
          }),
        ]),

        blocker
          ? h('div', { class: 'card', style: { borderColor: 'var(--warn)' } }, [
              h('div', { class: 'small', text: blocker }),
            ])
          : null,

        h('div', { class: 'row' }, [startButton]),

        h('div', { class: 'card stack tight' }, [
          h('strong', { class: 'small', text: 'This browser' }),
          rows,
        ]),

        h('div', { class: 'card stack tight' }, [
          h('strong', { class: 'small', text: 'How it works' }),
          h('ul', { class: 'support-list' }, [
            h('li', {
              text: 'Beam uses free public relays for the first handshake only. Every message on them is encrypted with the key in your link.',
            }),
            h('li', {
              text: 'The key sits after the # in the link, so the webserver never receives it.',
            }),
            h('li', {
              text: 'Your screen goes out once for each viewer, so your upload speed sets the viewer limit.',
            }),
            h('li', {
              text: 'Beam runs with no relay server for media. On a strict network a connection can fail, and Beam tells you when it does.',
            }),
          ]),
        ]),
      ]),
    ]),
  ])
}
