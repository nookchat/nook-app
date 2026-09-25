import { ANY_ORIGIN, RATE_BURST, RATE_PER_S, originAllowed } from './config.mjs'
import { isPrivateAddress } from './addresses.mjs'

const MAX_BODY = 4 * 1024 * 1024
const BUCKET_IDLE_MS = 60_000

const CORS = {
  vary: 'origin',
  'access-control-allow-headers': 'content-type,x-nook-write,authorization,range',
  'access-control-expose-headers': 'content-range,content-length,accept-ranges',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-max-age': '86400',
}
const OPEN_CORS = { 'access-control-allow-origin': '*', ...CORS }

export function corsHeaders(req) {
  if (ANY_ORIGIN) return OPEN_CORS
  const origin = req?.headers.origin
  return { 'access-control-allow-origin': originAllowed(origin) ? origin : 'null', ...CORS }
}

export function reply(res, code, body) {
  const text = body === undefined || body === '' ? '' : JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...corsHeaders(res.req),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function fail(res, err) {
  if (err instanceof ApiError) {
    return reply(res, err.status, { error: { code: err.code, message: err.message } })
  }
  console.error('[nook]', err)
  return reply(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server.' } })
}

export function readJson(req, limit = MAX_BODY) {
  return new Promise((done, reject) => {
    let size = 0
    const parts = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new ApiError(413, 'too_large', 'That is more than one request may carry.'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => {
      try {
        done(JSON.parse(Buffer.concat(parts).toString('utf8') || 'null'))
      } catch {
        reject(new ApiError(400, 'bad_json', 'That is not JSON.'))
      }
    })
    req.on('error', reject)
  })
}

const buckets = new Map()

// Only a proxy on a private address may say who the client is, and the entry it appended is the last.
function addressOf(req) {
  const peer = req.socket.remoteAddress ?? '?'
  const forwarded = req.headers['x-forwarded-for']
  if (!forwarded || !isPrivateAddress(peer)) return peer
  return String(forwarded).split(',').at(-1).trim() || peer
}

export function allow(req) {
  const who = addressOf(req)
  const now = Date.now()
  let bucket = buckets.get(who)
  if (!bucket) buckets.set(who, (bucket = { tokens: RATE_BURST, at: now }))
  bucket.tokens = Math.min(RATE_BURST, bucket.tokens + ((now - bucket.at) / 1000) * RATE_PER_S)
  bucket.at = now
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

setInterval(() => {
  const now = Date.now()
  for (const [who, bucket] of buckets) if (now - bucket.at > BUCKET_IDLE_MS) buckets.delete(who)
}, BUCKET_IDLE_MS).unref()
