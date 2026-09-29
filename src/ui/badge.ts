import { spaces } from '../space/registry'
import { MUTED_CHANGED } from '../store/mute'
import { ROOMS_CHANGED } from '../store/notes'
import { PREFS_CHANGED } from '../store/prefs'

/**
 * What waits for you, on the tab's icon and, in the desktop app, on the Dock or taskbar
 * icon: the unread messages that mention you, in every space, and unread direct messages.
 */

const RED = '#C22E48'
const SIZE = 64
const RECOUNT_MS = 250

interface DesktopBadge {
  setBadge?: (count: number, overlay: string) => void
}

let shown = -1
let timer = 0
let icon: HTMLImageElement | null = null

function unreadNow(): number {
  let total = 0
  for (const space of spaces.all()) {
    const u = space.unread()
    total += u.mentions + u.direct
  }
  return total
}

const label = (n: number): string => (n > 99 ? '99+' : String(n))

/** A red circle with the count in it, at the given place on the canvas. */
function drawCount(x: CanvasRenderingContext2D, n: number, cx: number, cy: number, r: number): void {
  x.beginPath()
  x.arc(cx, cy, r, 0, Math.PI * 2)
  x.fillStyle = RED
  x.fill()
  const text = label(n)
  x.fillStyle = '#fff'
  x.textAlign = 'center'
  x.textBaseline = 'middle'
  x.font = `700 ${Math.round(r * (text.length > 2 ? 0.9 : text.length > 1 ? 1.1 : 1.35))}px "DM Sans", system-ui, sans-serif`
  x.fillText(text, cx, cy + r * 0.06)
}

function faviconWith(n: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const x = canvas.getContext('2d')
  if (!x) return ''
  if (icon?.complete && icon.naturalWidth) x.drawImage(icon, 0, 0, SIZE, SIZE)
  drawCount(x, n, SIZE - 22, 22, 22)
  return canvas.toDataURL('image/png')
}

/** Windows puts this small picture over the corner of the taskbar button. */
function overlayWith(n: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const x = canvas.getContext('2d')
  if (!x) return ''
  drawCount(x, n, 16, 16, 16)
  return canvas.toDataURL('image/png')
}

function paintFavicon(n: number): void {
  const badged = n > 0 ? faviconWith(n) : ''
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
    link.dataset.plain ??= link.getAttribute('href') ?? ''
    link.dataset.plainType ??= link.getAttribute('type') ?? ''
    if (badged) {
      link.href = badged
      link.type = 'image/png'
    } else {
      link.setAttribute('href', link.dataset.plain)
      if (link.dataset.plainType) link.type = link.dataset.plainType
      else link.removeAttribute('type')
    }
  }
}

function paint(): void {
  const n = unreadNow()
  if (n === shown) return
  shown = n
  paintFavicon(n)
  const desktop = (window as unknown as { nookDesktop?: DesktopBadge }).nookDesktop
  desktop?.setBadge?.(n, n > 0 ? overlayWith(n) : '')
}

function recountSoon(): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(paint, RECOUNT_MS)
}

export function watchUnread(): void {
  icon = new Image()
  icon.onload = () => {
    shown = -1
    recountSoon()
  }
  icon.src = new URL('icons/app-icon.svg', document.baseURI).href
  window.addEventListener(ROOMS_CHANGED, recountSoon)
  window.addEventListener(MUTED_CHANGED, recountSoon)
  window.addEventListener(PREFS_CHANGED, recountSoon)
  document.addEventListener('visibilitychange', recountSoon)
  recountSoon()
}
