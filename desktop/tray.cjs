// The icon in the tray (the menu bar on macOS, the notification area on Windows): what it says
// about the messages that wait for you, as Discord's does: a red dot on the icon, and the count
// in its tooltip and menu. Plain functions, so the checks can run them without Electron: main.cjs
// turns them into the Tray's picture, tooltip and menu.

/** The dot, as wide as the icon times this, with a clear ring this much of the icon around it. */
const DOT_SHARE = 0.36
const GAP_SHARE = 0.07
/** Nook's red, as the page's badge has it, in the order Electron keeps a pixel: blue, green, red, alpha. */
const RED = [0x48, 0x2e, 0xc2]

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

/** Where the dot goes on an icon `size` pixels square: its middle, its radius and its clear ring. */
function dotPlace(size) {
  const r = Math.max(2.5, (size * DOT_SHARE) / 2)
  const gap = Math.max(1, size * GAP_SHARE)
  return { cx: size - r, cy: r, r, gap }
}

/**
 * The icon with a red dot in its top right corner, and a clear ring that parts it from the icon,
 * as Discord's has. The pixels are raw, 4 bytes each, blue, green, red, alpha, with the colour
 * already times the alpha, as Electron's toBitmap gives them. Returns a new buffer.
 */
function withDot(icon, size) {
  const out = Buffer.from(icon)
  const { cx, cy, r, gap } = dotPlace(size)
  // How much of a pixel a circle covers, for a soft edge.
  const cover = (d, radius) => Math.min(1, Math.max(0, radius - d + 0.5))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const clear = cover(d, r + gap)
      if (clear <= 0) continue
      const at = (y * size + x) * 4
      for (let c = 0; c < 4; c++) out[at + c] = Math.round(out[at + c] * (1 - clear))
      const dot = cover(d, r)
      for (let c = 0; c < 3; c++) out[at + c] = Math.round(RED[c] * dot + out[at + c] * (1 - dot))
      out[at + 3] = Math.round(255 * dot + out[at + 3] * (1 - dot))
    }
  }
  return out
}

module.exports = { dotPlace, trayMenuItems, trayTooltip, unreadWords, withDot }
