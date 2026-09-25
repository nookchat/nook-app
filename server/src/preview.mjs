import { lookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { isPrivateAddress } from './addresses.mjs'
import { PREVIEW_LOCAL } from './config.mjs'

const PREVIEW_TIMEOUT_MS = 5000
// YouTube puts its tags about 700 KB in; reading stops at </head> anyway.
const PREVIEW_MAX_BYTES = 1536 * 1024
const PREVIEW_CACHE_MS = 10 * 60 * 1000
const PREVIEW_CACHE_MAX = 500
const previews = new Map()
// Says what it is. The facebookexternalhit token is what sites such as Reddit
// look for before they hand a link preview its tags instead of a wall.
const PREVIEW_AGENT = 'Mozilla/5.0 (compatible; Nook link preview; +https://github.com/nookchat/nook-app) facebookexternalhit/1.1'

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

function get(url, signal, accept = 'text/html') {
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    client
      .get(url, { lookup: checkedLookup, signal, headers: { 'user-agent': PREVIEW_AGENT, accept, 'accept-language': 'en' } }, resolve)
      .on('error', reject)
  })
}

// Pictures in a card come through this server: some sites (Reddit) only give a
// preview bot the real picture, and the reader's address stays with us.
// Only pictures a card here has named can be asked for, so this is not an open proxy.
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon)$/
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const IMAGES_HELD_BYTES = 64 * 1024 * 1024
const named = new Set()
const NAMED_MAX = 5000
const images = new Map()
let imageBytes = 0

function allow(url) {
  if (!url) return
  named.delete(url)
  named.add(url)
  if (named.size > NAMED_MAX) named.delete(named.values().next().value)
}

export function imagePath(url) {
  allow(url)
  return `/api/v1/preview/image?url=${encodeURIComponent(url)}`
}

export async function previewImage(wanted) {
  if (!named.has(wanted)) return null
  const held = images.get(wanted)
  if (held) {
    images.delete(wanted)
    images.set(wanted, held)
    return held
  }
  const signal = AbortSignal.timeout(PREVIEW_TIMEOUT_MS)
  let url = wanted
  try {
    for (let hop = 0; hop < 4; hop++) {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      const literal = parsed.hostname.replace(/^\[|\]$/g, '')
      if (!PREVIEW_LOCAL && isIP(literal) && isPrivateAddress(literal)) return null
      const res = await get(parsed, signal, 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8')
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume()
        if (!res.headers.location) return null
        url = new URL(res.headers.location, url).href
        continue
      }
      const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (res.statusCode !== 200 || !IMAGE_TYPES.test(type)) {
        res.resume()
        return null
      }
      const chunks = []
      let read = 0
      for await (const chunk of res) {
        read += chunk.length
        if (read > IMAGE_MAX_BYTES) {
          res.destroy()
          return null
        }
        chunks.push(chunk)
      }
      const got = { type, body: Buffer.concat(chunks) }
      images.set(wanted, got)
      imageBytes += got.body.length
      while (imageBytes > IMAGES_HELD_BYTES && images.size > 1) {
        const [oldKey, old] = images.entries().next().value
        images.delete(oldKey)
        imageBytes -= old.body.length
      }
      return got
    }
  } catch {
    return null
  }
  return null
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
        // Everything a preview needs is in the head.
        if (chunk.includes('</head>') || chunk.includes('</HEAD>')) break
      }
      res.destroy()
      return Buffer.concat(chunks).toString('utf8')
    }
  } catch {
    return null
  }
  return null
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™' }

function unescapeOnce(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole
    }
    return NAMED[code.toLowerCase()] ?? whole
  })
}

// Some sites escape twice (Steam writes &amp;quot;), so it is undone until it stops changing.
function unescapeHtml(text) {
  let out = text
  for (let i = 0; i < 3; i++) {
    const next = unescapeOnce(out)
    if (next === out) break
    out = next
  }
  return out.replace(/\s+/g, ' ').trim()
}

