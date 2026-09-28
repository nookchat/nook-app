// Light, dark, or whatever the device uses. index.html reads the same key before the first paint,
// so the page never flashes the wrong colours.

export type Theme = 'system' | 'light' | 'dark'

const KEY = 'nook.theme.v1'

/** The choice made on this page, for when storage is blocked. */
let chosenHere: Theme | null = null

export function theme(): Theme {
  if (chosenHere) return chosenHere
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* storage blocked */
  }
  return 'system'
}

const darkQuery = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

function paint(): void {
  const chosen = theme()
  if (chosen === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = chosen
  const bar = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  // The browser's own bar takes the colour of the page behind everything.
  if (bar) bar.content = getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim()
}

export function setTheme(next: Theme): void {
  chosenHere = next
  try {
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    /* storage blocked: it still holds until the page closes */
  }
  paint()
}

/** Keeps the browser's bar right when the device turns dark or light, and when another tab changes the theme. */
export function watchTheme(): void {
  paint()
  darkQuery().addEventListener('change', paint)
  window.addEventListener('storage', (ev) => {
    if (ev.key !== KEY) return
    chosenHere = null
    paint()
  })
}
