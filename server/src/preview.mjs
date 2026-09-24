/**
 * Link cards and GIF search: the two things a browser cannot do alone.
 *
 * A browser cannot read another site's page, so a chat message with a link in
 * it cannot grow a card by itself, and every keyless GIF search is gone. This
 * server does both for the spaces on it. Both are the one place it learns
 * something about what is said: which links get previewed, and which words
 * get searched. CATHODE_PREVIEWS=0 turns cards off, and GIF search is off
 * until a key is given.
 */

import { lookup } from 'node:dns/promises'
import { PREVIEW_LOCAL, TENOR_KEY } from './config.mjs'

/*
 * Link previews.
 *
 * A browser cannot read another site's page, so a chat message with a link in
 * it cannot grow a card by itself. Somebody has to go and look, and this is
 * the one machine the space already chose to trust with being awake. It
 * learns which links get previewed, which is less than the ciphertext it
 * already holds; a space that dislikes even that runs no archive.
 *
 * It fetches with care, because "go and look at any URL" is an invitation:
 * only http and https, never an address that resolves into this machine's own
 * network, redirects walked by hand so they cannot smuggle one in, five
 * seconds and half a megabyte at most, and everything cached so a room of
 * thirty people costs a site one visit.
 */
const PREVIEW_TIMEOUT_MS = 5000
const PREVIEW_MAX_BYTES = 512 * 1024
const PREVIEW_CACHE_MS = 10 * 60 * 1000
const PREVIEW_CACHE_MAX = 500
const previews = new Map()

function privateAddress(ip) {
  let v4 = ip
  const low = ip.toLowerCase()
  if (low.includes(':')) {
    if (low.startsWith('::ffff:')) v4 = low.slice(7)
    else {
      return (
        low === '::1' ||
        low === '::' ||
        low.startsWith('fc') ||
        low.startsWith('fd') ||
        low.startsWith('fe80')
      )
    }
  }
  const [a, b] = v4.split('.').map(Number)
  return (
    !Number.isFinite(a) ||
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

async function hostAllowed(host) {
  // For tests, which have nowhere to stand but localhost.
  if (PREVIEW_LOCAL) return true
  try {
    const addresses = await lookup(host, { all: true })
    return addresses.length > 0 && addresses.every((a) => !privateAddress(a.address))
  } catch {
    return false
  }
}

/** The first chunk of a page, or null for anything that is not a public html page. */
async function fetchPage(rawUrl) {
  let url = rawUrl
  for (let hop = 0; hop < 4; hop++) {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!(await hostAllowed(parsed.hostname))) return null

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PREVIEW_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': 'cathode/preview', accept: 'text/html' },
      })
      if (res.status >= 300 && res.status < 400) {
        const to = res.headers.get('location')
        if (!to) return null
        url = new URL(to, url).href
        continue
      }
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) {
        return null
      }
      const reader = res.body.getReader()
      const chunks = []
      let read = 0
      while (read < PREVIEW_MAX_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        read += value.length
      }
      void reader.cancel().catch(() => undefined)
      return Buffer.concat(chunks).toString('utf8')
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

function unescapeHtml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
}

function metaOf(html, name) {
  const tag = html.match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i'),
  )?.[0]
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? ''
  return unescapeHtml(content).trim()
}

function previewOf(html, pageUrl) {
  const title = metaOf(html, 'og:title') || unescapeHtml(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim()
  const description = metaOf(html, 'og:description') || metaOf(html, 'description')
  let image = ''
  const rawImage = metaOf(html, 'og:image')
  if (rawImage) {
    try {
      const abs = new URL(rawImage, pageUrl)
      if (abs.protocol === 'http:' || abs.protocol === 'https:') image = abs.href
    } catch {
      /* a picture that is not an address is no picture */
    }
  }
  const out = {}
  if (title) out.title = title.slice(0, 160)
  if (description) out.description = description.slice(0, 300)
  if (image) out.image = image.slice(0, 2048)
  const site = metaOf(html, 'og:site_name')
  if (site) out.site = site.slice(0, 80)
  return out
}


/** What is behind a link, cached, or an empty card for anything that is not a page. */
export async function preview(wanted) {
  const held = previews.get(wanted)
  if (held && Date.now() - held.at < PREVIEW_CACHE_MS) return held.data
  const html = await fetchPage(wanted)
  // A page that answered nothing is cached as nothing, so a dead link does
  // not cost one fetch per person who scrolls past it.
  const data = html ? previewOf(html, wanted) : {}
  if (previews.size >= PREVIEW_CACHE_MAX) previews.delete(previews.keys().next().value)
  previews.set(wanted, { at: Date.now(), data })
  return data
}

/*
 * GIF search. Tenor v1 is discontinued and Giphy's old public key is banned,
 * so the server holds the key, off every member's device. Free keys come from
 * https://developers.google.com/tenor.
 */
const gifCache = new Map()

export const hasGifs = () => TENOR_KEY !== ''

/** GIFs for a term, or null when Tenor did not answer. */
export async function gifs(q) {
  const held = gifCache.get(q.toLowerCase())
  if (held && Date.now() - held.at < PREVIEW_CACHE_MS) return held.data
  try {
    const upstream = await fetch(
      `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}` +
        `&key=${TENOR_KEY}&limit=24&media_filter=gif,tinygif&contentfilter=medium`,
      { signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS) },
    )
    if (!upstream.ok) return null
    const body = await upstream.json()
    const list = (Array.isArray(body.results) ? body.results : [])
      .map((g) => ({
        url: g?.media_formats?.gif?.url ?? '',
        preview: g?.media_formats?.tinygif?.url ?? g?.media_formats?.gif?.url ?? '',
      }))
      .filter((g) => g.url.startsWith('https://'))
    const data = { gifs: list }
    if (gifCache.size >= PREVIEW_CACHE_MAX) gifCache.delete(gifCache.keys().next().value)
    gifCache.set(q.toLowerCase(), { at: Date.now(), data })
    return data
  } catch {
    return null
  }
}
