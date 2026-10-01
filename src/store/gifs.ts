export interface Gif {
  url: string
  preview: string
  /** 0 when the service did not say. */
  width: number
  height: number
}

/** The link that goes in the message: the size rides after a #, so the chat can hold its place before it loads. */
export function gifLink(g: Gif): string {
  return g.width > 0 && g.height > 0 ? `${g.url}#${g.width}x${g.height}` : g.url
}

export function isClip(url: string): boolean {
  return /\.(webm|mp4|m4v)(\?|$)/i.test(url)
}

export const FAVOURITE_GIFS_KEY = 'nook.gifstars.v1'
/** About 30 KB at most, in the sealed record that carries your settings to your other devices. */
export const MAX_FAVOURITE_GIFS = 100

function cleanGif(raw: unknown): Gif | null {
  if (!raw || typeof raw !== 'object') return null
  const g = raw as Record<string, unknown>
  const link = (v: unknown): string => (typeof v === 'string' && /^https:\/\//.test(v) && v.length <= 2048 ? v : '')
  const size = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  const url = link(g.url)
  if (!url) return null
  return { url, preview: link(g.preview) || url, width: size(g.width), height: size(g.height) }
}

/** The GIFs you starred, the newest first. They follow you to your other devices with your settings. */
export function favouriteGifs(): Gif[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FAVOURITE_GIFS_KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.map(cleanGif).filter((g): g is Gif => g !== null).slice(0, MAX_FAVOURITE_GIFS)
  } catch {
    return []
  }
}

export function isFavouriteGif(g: Gif): boolean {
  return favouriteGifs().some((f) => f.url === g.url)
}

/** Stars a GIF, or takes the star off. Returns whether it is a favourite now. */
export function toggleFavouriteGif(g: Gif): boolean {
  const had = favouriteGifs()
  const on = !had.some((f) => f.url === g.url)
  const next = on ? [g, ...had].slice(0, MAX_FAVOURITE_GIFS) : had.filter((f) => f.url !== g.url)
  try {
    localStorage.setItem(FAVOURITE_GIFS_KEY, JSON.stringify(next))
  } catch {}
  return on
}

// Security: remove a GIF API key that old versions stored in the browser.
try {
  localStorage.removeItem('nook.gifkey.v1')
} catch {}
