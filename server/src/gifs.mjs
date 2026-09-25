/**
 * GIF search, with the server's key.
 *
 * The key lives here, in the server's environment, and nowhere else: not in
 * the page, not in anybody's browser, and not in a setting a member can
 * change. Everybody in a space on this server gets the same search, and
 * nobody has to go and get a key of their own.
 *
 * Three services can hold up that end. Which one is decided by which
 * variable holds the key, never guessed from the key's shape, because a
 * wrong guess hands one company's key to another company:
 *
 *   CATHODE_KLIPY_KEY   Klipy: a test key from partner.klipy.com in a minute
 *   CATHODE_TENOR_KEY   Tenor: a Google API key, from developers.google.com/tenor
 *   CATHODE_GIPHY_KEY   Giphy: after registering an app at developers.giphy.com
 *
 * The first one set, in that order, is the one used. What is searched for
 * reaches that service, from this server: that is the deal, and the reason
 * search is off until somebody who runs the server turns it on.
 */

import { GIPHY_KEY, KLIPY_KEY, TENOR_KEY } from './config.mjs'

const LIMIT = 24
const TIMEOUT_MS = 5000
const CACHE_MS = 10 * 60 * 1000
const CACHE_MAX = 500

/** The service in use, and its key, or null when search is off. */
function held() {
  if (KLIPY_KEY) return { service: 'klipy', label: 'Klipy', key: KLIPY_KEY }
  if (TENOR_KEY) return { service: 'tenor', label: 'Tenor', key: TENOR_KEY }
  if (GIPHY_KEY) return { service: 'giphy', label: 'Giphy', key: GIPHY_KEY }
  return null
}

export const hasGifs = () => held() !== null

/** Who answers a search, as a person would name them. */
export const gifService = () => held()?.label ?? ''

/*
 * Klipy wants to know who is asking, one id per person, and there is nobody
 * here to be. Everybody sends the same word: it is honest about there being
 * one client rather than inventing a number that follows a person around.
 */
const KLIPY_CUSTOMER = 'cathode'

/** The address a search goes to. Exported for the tests. */
export function urlFor({ service, key }, q) {
  const k = encodeURIComponent(key)
  if (service === 'tenor') {
    const base = q
      ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&`
      : 'https://tenor.googleapis.com/v2/featured?'
    return `${base}key=${k}&limit=${LIMIT}&media_filter=gif,tinygif&contentfilter=medium&client_key=cathode`
  }
  if (service === 'giphy') {
    const base = q
      ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&`
      : 'https://api.giphy.com/v1/gifs/trending?'
    return `${base}api_key=${k}&limit=${LIMIT}&rating=pg-13`
  }
  // Klipy carries the key in the path rather than the query.
  const where = q ? `search?q=${encodeURIComponent(q)}&` : 'trending?'
  return `https://api.klipy.com/api/v1/${k}/gifs/${where}per_page=${LIMIT}&page=1&customer_id=${KLIPY_CUSTOMER}&content_filter=medium`
}

/** A picture address, if that is what is there. Anything else is nothing. */
const str = (value) => (typeof value === 'string' && value.startsWith('https://') ? value : '')

function at(value, ...path) {
  let here = value
  for (const step of path) {
    if (typeof here !== 'object' || here === null) return undefined
    here = here[step]
  }
  return here
}

function fromTenor(body) {
  const results = at(body, 'results')
  if (!Array.isArray(results)) return []
  return results.map((g) => ({
    url: str(at(g, 'media_formats', 'gif', 'url')),
    preview: str(at(g, 'media_formats', 'tinygif', 'url')) || str(at(g, 'media_formats', 'gif', 'url')),
  }))
}

function fromGiphy(body) {
  const results = at(body, 'data')
  if (!Array.isArray(results)) return []
  return results.map((g) => ({
    url: str(at(g, 'images', 'original', 'url')),
    preview:
      str(at(g, 'images', 'fixed_width_small', 'url')) ||
      str(at(g, 'images', 'fixed_width', 'url')) ||
      str(at(g, 'images', 'original', 'url')),
  }))
}

/*
 * Klipy hands back a tree of sizes, and the names in it are theirs to change.
 *
 * So rather than naming a path through it, every address inside one result is
 * gathered and sorted by what it is, then by how wide it is. What gets said is
 * a webm where there is one, and a gif otherwise: a webm is a fraction of the
 * weight and the chat plays it on a loop. A jpg of the first frame loses to
 * anything that moves, whatever the widths say. The grid gets the smallest
 * picture a plain img can draw, and falls back to the clip.
 */
const RANK = { webm: 4, gif: 3, webp: 2, mp4: 1, still: 0 }

function pictures(node, depth = 0) {
  if (depth > 5 || typeof node !== 'object' || node === null) return []
  const url = str(node.url)
  const found = /\.(gif|webp|png|jpe?g|webm|mp4|m4v)(\?|$)/i.exec(url)
  if (url && found) {
    const ext = found[1].toLowerCase()
    const kind =
      ext === 'webm' ? 'webm' : ext === 'gif' ? 'gif' : ext === 'webp' ? 'webp' : ext === 'mp4' || ext === 'm4v' ? 'mp4' : 'still'
    return [{ url, width: typeof node.width === 'number' ? node.width : 0, kind }]
  }
  const out = []
  for (const value of Object.values(node)) out.push(...pictures(value, depth + 1))
  return out
}

function fromKlipy(body) {
  const results = at(body, 'data', 'data')
  if (!Array.isArray(results)) return []
  return results.map((item) => {
    const found = pictures(at(item, 'file') ?? at(item, 'files') ?? item)
    if (found.length === 0) return { url: '', preview: '' }
    const best = Math.max(...found.map((p) => RANK[p.kind]))
    const said = found.filter((p) => RANK[p.kind] === best).sort((a, b) => b.width - a.width)[0]
    const drawable = found.filter((p) => p.kind === 'gif' || p.kind === 'webp').sort((a, b) => a.width - b.width)[0]
    return { url: said.url, preview: (drawable ?? said).url }
  })
}

/** What a service answered, as one big picture and one small one each. Exported for the tests. */
export function readGifs(service, body) {
  const list = service === 'tenor' ? fromTenor(body) : service === 'giphy' ? fromGiphy(body) : fromKlipy(body)
  return list
    .filter((g) => g.url !== '')
    .map((g) => ({ url: g.url, preview: g.preview || g.url }))
    .slice(0, LIMIT)
}

const cache = new Map()

/**
 * GIFs for a term, or what is popular now for an empty one. Null when the
 * service did not answer, and an empty list when search is off.
 */
export async function gifs(term) {
  const using = held()
  if (!using) return { gifs: [], from: '' }
  const q = term.trim().slice(0, 80)
  const was = cache.get(q.toLowerCase())
  if (was && Date.now() - was.at < CACHE_MS) return was.data
  try {
    const upstream = await fetch(urlFor(using, q), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!upstream.ok) return null
    const body = await upstream.json()
    const data = { gifs: readGifs(using.service, body), from: using.label }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
    cache.set(q.toLowerCase(), { at: Date.now(), data })
    return data
  } catch {
    return null
  }
}
