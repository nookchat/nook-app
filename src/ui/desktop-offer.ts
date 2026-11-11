import { h } from './dom'
import { icon } from './icons'

const RELEASES = 'https://github.com/nookchat/nook-app/releases/latest'

/** The computer this browser is on, for the button, or null on a phone or tablet, which has no desktop app. */
export function desktopOs(): string | null {
  const ua = navigator.userAgent
  // An iPad reports as a Mac, so we also look for touch on a Mac.
  if (/iPad|iPhone|iPod|Android/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return null
  if (/Mac/.test(ua)) return 'macOS'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Linux|X11|CrOS/.test(ua)) return 'Linux'
  return ''
}

/**
 * The desktop app's download, for Settings › About in a browser: what it does that a tab cannot,
 * and a button for this computer. Nothing in the desktop app, or on a phone or tablet.
 */
export function desktopDownload(): { words: string; button: HTMLElement } | null {
  if ((window as Window & { nookDesktop?: unknown }).nookDesktop) return null
  const os = desktopOs()
  if (os === null) return null
  const button = h('button', {
    class: 'primary',
    on: { click: () => window.open(RELEASES, '_blank', 'noopener') },
  }, [icon('download', 16), os ? `Download for ${os}` : 'Download'])
  return {
    words: 'Shows the game you play, makes clips from your recordings, and puts a count on the Dock or taskbar.',
    button,
  }
}
