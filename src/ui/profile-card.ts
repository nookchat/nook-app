import type { Listening } from '../net/listening'
import type { Playing } from '../net/playing'
import { avatarOf } from './chat-panel'
import { h } from './dom'
import { gameCard } from './game-card'
import { icon } from './icons'
import { songCard } from './song-card'

export interface ProfileData {
  key: string
  name: string
  /** Their picture, or '' for their initials. */
  picture: string
  you: boolean
  /** Null when they are not here. */
  presence: { dot: string; words: string } | null
  statusText: string
  /** Their level when it is not the plain one, with its colour. */
  level: { name: string; colour: string } | null
  owner: boolean
  voice: string | null
  sharing: boolean
  playing: Playing | null
  listening: Listening | null
  /** Their key, short, so two people with one name can be told apart. */
  tag: string
  message?: () => void
  /** What a right click on them offers. */
  more?: (anchor: HTMLElement) => void
  edit?: () => void
}

/** A colour for the band at the top, from their level, or else from their key, so it stays theirs. */
function bandColour(data: ProfileData): string {
  if (data.level?.colour) return data.level.colour
  let n = 0
  for (const ch of data.key.slice(0, 12)) n = (n * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${n % 360} 45% 55%)`
}

/**
 * A person's profile, as Discord opens it on a click on their name: a band in their colour, their
 * picture large, their name, what they said about themselves, and what they do now, with the
 * song they listen to and the game they play in full.
 */
export function profileCard(data: ProfileData): HTMLElement {
  const band = h('div', { class: 'profile-band' })
  band.style.setProperty('--band', bandColour(data))

  const face = h('div', { class: 'profile-card-face' }, [
    avatarOf(data.key, data.name, data.picture, 84),
    data.presence ? h('i', { class: `dot ${data.presence.dot}`, title: data.presence.words }) : null,
  ])

  const name = h('div', { class: 'profile-name' }, [
    h('span', { class: 'truncate', text: data.name || data.tag }),
    data.owner ? h('span', { class: 'crown', title: 'Made this space' }, [icon('crown', 14)]) : null,
  ])
  const who = h('div', { class: 'profile-who' }, [
    name,
    h('div', { class: 'profile-tag tiny faint', text: `${data.tag} · ${data.presence ? data.presence.words : 'Offline'}` }),
  ])

  const body = h('div', { class: 'profile-body' }, [who])
  if (data.statusText) body.append(h('div', { class: 'profile-said', text: data.statusText }))

  const section = (title: string, ...children: (Node | null)[]): HTMLElement =>
    h('section', { class: 'profile-section' }, [h('div', { class: 'profile-heading', text: title }), ...children])

  if (data.level) {
    const chip = h('span', { class: 'profile-level' }, [h('i', { class: 'profile-level-dot' }), data.level.name])
    if (data.level.colour) chip.style.setProperty('--level', data.level.colour)
    body.append(section('Level', chip))
  }
  if (data.sharing) body.append(section('Now', h('span', { class: 'person-doing live' }, [h('i', { class: 'live-dot' }), 'Sharing their screen'])))
  else if (data.voice) body.append(section('In voice', h('span', { class: 'profile-line' }, [icon('volume-low', 14), data.voice])))
  // The cards say what they are themselves.
  if (data.listening) body.append(h('section', { class: 'profile-section' }, [songCard(data.listening)]))
  if (data.playing) body.append(h('section', { class: 'profile-section' }, [gameCard(data.playing)]))

  const actions = h('div', { class: 'profile-actions' })
  if (data.edit) {
    actions.append(h('button', { class: 'small', on: { click: () => data.edit?.() } }, [icon('edit', 14), 'Edit profile']))
  }
  if (data.message) {
    actions.append(h('button', { class: 'small primary grow', on: { click: () => data.message?.() } }, [icon('send', 14), `Message ${data.name || 'them'}`]))
  }
  if (data.more) {
    const more: HTMLButtonElement = h('button', {
      class: 'small icon-only',
      title: 'More',
      ariaLabel: `More for ${data.name || data.tag}`,
      on: { click: () => data.more?.(more) },
    }, [icon('more', 16)])
    actions.append(more)
  }
  if (actions.childElementCount) body.append(actions)

  return h('div', { class: 'profile-card', role: 'dialog', ariaLabel: `${data.name || data.tag}’s profile` }, [band, face, body])
}
