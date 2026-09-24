/**
 * The small amount of HTTP this needs: replies, errors, bodies and a limit on
 * how often one address may ask.
 *
 * Every error has one shape, { error: { code, message } }, so a client can act
 * on the code and show the message.
 */

import { ANY_ORIGIN, RATE_BURST, RATE_PER_S, originAllowed } from './config.mjs'

/** The most one request may carry. */
export const MAX_BODY = 4 * 1024 * 1024

export function reply(res, code, body) {
  const text = body === undefined || body === '' ? '' : JSON.stringify(body)
  const origin = res.req?.headers.origin
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    /*
     * By default any page may talk to it, because what decides who may read a
     * space is the key, not the origin. CATHODE_ORIGINS narrows it to the pages
     * you serve, which decides whose bandwidth this is.
     */
    'access-control-allow-origin': ANY_ORIGIN ? '*' : originAllowed(origin) ? origin : 'null',
    vary: 'origin',
    'access-control-allow-headers': 'content-type,x-cathode-write,authorization',
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    'access-control-max-age': '86400',
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
  console.error('[cathode]', err)
  return reply(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server.' } })
}

/** A request body as JSON, refused before it is in memory if it is too big. */
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

/*
 * A bucket per address: it fills at RATE_PER_S and holds RATE_BURST, and each
 * request takes one. Enough for a person, not enough for a script to fill a
 * space or turn the preview fetcher on somebody else's site.
 */
const buckets = new Map()

export function addressOf(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  return forwarded || req.socket.remoteAddress || '?'
}

export function allow(req, cost = 1) {
  const who = addressOf(req)
  const now = Date.now()
  const held = buckets.get(who) ?? { tokens: RATE_BURST, at: now }
  held.tokens = Math.min(RATE_BURST, held.tokens + ((now - held.at) / 1000) * RATE_PER_S)
  held.at = now
  if (held.tokens < cost) {
    buckets.set(who, held)
    return false
  }
  held.tokens -= cost
  buckets.set(who, held)
  return true
}

// Buckets that are full again say nothing a fresh one would not.
setInterval(() => {
  const now = Date.now()
  for (const [who, held] of buckets) if (now - held.at > 60_000) buckets.delete(who)
}, 60_000).unref()
