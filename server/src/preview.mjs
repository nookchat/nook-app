import { lookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { isPrivateAddress } from './addresses.mjs'
import { PREVIEW_LOCAL } from './config.mjs'

const PREVIEW_TIMEOUT_MS = 5000
const PREVIEW_MAX_BYTES = 512 * 1024
const PREVIEW_CACHE_MS = 10 * 60 * 1000
const PREVIEW_CACHE_MAX = 500
const previews = new Map()

function checkedLookup(host, options, done) {
  lookup(host, { ...options, all: true }, (err, addresses) => {
    if (err) return done(err)
    if (!PREVIEW_LOCAL && addresses.some((a) => isPrivateAddress(a.address))) {
      return done(Object.assign(new Error(`${host} is a private address`), { code: 'EPRIVATE' }))
    }
    if (options.all) done(null, addresses)
    else done(null, addresses[0].address, addresses[0].family)
  })
}

function get(url, signal) {
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    client
      .get(url, { lookup: checkedLookup, signal, headers: { 'user-agent': 'nook/preview', accept: 'text/html' } }, resolve)
      .on('error', reject)
  })
}

async function fetchPage(rawUrl) {
  const signal = AbortSignal.timeout(PREVIEW_TIMEOUT_MS)
  let url = rawUrl
  try {
    for (let hop = 0; hop < 4; hop++) {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      const literal = parsed.hostname.replace(/^\[|\]$/g, '')
      // A literal address never reaches the lookup, so it is checked here.
      if (!PREVIEW_LOCAL && isIP(literal) && isPrivateAddress(literal)) return null

      const res = await get(parsed, signal)
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume()
        if (!res.headers.location) return null
        url = new URL(res.headers.location, url).href
        continue
      }
      if (res.statusCode < 200 || res.statusCode >= 300 || !(res.headers['content-type'] ?? '').includes('text/html')) {
        res.resume()
        return null
      }
      const chunks = []
      let read = 0
      for await (const chunk of res) {
        chunks.push(chunk)
        read += chunk.length
        if (read >= PREVIEW_MAX_BYTES) break
      }
      res.destroy()
      return Buffer.concat(chunks).toString('utf8')
    }
  } catch {
    return null
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
      /* not an address */
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

export async function preview(wanted) {
  const held = previews.get(wanted)
  if (held && Date.now() - held.at < PREVIEW_CACHE_MS) return held.data
  const html = await fetchPage(wanted)
  // Cache failures too, so a dead link costs one fetch, not one per reader.
  const data = html ? previewOf(html, wanted) : {}
  if (previews.size >= PREVIEW_CACHE_MAX) previews.delete(previews.keys().next().value)
  previews.set(wanted, { at: Date.now(), data })
  return data
}
