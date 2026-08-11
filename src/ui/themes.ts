/**
 * Skins.
 *
 * Every visual decision in the stylesheet reads from a token, so a theme is a
 * block of token values and nothing else. No theme owns a layout rule, which is
 * why five of them can be this different without five sets of structural CSS.
 *
 * The joke ones are opt in. Plain is there for anybody who wants none of it.
 */

export interface Theme {
  id: string
  name: string
  /** One line for the picker, so the choice is not a guessing game. */
  note: string
}

export const THEMES: Theme[] = [
  { id: 'xp', name: 'Windows XP', note: 'Luna blue, beige, and bevels' },
  { id: 'winamp', name: 'WinAmp', note: 'Black, grey and a green display' },
  { id: 'discord', name: 'Discord', note: 'Dark, blurple, and rounded' },
  { id: 'skype', name: 'Skype', note: 'White with the old bright blue' },
  { id: 'plain', name: 'Plain', note: 'Neutral, and follows your system' },
]

export const DEFAULT_THEME = 'xp'

const KEY = 'cathode.theme.v1'

export function themeById(id: string): Theme | null {
  return THEMES.find((t) => t.id === id) ?? null
}

export function loadTheme(): string {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved && themeById(saved)) return saved
  } catch {
    // Private mode. The default is fine.
  }
  return DEFAULT_THEME
}

export function applyTheme(id: string): void {
  const theme = themeById(id) ? id : DEFAULT_THEME
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // The choice lasts for this session only.
  }
  // The browser chrome on a phone should match the window, not fight it.
  const meta = document.querySelector('meta[name="theme-color"]')
  const bar = getComputedStyle(document.documentElement).getPropertyValue('--title-solid').trim()
  if (meta && bar) meta.setAttribute('content', bar)
}

/** Set the theme before first paint, so nothing flashes in the wrong skin. */
export function bootTheme(): void {
  applyTheme(loadTheme())
}
