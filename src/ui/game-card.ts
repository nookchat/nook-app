import { steamPicture, type Playing } from '../net/playing'
import { h } from './dom'
import { icon } from './icons'

/** "for 5 minutes", or "for 2 hours". */
export function forHowLong(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `for ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  return `for ${hours} hour${hours === 1 ? '' : 's'}`
}

/** The top of a person's menu while they play: Steam's picture of the game when it has one, its name, and how long. */
export function gameCard(game: Playing): HTMLElement {
  const picture = game.steam ? h('img', { class: 'menu-game-art' }) : null
  if (picture) {
    picture.alt = ''
    picture.referrerPolicy = 'no-referrer'
    picture.decoding = 'async'
    picture.addEventListener('error', () => picture.remove())
    picture.src = steamPicture(game.steam!)
  }
  return h('div', { class: 'menu-game' }, [
    picture,
    h('div', { class: 'menu-game-words' }, [
      h('span', { class: 'menu-volume-label row' }, [icon('game', 14), 'Playing']),
      h('strong', { class: 'truncate', text: game.name }),
      h('span', { class: 'tiny faint', text: forHowLong(Date.now() - game.since) }),
    ]),
  ])
}
