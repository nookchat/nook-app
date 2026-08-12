/**
 * Finding a GIF.
 *
 * There are two ways in, and a space can use either.
 *
 * The archive is the older one: the one machine a space already trusts holds
 * the key, out of the page and off everybody's device, and the browser asks
 * it. That is the better shape when a space has an archive, and it is the
 * only shape that keeps the key off the devices of everybody in the room.
 *
 * The trouble is that most spaces have no archive, so /gif found nothing and
 * said so, which reads as broken however honest the words are. So there is
 * now a second way: a key of your own, kept in this browser and used from
 * this browser. It never leaves the device and it is never said in a space.
 *
 * Which service the key belongs to is read off the key itself. Every Google
 * API key starts with AIza, and a Tenor key is a Google API key; anything
 * else is treated as a Giphy key. That is one box to fill in rather than a
 * box and a menu, and a key pasted into the wrong one cannot happen.
 *
 * Either way the search term reaches somebody else's server. That is the
 * deal, and it is why nothing here is on until a person turns it on.
 */

const KEY = 'cathode.gifkey.v1'

export interface Gif {
  /** The animation itself, which is what gets said. */
  url: string
  /** A smaller copy for the grid, so a search is not twenty full GIFs. */
  preview: string
}

/** Where a search went, so the picker can say. */
export type GifSource = 'tenor' | 'giphy' | 'archive' | ''

/** How many come back from one search. A grid, not a scroll of the internet. */
const LIMIT = 24

export function gifKey(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function setGifKey(key: string): void {
  try {
    const clean = key.trim()
    if (clean) localStorage.setItem(KEY, clean)
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode. The key lasts as long as the tab does, and no longer. */
  }
}

/** Whose key this is, by its shape. Empty when there is no key. */
export function keyService(key = gifKey()): 'tenor' | 'giphy' | '' {
  const clean = key.trim()
  if (!clean) return ''
  return clean.startsWith('AIza') ? 'tenor' : 'giphy'
}

/**
 * GIFs for a term, straight from Tenor or Giphy with the key held here.
 *
 * An empty term asks for what is popular now, because a picker that opens
 * empty looks broken and a picker that opens full is an invitation.
 */
export async function searchGifs(term: string, key = gifKey()): Promise<Gif[]> {
  const service = keyService(key)
  if (!service) return []
  const q = term.trim().slice(0, 80)
  try {
    const url =
      service === 'tenor'
        ? tenorUrl(q, key.trim())
        : giphyUrl(q, key.trim())
    const res = await globalThis.fetch(url, { mode: 'cors' })
    if (!res.ok) return []
    const body = (await res.json()) as unknown
    return service === 'tenor' ? fromTenor(body) : fromGiphy(body)
  } catch {
    return []
  }
}

function tenorUrl(q: string, key: string): string {
  const base = q
    ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&`
    : 'https://tenor.googleapis.com/v2/featured?'
  return (
    `${base}key=${encodeURIComponent(key)}&limit=${LIMIT}` +
    '&media_filter=gif,tinygif&contentfilter=medium&client_key=cathode'
  )
}

function giphyUrl(q: string, key: string): string {
  const base = q
    ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&`
    : 'https://api.giphy.com/v1/gifs/trending?'
  return `${base}api_key=${encodeURIComponent(key)}&limit=${LIMIT}&rating=pg-13`
}

/** A string, if that is what is there. Anything else is nothing. */
function str(value: unknown): string {
  return typeof value === 'string' && value.startsWith('https://') ? value : ''
}

function at(value: unknown, ...path: string[]): unknown {
  let here: unknown = value
  for (const step of path) {
    if (typeof here !== 'object' || here === null) return undefined
    here = (here as Record<string, unknown>)[step]
  }
  return here
}

function fromTenor(body: unknown): Gif[] {
  const results = at(body, 'results')
  if (!Array.isArray(results)) return []
  return tidy(
    results.map((g) => ({
      url: str(at(g, 'media_formats', 'gif', 'url')),
      preview:
        str(at(g, 'media_formats', 'tinygif', 'url')) || str(at(g, 'media_formats', 'gif', 'url')),
    })),
  )
}

function fromGiphy(body: unknown): Gif[] {
  const results = at(body, 'data')
  if (!Array.isArray(results)) return []
  return tidy(
    results.map((g) => ({
      url: str(at(g, 'images', 'original', 'url')),
      preview:
        str(at(g, 'images', 'fixed_width_small', 'url')) ||
        str(at(g, 'images', 'fixed_width', 'url')) ||
        str(at(g, 'images', 'original', 'url')),
    })),
  )
}

/** Drop the ones that came back without an address, and cap the rest. */
function tidy(list: Gif[]): Gif[] {
  return list
    .filter((g) => g.url !== '')
    .map((g) => ({ url: g.url, preview: g.preview || g.url }))
    .slice(0, LIMIT)
}
