import { GIPHY_KEY, KLIPY_KEY, TENOR_KEY } from './config.mjs'

const LIMIT = 24
const TIMEOUT_MS = 5000
const CACHE_MS = 10 * 60 * 1000
const CACHE_MAX = 500

// Chosen by which variable holds the key, never by the key's shape: a wrong guess leaks a key.
const USING = KLIPY_KEY
  ? { service: 'klipy', label: 'Klipy', key: KLIPY_KEY }
  : TENOR_KEY
    ? { service: 'tenor', label: 'Tenor', key: TENOR_KEY }
    : GIPHY_KEY
      ? { service: 'giphy', label: 'Giphy', key: GIPHY_KEY }
      : null

export const hasGifs = () => USING !== null

export const gifService = () => USING?.label ?? ''

// One id for everybody, so Klipy cannot follow a person.
const KLIPY_CUSTOMER = 'cathode'

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
  const where = q ? `search?q=${encodeURIComponent(q)}&` : 'trending?'
  return `https://api.klipy.com/api/v1/${k}/gifs/${where}per_page=${LIMIT}&page=1&customer_id=${KLIPY_CUSTOMER}&content_filter=medium`
}

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

// Klipy's size names are not stable, so rank every address by kind, then width.
const RANK = { webm: 4, gif: 3, webp: 2, mp4: 1, still: 0 }
const KIND = { webm: 'webm', gif: 'gif', webp: 'webp', mp4: 'mp4', m4v: 'mp4' }

function pictures(node, depth = 0) {
  if (depth > 5 || typeof node !== 'object' || node === null) return []
  const url = str(node.url)
  const found = /\.(gif|webp|png|jpe?g|webm|mp4|m4v)(\?|$)/i.exec(url)
  if (url && found) {
    const kind = KIND[found[1].toLowerCase()] ?? 'still'
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

export function readGifs(service, body) {
  const list = service === 'tenor' ? fromTenor(body) : service === 'giphy' ? fromGiphy(body) : fromKlipy(body)
  return list
    .filter((g) => g.url !== '')
    .map((g) => ({ url: g.url, preview: g.preview || g.url }))
    .slice(0, LIMIT)
}

const cache = new Map()

export async function gifs(term) {
  if (!USING) return { gifs: [], from: '' }
  const q = term.trim().slice(0, 80)
  const key = q.toLowerCase()
  const was = cache.get(key)
  if (was && Date.now() - was.at < CACHE_MS) return was.data
  try {
    const upstream = await fetch(urlFor(USING, q), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!upstream.ok) return null
    const body = await upstream.json()
    const data = { gifs: readGifs(USING.service, body), from: USING.label }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
    cache.set(key, { at: Date.now(), data })
    return data
  } catch {
    return null
  }
}
