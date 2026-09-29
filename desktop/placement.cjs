// Where the windows go. The main window opens where it was last, on the same screen when
// that screen is still there; the screen picker opens over the main window, on its screen.
// Plain functions of rectangles, so a check can try them with screens that are not there.

/** How much of a window must be on a screen to count as being on it. */
const ON_SCREEN_MIN = 0.4

function area(r) {
  return Math.max(0, r.width) * Math.max(0, r.height)
}

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** The rectangle moved, and made smaller if it must be, so all of it is inside `within`. */
function keepInside(r, within) {
  const width = Math.min(r.width, within.width)
  const height = Math.min(r.height, within.height)
  const x = Math.min(Math.max(r.x, within.x), within.x + within.width - width)
  const y = Math.min(Math.max(r.y, within.y), within.y + within.height - height)
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/** A window of this size in the middle of `over`, and inside `within`. */
function centred(width, height, over, within = over) {
  const r = { x: over.x + (over.width - width) / 2, y: over.y + (over.height - height) / 2, width, height }
  return keepInside(r, within)
}

/** The screen most of the rectangle is on, or null when it is on none. */
function screenOf(r, displays) {
  let best = null
  let most = 0
  for (const d of displays) {
    const shared = overlap(r, d.workArea)
    if (shared > most) {
      most = shared
      best = d
    }
  }
  return best
}

function isRect(r) {
  return !!r && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k])) && r.width > 0 && r.height > 0
}

/**
 * Where the main window opens, from what was saved when it last closed. Where it was, when
 * enough of that is still on a screen; else in the middle of the screen it was on, when that
 * screen is still there. Null when neither is: the system picks, as on a first start.
 */
function restoreBounds(saved, displays, min = { width: 0, height: 0 }) {
  if (!saved || !isRect(saved.bounds) || !Array.isArray(displays) || displays.length === 0) return null
  const bounds = {
    ...saved.bounds,
    width: Math.max(min.width, saved.bounds.width),
    height: Math.max(min.height, saved.bounds.height),
  }
  const shown = screenOf(bounds, displays)
  if (shown && overlap(bounds, shown.workArea) >= ON_SCREEN_MIN * area(bounds)) {
    return keepInside(bounds, shown.workArea)
  }
  const was = displays.find((d) => d.id === saved.displayId)
  if (was) return centred(bounds.width, bounds.height, was.workArea)
  return null
}

/** The picker in the middle of the main window, all of it on the main window's screen. */
function pickerBounds(parent, displays, width, height) {
  const on = screenOf(parent, displays) ?? displays[0]
  if (!on) return { ...centred(width, height, parent), width, height }
  return centred(width, height, parent, on.workArea)
}

module.exports = { restoreBounds, pickerBounds, screenOf, keepInside }
