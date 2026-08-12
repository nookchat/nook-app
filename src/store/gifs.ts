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
 * Three services can hold up that end, because getting a key is the part
 * people give up on rather than the part that is hard:
 *
 *   Klipy   a test key from the partner panel, in about a minute
 *   Tenor   free, but it is a Google API key, so it is a Google Cloud project
 *   Giphy   free, after registering an app
 *
 * Which one a key belongs to is chosen rather than guessed. A Klipy key and a
 * Giphy key look alike, and guessing wrong means handing one company's key to
 * another company, which is worse than one small menu.
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

export type GifService = 'klipy' | 'tenor' | 'giphy'

export interface GifCredential {
  service: GifService
  key: string
}

/** What each one is called, and where a key comes from. */
export const GIF_SERVICES: { id: GifService; label: string; where: string }[] = [
  { id: 'klipy', label: 'Klipy', where: 'partner.klipy.com/api-keys' },
  { id: 'tenor', label: 'Tenor', where: 'developers.google.com/tenor' },
  { id: 'giphy', label: 'Giphy', where: 'developers.giphy.com' },
]

/** How many come back from one search. A grid, not a scroll of the internet. */
const LIMIT = 24

/**
 * Klipy wants to know who is asking, one id per person, and there is nobody
 * here to be. Everybody sends the same word: it is honest about there being
 * one client rather than inventing a number that follows a person around.
 */
const KLIPY_CUSTOMER = 'cathode'

export function gifCredential(): GifCredential | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    // The first version of this box held a bare key and worked out the
    // service from its shape. Those still open, and are read the old way.
    if (!raw.startsWith('{')) return { service: raw.startsWith('AIza') ? 'tenor' : 'giphy', key: raw }
    const held = JSON.parse(raw) as { s?: unknown; k?: unknown }
    if (typeof held.k !== 'string' || !held.k) return null
    const service = GIF_SERVICES.find((s) => s.id === held.s)?.id
    return service ? { service, key: held.k } : null
  } catch {
    return null
  }
}

export function setGifCredential(service: GifService, key: string): void {
  try {
    const clean = key.trim()
    if (clean) localStorage.setItem(KEY, JSON.stringify({ s: service, k: clean }))
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode. The key lasts as long as the tab does, and no longer. */
  }
}

/** What the picker says it searched, when it found something. */
export function serviceLabel(service: GifService): string {
  return GIF_SERVICES.find((s) => s.id === service)?.label ?? service
}

/**
 * GIFs for a term, straight from the service whose key is held here.
 *
 * An empty term asks for what is popular now, because a picker that opens
 * empty looks broken and a picker that opens full is an invitation.
 */
export async function searchGifs(term: string, held = gifCredential()): Promise<Gif[]> {
  if (!held) return []
  const q = term.trim().slice(0, 80)
  try {
    const res = await globalThis.fetch(urlFor(held, q), { mode: 'cors' })
    if (!res.ok) return []
    const body = (await res.json()) as unknown
    if (held.service === 'tenor') return fromTenor(body)
    if (held.service === 'giphy') return fromGiphy(body)
    return fromKlipy(body)
  } catch {
    return []
  }
}

function urlFor(held: GifCredential, q: string): string {
  const key = encodeURIComponent(held.key)
  if (held.service === 'tenor') {
    const base = q
      ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&`
      : 'https://tenor.googleapis.com/v2/featured?'
    return (
      `${base}key=${key}&limit=${LIMIT}` +
      '&media_filter=gif,tinygif&contentfilter=medium&client_key=cathode'
    )
  }
  if (held.service === 'giphy') {
    const base = q
      ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&`
      : 'https://api.giphy.com/v1/gifs/trending?'
    return `${base}api_key=${key}&limit=${LIMIT}&rating=pg-13`
  }
  // Klipy carries the key in the path rather than the query.
  const where = q ? `search?q=${encodeURIComponent(q)}&` : 'trending?'
  return (
    `https://api.klipy.com/api/v1/${key}/gifs/${where}` +
    `per_page=${LIMIT}&page=1&customer_id=${KLIPY_CUSTOMER}&content_filter=medium`
  )
}

/** A picture address, if that is what is there. Anything else is nothing. */
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

/**
 * Klipy hands back a tree of sizes, and the names in it are theirs to change.
 *
 * So rather than naming a path through it, every address inside one result is
 * gathered and sorted by what it is, then by how wide it is. A renamed size
 * costs nothing and a size that appears tomorrow is picked up for free.
 *
 * What gets said is a webm where there is one, and a gif otherwise. A webm is
 * a fraction of the weight of the same animation as a gif and the chat plays
 * it on a loop, so it is the better thing to hand somebody. Beside both sits a
 * jpg of the first frame, which is often the widest thing in the result: a
 * still loses to anything that moves, whatever the widths say.
 *
 * The grid gets the smallest picture a plain img can draw, and falls back to
 * the clip when a result has nothing else. The picker plays that one.
 */
const RANK: Record<Kind, number> = { webm: 4, gif: 3, webp: 2, mp4: 1, still: 0 }

function fromKlipy(body: unknown): Gif[] {
  const results = at(body, 'data', 'data')
  if (!Array.isArray(results)) return []
  return tidy(
    results.map((item) => {
      const found = pictures(at(item, 'file') ?? at(item, 'files') ?? item)
      if (found.length === 0) return { url: '', preview: '' }
      const best = Math.max(...found.map((p) => RANK[p.kind]))
      const said = found
        .filter((p) => RANK[p.kind] === best)
        .sort((a, b) => b.width - a.width)[0]
      // A gif or a webp is what an img can draw, and the narrowest of those is
      // the one the grid wants. Nothing else there means the clip is the
      // preview too, and the picker plays it rather than drawing it.
      const drawable = found
        .filter((p) => p.kind === 'gif' || p.kind === 'webp')
        .sort((a, b) => a.width - b.width)[0]
      return { url: said.url, preview: (drawable ?? said).url }
    }),
  )
}

type Kind = 'webm' | 'gif' | 'webp' | 'mp4' | 'still'

/** Whether this is a clip to be played rather than a picture to be drawn. */
export function isClip(url: string): boolean {
  return /\.(webm|mp4|m4v)(\?|$)/i.test(url)
}

/** Every usable address inside a nested object, with what it is and how wide. */
function pictures(node: unknown, depth = 0): { url: string; width: number; kind: Kind }[] {
  if (depth > 5 || typeof node !== 'object' || node === null) return []
  const here = node as Record<string, unknown>
  const url = str(here.url)
  const found = /\.(gif|webp|png|jpe?g|webm|mp4|m4v)(\?|$)/i.exec(url)
  if (url && found) {
    const ext = found[1].toLowerCase()
    const kind: Kind =
      ext === 'webm' ? 'webm'
      : ext === 'gif' ? 'gif'
      : ext === 'webp' ? 'webp'
      : ext === 'mp4' || ext === 'm4v' ? 'mp4'
      : 'still'
    // A width of zero still sorts, and puts an unlabelled size at the small
    // end, which is the safe way round: a grid can survive one that is too big.
    return [{ url, width: typeof here.width === 'number' ? here.width : 0, kind }]
  }
  const out: { url: string; width: number; kind: Kind }[] = []
  for (const value of Object.values(here)) out.push(...pictures(value, depth + 1))
  return out
}

/** Drop the ones that came back without an address, and cap the rest. */
function tidy(list: Gif[]): Gif[] {
  return list
    .filter((g) => g.url !== '')
    .map((g) => ({ url: g.url, preview: g.preview || g.url }))
    .slice(0, LIMIT)
}
