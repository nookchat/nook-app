import { h } from './dom'
import { ghost } from './ghost'
import { icon } from './icons'

const RELEASES = 'https://github.com/nookchat/nook-app/releases/latest'
/** Set once somebody closes the offer: it does not come back. */
const CLOSED_KEY = 'nook.desktop-upsell.v1'

/** The computer this browser is on, for the button, or null on a phone or tablet, which has no desktop app. */
function desktopOs(): string | null {
  const ua = navigator.userAgent
  // An iPad reports as a Mac, so we also look for touch on a Mac.
  if (/iPad|iPhone|iPod|Android/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return null
  if (/Mac/.test(ua)) return 'macOS'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Linux|X11|CrOS/.test(ua)) return 'Linux'
  return ''
}

function closed(): boolean {
  try {
    return localStorage.getItem(CLOSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * The foot of the list of people, in a browser: what the desktop app does that a tab cannot,
 * and its download. Nothing in the desktop app, on a phone, or after somebody closes it.
 */
export function desktopOffer(): HTMLElement | null {
  if ((window as Window & { nookDesktop?: unknown }).nookDesktop) return null
  const os = desktopOs()
  if (os === null || closed()) return null

  const box = h('div', { class: 'desktop-offer', role: 'note' })
  const close = h('button', {
    class: 'ghost icon-only desktop-offer-close',
    ariaLabel: 'Close',
    title: 'Do not show this again',
    on: {
      click: () => {
        try {
          localStorage.setItem(CLOSED_KEY, '1')
        } catch {
          /* storage blocked: gone until the next visit */
        }
        box.remove()
      },
    },
  }, [icon('close', 14)])
  const download = h('button', {
    class: 'primary desktop-offer-download',
    on: { click: () => window.open(RELEASES, '_blank', 'noopener') },
  }, [icon('download', 16), os ? `Download for ${os}` : 'Download'])
  box.append(
    h('div', { class: 'desktop-offer-head' }, [
      ghost({ mood: 'idle', size: 28 }),
      h('span', { class: 'desktop-offer-title', text: 'Nook for desktop' }),
      close,
    ]),
    h('p', {
      class: 'desktop-offer-words',
      text: 'Shows the game you play, makes clips from your recordings, and puts a count on the Dock or taskbar.',
    }),
    download,
  )
  return box
}
