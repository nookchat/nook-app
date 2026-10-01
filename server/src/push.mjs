import { createECDH, createHash, createPrivateKey, randomBytes, sign } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { isPrivateAddress, publicLookup } from './addresses.mjs'
import { CLUSTER_SECRET, CLUSTERED, PUBLIC_URL, PUSH_LOCAL } from './config.mjs'
import { pool } from './db.mjs'
import { ApiError } from './http.mjs'

// Web Push for a device whose Nook is closed. The page that sends a message seals the
// notification for the other person's browser (RFC 8291), so this server only signs the
// request for the push service (RFC 8292, VAPID) and passes on bytes it cannot read.

/** The push services browsers use. Anything else would let a page make this server fetch any address. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
]
/** RFC 8291 allows 4096 bytes in one push message. */
const MAX_PUSH_BYTES = 4096
const MAX_TTL_S = 7 * 24 * 60 * 60
const TOKEN_LIFE_S = 12 * 60 * 60
/** Per device: a busy space may not bury somebody in notifications. */
const BURST = 30
const PER_S = 1
const BUCKET_IDLE_MS = 10 * 60_000

let vapid = null
const tokens = new Map()
const buckets = new Map()

const b64url = (bytes) => Buffer.from(bytes).toString('base64url')

function keyFrom(d) {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(d)
  const pub = ecdh.getPublicKey()
  const key = createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
  })
  return { key, pub: b64url(pub) }
}

/**
 * One key for the whole cluster, made from its secret, so a device that subscribed on one
 * server can be reached through any of them. A server on its own keeps a key of its own.
 */
async function keys() {
  if (vapid) return vapid
  let d
  if (CLUSTERED) {
    d = createHash('sha256').update(`nook-push-vapid|${CLUSTER_SECRET}`).digest()
  } else {
    const fresh = randomBytes(32).toString('hex')
    const { rows } = await pool.query(
      `insert into push_key (id, d) values (1, $1) on conflict (id) do update set d = push_key.d returning d`,
      [fresh],
    )
    d = Buffer.from(rows[0].d, 'hex')
  }
  vapid = keyFrom(d)
  return vapid
}

export async function pushKey() {
  return { key: (await keys()).pub }
}

function endpointOf(raw) {
  let url
  try {
    url = new URL(String(raw ?? ''))
  } catch {
    throw new ApiError(400, 'bad_endpoint', 'That is not a push address.')
  }
  const local = PUSH_LOCAL && url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)
  if (!local && (url.protocol !== 'https:' || !PUSH_HOSTS.some((host) => host.test(url.hostname)))) {
    throw new ApiError(400, 'bad_endpoint', 'That is not the address of a push service.')
  }
  if (url.username || url.password || url.href.length > 1024) throw new ApiError(400, 'bad_endpoint', 'That is not a push address.')
  return url
}

async function token(audience) {
  const held = tokens.get(audience)
  const now = Math.floor(Date.now() / 1000)
  if (held && held.exp - now > 60 * 60) return held.jwt
  const { key } = await keys()
  const exp = now + TOKEN_LIFE_S
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64url(JSON.stringify({ aud: audience, exp, sub: PUBLIC_URL || 'mailto:push@nook.invalid' }))
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  const jwt = `${head}.${claims}.${b64url(signature)}`
  tokens.set(audience, { jwt, exp })
  return jwt
}

function allowed(endpoint) {
  const now = Date.now()
  if (buckets.size > 10_000) {
    for (const [name, b] of buckets) if (now - b.at > BUCKET_IDLE_MS) buckets.delete(name)
  }
  const bucket = buckets.get(endpoint) ?? { tokens: BURST, at: now }
  bucket.tokens = Math.min(BURST, bucket.tokens + ((now - bucket.at) / 1000) * PER_S)
  bucket.at = now
  buckets.set(endpoint, bucket)
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

/**
 * Passes one sealed notification on. `gone` says the device no longer takes them. With `via`,
 * the device took its pushes through another Nook server, whose key it was made with: this one
 * hands it on there, so that server sees this one, not the address of whoever wrote.
 */
export async function push(body) {
  if (typeof body?.via === 'string' && body.via) return relay(body.via, body)
  const endpoint = endpointOf(body?.endpoint)
  const sealed = typeof body?.body === 'string' ? Buffer.from(body.body, 'base64url') : null
  if (!sealed || sealed.length < 86 || sealed.length > MAX_PUSH_BYTES) {
    throw new ApiError(400, 'bad_body', 'A push is sealed bytes, at most 4096 of them.')
  }
  if (!allowed(endpoint.href)) throw new ApiError(429, 'slow_down', 'That device has had enough for now.')
  const ttl = Math.max(0, Math.min(MAX_TTL_S, Math.floor(Number(body.ttl) || 86_400)))
  const headers = {
    authorization: `vapid t=${await token(endpoint.origin)}, k=${(await keys()).pub}`,
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(ttl),
    urgency: body.urgency === 'normal' ? 'normal' : 'high',
  }
  if (typeof body.topic === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(body.topic)) headers.topic = body.topic
  let res
  try {
    res = await fetch(endpoint.href, { method: 'POST', headers, body: sealed, redirect: 'error', signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new ApiError(502, 'upstream', 'The push service did not answer.')
  }
  await res.body?.cancel().catch(() => undefined)
  if (res.status === 404 || res.status === 410) return { ok: false, gone: true }
  if (!res.ok) throw new ApiError(502, 'upstream', `The push service said ${res.status}.`)
  return { ok: true }
}

const RELAY_TIMEOUT_MS = 15_000

function relay(via, body) {
  let url
  try {
    url = new URL('/api/v1/push', via)
  } catch {
    throw new ApiError(400, 'bad_via', 'That is not a server.')
  }
  const local = PUSH_LOCAL && url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if ((!local && url.protocol !== 'https:') || url.username || url.password || via.length > 1024) {
    throw new ApiError(400, 'bad_via', 'That is not a server.')
  }
  // A literal address never reaches the lookup, so it is checked here.
  if (!local && isIP(literal) && isPrivateAddress(literal)) throw new ApiError(400, 'bad_via', 'That is not a server.')
  const { via: _, ...rest } = body
  const payload = Buffer.from(JSON.stringify(rest))
  const client = url.protocol === 'https:' ? https : http
  return new Promise((done, reject) => {
    const req = client.request(
      url,
      {
        method: 'POST',
        lookup: publicLookup(local),
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (text.length < 4096) text += chunk
        })
        res.on('end', () => {
          if (res.statusCode === 429) return reject(new ApiError(429, 'slow_down', 'That device has had enough for now.'))
          if (res.statusCode !== 200) return reject(new ApiError(502, 'upstream', `${url.host} said ${res.statusCode}.`))
          try {
            const answer = JSON.parse(text)
            done({ ok: answer?.ok === true, gone: answer?.gone === true || undefined })
          } catch {
            done({ ok: true })
          }
        })
      },
    )
    req.on('error', () => reject(new ApiError(502, 'upstream', `${url.host} did not answer.`)))
    req.end(payload)
  })
}
