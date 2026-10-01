// The icon in the tray (the menu bar on macOS, the notification area on Windows): what it says
// about the messages that wait for you, as Discord's does. Plain functions, so the checks can run
// them without Electron: main.cjs turns them into the Tray's picture, tooltip and menu.

/** The count drawn on the icon, as wide as the tray's icon is tall times this. */
const DOT_SHARE = 0.7

/** What waits, in words: the same count the Dock and the page's tab show. */
function unreadWords(n) {
  if (!(n > 0)) return ''
  return n === 1 ? '1 unread mention or message' : `${n > 9999 ? '9999+' : n} unread mentions and messages`
}

function trayTooltip(n) {
  return n > 0 ? `Nook · ${unreadWords(n)}` : 'Nook'
}

/** The tray's menu. A count, when there is one, opens the window like Open Nook does. */
function trayMenuItems(n, act) {
  const items = []
  if (n > 0) items.push({ label: unreadWords(n), click: act.open }, { type: 'separator' })
  items.push({ label: 'Open Nook', click: act.open }, { type: 'separator' }, { label: 'Quit Nook', click: act.quit })
  return items
}

/** How big the count is, and where it goes: the bottom right corner of an icon `size` pixels square. */
function dotPlace(size) {
  const dot = Math.max(6, Math.round(size * DOT_SHARE))
  return { dot, x: size - dot, y: size - dot }
}

/**
 * Lays the count over the icon. Both are raw 4-byte pixels, alpha last, as Electron's toBitmap
 * gives them, and with the colour already times the alpha, as Electron keeps them: so a pixel of
 * the count covers the icon by its own alpha. Returns a new buffer; the icon's is left as it was.
 */
function laidOver(icon, size, count, dot, x, y) {
  const out = Buffer.from(icon)
  for (let row = 0; row < dot; row++) {
    for (let col = 0; col < dot; col++) {
      const at = ((y + row) * size + (x + col)) * 4
      const from = (row * dot + col) * 4
      if (at < 0 || at + 3 >= out.length) continue
      const cover = count[from + 3] / 255
      for (let c = 0; c < 4; c++) out[at + c] = Math.round(count[from + c] + out[at + c] * (1 - cover))
    }
  }
  return out
}

module.exports = { dotPlace, laidOver, trayMenuItems, trayTooltip, unreadWords }
