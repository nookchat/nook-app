/**
 * The opening screen.
 *
 * One job: start sharing. There is no tour and no feature list, because a
 * person who opened this app already knows why they are here. The preset picker
 * sits inline so the first stream starts correctly without a settings trip, and
 * everything else hides behind a disclosure.
 */

import { checkSupport, hostBlocker, supportRows } from '../diagnostics'
import { PRESETS, presetById, type PresetId } from '../rtc/quality'
import { loadSettings, saveSettings } from '../settings'
import { clear, fmtBytes, fmtDuration, h } from './dom'
import type { SessionSummary } from './host-view'
import { brandMark, icon } from './icons'

export function topbar(right?: HTMLElement): HTMLElement {
  return h('div', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [brandMark(24), 'Beam']),
    h('div', { class: 'grow' }),
    right ?? null,
  ])
}

export function landing(onStart: () => void, summary: SessionSummary | null = null): HTMLElement {
  const support = checkSupport()
  const blocker = hostBlocker(support)
  const settings = loadSettings()

  let chosen: PresetId = presetById(settings.presetId) ? settings.presetId : 'docs'

  const why = h('div', { class: 'picker-why' })
  const picker = h('div', { class: 'picker' })

  const paint = (): void => {
    clear(picker)
    for (const preset of PRESETS) {
      picker.append(
        h('button', {
          class: `chip${preset.id === chosen ? ' on' : ''}`,
          text: preset.name,
          title: preset.useWhen,
          on: {
            click: () => {
              chosen = preset.id
              // Remember it now, so the host view opens on this preset.
              saveSettings({
                ...loadSettings(),
                presetId: preset.id,
                mode: preset.mode,
                maxHeight: preset.maxHeight,
                fps: preset.fps,
                bitrateScale: preset.bitrateScale,
              })
              paint()
            },
          },
        }),
      )
    }
    const current = presetById(chosen)
    clear(why)
    if (current) {
      why.append(
        h('span', {
          text: `${current.maxHeight === 0 ? 'Source size' : `${current.maxHeight}p`} at ${current.fps} fps. `,
          class: 'mono',
        }),
        h('span', { text: current.useWhen }),
      )
    }
  }
  paint()

  const startButton = h(
    'button',
    {
      class: 'primary big',
      disabled: !!blocker,
      on: { click: onStart },
    },
    [icon('share', 20), 'Share my screen'],
  )

  return h('main', {}, [
    topbar(),
    h('div', { class: 'center-page' }, [
      h('div', { class: 'hero' }, [
        summary ? summaryCard(summary) : null,

        h('div', { class: 'stack tight' }, [
          h('h1', { text: 'Share your screen' }),
          h('p', {
            class: 'lede',
            text: 'Send one link. Your screen and your sound travel straight to the people watching. No server in the middle, and no recording.',
          }),
        ]),

        blocker
          ? h('div', { class: 'card', style: { borderColor: 'var(--warn)' } }, [
              h('div', { class: 'small', text: blocker }),
            ])
          : null,

        h('div', { class: 'stack tight' }, [h('div', { class: 'eyebrow', text: 'Tuned for' }), picker, why]),

        h('div', { class: 'hero-actions' }, [startButton]),

        h('div', { class: 'footnote' }, [
          icon('shield', 14),
          h('span', { text: 'Peer to peer' }),
          h('span', { class: 'sep', text: '·' }),
          h('span', { text: 'Nothing recorded' }),
          h('span', { class: 'sep', text: '·' }),
          h('span', { text: 'No account' }),
        ]),

        h('details', { class: 'adv' }, [
          h('summary', { text: `Browser check and how it works` }),
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
              h('li', {
                text: 'That key sits after the # in the link, so the webserver never receives it.',
              }),
              h('li', {
                text: 'Your screen goes out once per viewer, so your upload speed sets the viewer limit.',
              }),
              h('li', {
                text: 'There is no relay for the media itself. On a strict network a connection can fail, and Beam says so.',
              }),
            ]),
          ]),
        ]),
      ]),
    ]),
  ])
}

function summaryCard(s: SessionSummary): HTMLElement {
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
