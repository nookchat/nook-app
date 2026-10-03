// What counts as a picture in a message: a link to one, or a drawing. The chat draws them, and
// a channel marked Media only lets through only messages that have one, or a file.

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g
const IMAGE_RE = /\.(gif|png|jpe?g|webp|avif|apng|bmp|svg)(\?[^\s]*)?$/i
const IMAGE_PATH_RE = /\.(gif|png|jpe?g|webp|avif|apng)(\/|$)/i
const IMAGE_QUERY_RE = /(?:^|&)(?:format|fm|ext|type)=(gif|png|jpe?g|webp|avif)(?:&|$)/i
export const CLIP_RE = /\.(webm|mp4|m4v)(\?[^\s]*)?$/i

const IMAGE_HOSTS = new Set([
  'i.imgur.com',
  'pbs.twimg.com',
  'i.redd.it',
  'preview.redd.it',
  'cdn.discordapp.com',
  'media.discordapp.net',
  'media.tenor.com',
  'c.tenor.com',
  'media.giphy.com',
  'i.giphy.com',
  'i.ibb.co',
  'files.catbox.moe',
  'images.unsplash.com',
  'user-images.githubusercontent.com',
])

const MAX_PICTURES = 4

function looksLikePicture(url: URL): boolean {
  const pathAndQuery = url.pathname + url.search
  return (
    CLIP_RE.test(pathAndQuery) ||
    IMAGE_RE.test(pathAndQuery) ||
    IMAGE_PATH_RE.test(url.pathname) ||
    IMAGE_QUERY_RE.test(url.search.replace(/^\?/, '')) ||
    IMAGE_HOSTS.has(url.hostname.toLowerCase())
  )
}

export function imageLinks(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0]
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' || !looksLikePicture(url)) continue
    if (!out.includes(raw)) out.push(raw)
    if (out.length === MAX_PICTURES) break
  }
  return out
}

/** The whole message is one SVG, which the chat draws as a picture. */
export function isDrawing(text: string): boolean {
  const t = text.trim()
  return /^<svg[\s>]/i.test(t) && /<\/svg>$/i.test(t)
}

/** A file, a picture or clip link, or a drawing: what a channel marked Media only lets through. */
export function hasMedia(text: string, files: readonly unknown[] = []): boolean {
  return files.length > 0 || imageLinks(text).length > 0 || isDrawing(text)
}
