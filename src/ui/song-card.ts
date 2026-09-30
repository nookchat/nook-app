import { songLink, songProgress, type Listening } from '../net/listening'
import { h } from './dom'
import { icon } from './icons'
import { marquee } from './marquee'

/** 3:07, from milliseconds. */
function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The song somebody listens to on Spotify, as Discord shows it: the cover, the song, the artist,
 * how far in it is, and a button that opens it on Spotify. The bar moves while the card is open.
 */
export function songCard(song: Listening): HTMLElement {
  const cover = song.art ? h('img', { class: 'song-art' }) : h('span', { class: 'song-art empty' }, [icon('music', 22)])
  if (cover instanceof HTMLImageElement) {
    cover.alt = ''
    cover.referrerPolicy = 'no-referrer'
    cover.decoding = 'async'
    cover.addEventListener('error', () => cover.replaceWith(h('span', { class: 'song-art empty' }, [icon('music', 22)])))
    cover.src = song.art!
  }

  const title = h('a', { class: 'song-title' }, [marquee(song.title)])
  title.href = songLink(song)
  title.target = '_blank'
  title.rel = 'noreferrer noopener'

  const words = h('div', { class: 'song-words' }, [
    h('span', { class: 'menu-volume-label row' }, [icon('music', 14), 'Listening to Spotify']),
    title,
    song.artist ? marquee(`by ${song.artist}`, 'song-artist') : null,
    song.album ? marquee(`on ${song.album}`, 'tiny faint') : null,
  ])

  const card = h('div', { class: 'song-card' }, [h('div', { class: 'song-top' }, [cover, words])])

  if (songProgress(song)) {
    const fill = h('i', { class: 'song-fill' })
    const played = h('span', { class: 'tiny faint' })
    const total = h('span', { class: 'tiny faint' })
    const paint = (): void => {
      const now = songProgress(song)
      if (!now) return
      fill.style.width = `${(now.played / now.duration) * 100}%`
      played.textContent = clock(now.played)
      total.textContent = clock(now.duration)
    }
    paint()
    const timer = window.setInterval(() => {
      if (!card.isConnected) {
        // A card that was never shown yet is not gone: give it a moment.
        if (performance.now() - made > 2000) window.clearInterval(timer)
        return
      }
      paint()
    }, 1000)
    const made = performance.now()
    card.append(h('div', { class: 'song-time' }, [played, h('div', { class: 'song-bar' }, [fill]), total]))
  }

  const open = h('a', { class: 'song-open' }, [icon('play', 14), 'Play on Spotify'])
  open.href = songLink(song)
  open.target = '_blank'
  open.rel = 'noreferrer noopener'
  card.append(open)
  return card
}