function attr(tag, name) {
  const hit = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return hit ? (hit[1] ?? hit[2] ?? hit[3] ?? '') : null
}

/** Every <meta> in the head, by its property or name, first one wins. */
function metasOf(html) {
  const out = new Map()
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? attr(tag, 'itemprop') ?? '').toLowerCase()
    const content = attr(tag, 'content')
    if (!key || content === null || out.has(key)) continue
    out.set(key, unescapeHtml(content))
  }
  return out
}

function absolute(raw, pageUrl) {
  if (!raw) return ''
  try {
    const abs = new URL(raw, pageUrl)
    return abs.protocol === 'http:' || abs.protocol === 'https:' ? abs.href.slice(0, 2048) : ''
  } catch {
    return ''
  }
}

function iconOf(html, pageUrl) {
  let best = ''
  let bestScore = -1
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase()
    if (!/\bicon\b/.test(rel)) continue
    const href = absolute(attr(tag, 'href') ?? '', pageUrl)
    if (!href || href.startsWith('data:')) continue
    const size = parseInt((attr(tag, 'sizes') ?? '').split('x')[0], 10) || (rel.includes('apple') ? 180 : 16)
    // About 32 to 64 pixels reads best at the size it is shown.
    const score = size >= 32 && size <= 96 ? 200 - Math.abs(size - 48) : size
    if (score > bestScore) {
      best = href
      bestScore = score
    }
  }
  return best || absolute('/favicon.ico', pageUrl)
}

function colourOf(raw) {
  const text = (raw ?? '').trim()
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(text)) return text
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/i.test(text)) return text
  return ''
}

function previewOf(html, pageUrl) {
  const meta = metasOf(html)
  const pick = (...keys) => keys.map((k) => meta.get(k)).find((v) => v) ?? ''
  let title =
    pick('og:title', 'twitter:title') || unescapeHtml(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '')
  let description = pick('og:description', 'twitter:description', 'description')
  let site = pick('og:site_name', 'og:site', 'application-name', 'apple-mobile-web-app-title')

  // Reddit writes the community into the title and a stock line into the description.
  const reddit = /^From the (.+?) community on Reddit: (.+)$/s.exec(title)
  if (reddit) {
    title = reddit[2]
    site = `r/${reddit[1]} · Reddit`
    if (/^Explore this post and more/i.test(description)) description = ''
  }

  const image = absolute(pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), pageUrl)
  const width = parseInt(pick('og:image:width'), 10) || 0
  const height = parseInt(pick('og:image:height'), 10) || 0
  const card = pick('twitter:card')
  const out = {}
  if (title) out.title = title.slice(0, 200)
  if (description) out.description = description.slice(0, 350)
  if (image) out.image = imagePath(image)
  if (width > 0 && height > 0) {
    out.width = width
    out.height = height
  }
  // A wide picture is shown big under the words, as Discord does; a square one sits beside them.
  if (image && (card === 'summary_large_image' || card === 'player' || (width >= 400 && width / (height || width) >= 1.3))) out.large = true
  if (site) out.site = site.slice(0, 80)
  const colour = colourOf(pick('theme-color'))
  if (colour) out.colour = colour
  const icon = iconOf(html, pageUrl)
  if (icon) out.icon = imagePath(icon)
  if (pick('og:type').startsWith('video') || card === 'player') out.video = true
  return out
}

export async function preview(wanted) {
  const held = previews.get(wanted)
  if (held && Date.now() - held.at < PREVIEW_CACHE_MS) {
    for (const path of [held.data.image, held.data.icon]) if (path) allow(new URL(path, 'http://x').searchParams.get('url'))
    return held.data
  }
  const html = await fetchPage(wanted)
  // Cache failures too, so a dead link costs one fetch, not one per reader.
  const data = html ? previewOf(html, wanted) : {}
  if (previews.size >= PREVIEW_CACHE_MAX) previews.delete(previews.keys().next().value)
  previews.set(wanted, { at: Date.now(), data })
  return data
}
