import { createHash, webcrypto } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1'
import { corsHeaders } from './http.mjs'
import { PREVIEWS } from './config.mjs'
import { pool } from './db.mjs'
import { imagePath } from './preview.mjs'
import { append, mayWrite } from './store.mjs'

// Webhooks, as Discord has them: POST /api/webhooks/<id>/<token> with { content, username,
// avatar_url, embeds } puts a message in a channel. The token holds the space, its write token,
// the webhook's own key and the key it signs with (see src/space/webhook.ts, which makes it).
// The server seals and signs the message as the app would, keeps it, and forgets the token.
// So the server reads what a webhook posts, while it posts it, and nothing else.

const TOKEN_VERSION = 1
const HOOK_ID = /^[1-9][0-9]{16,19}$/
const MAX_CONTENT = 2000
const MAX_REQUEST = 1024 * 1024
const KEY_LABEL = 'nook-space-key-1'
/** Discord's limit: five a webhook in two seconds. */
const BURST = 5
const WINDOW_MS = 2000

const sha256 = (data) => createHash('sha256').update(data).digest()
const hex = (bytes) => Buffer.from(bytes).toString('hex')

class HookError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

const UNKNOWN = () => new HookError(404, 10015, 'Unknown Webhook')

function discordReply(res, status, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    ...(text ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    'content-length': Buffer.byteLength(text),
    ...corsHeaders(res.req),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
  return true
}

/** The id Discord would show, from the key the webhook signs with. The app works it out the same way. */
function idOf(pub) {
  const n = sha256(pub).readBigUInt64BE(0)
  return String((n % 900_000_000_000_000_000n) + 100_000_000_000_000_000n)
}

export function readToken(id, token) {
  if (!HOOK_ID.test(id ?? '') || typeof token !== 'string' || !/^[A-Za-z0-9_-]{150,400}$/.test(token)) throw UNKNOWN()
  const bytes = Buffer.from(token, 'base64url')
  if (bytes.length < 114 || bytes[0] !== TOKEN_VERSION) throw UNKNOWN()
  const seed = bytes.subarray(81, 113)
  let pub
  try {
    pub = hex(schnorr.getPublicKey(seed))
  } catch {
    throw UNKNOWN()
  }
  if (idOf(pub) !== id) throw new HookError(401, 50027, 'Invalid Webhook Token')
  const channel = bytes.subarray(113).toString('utf8')
  if (!/^[a-z0-9-]{1,24}$/.test(channel)) throw UNKNOWN()
  return {
    id,
    room: hex(bytes.subarray(1, 17)),
    write: hex(bytes.subarray(17, 49)),
    key: bytes.subarray(49, 81),
    seed,
    pub,
    channel,
  }
}

const recent = new Map()

function slowDown(id) {
  const now = Date.now()
  const times = (recent.get(id) ?? []).filter((t) => now - t < WINDOW_MS)
  if (times.length >= BURST) {
    const wait = (WINDOW_MS - (now - times[0])) / 1000
    throw new HookError(429, 0, 'You are being rate limited.', { retry_after: Math.max(0.1, Number(wait.toFixed(3))), global: false })
  }
  times.push(now)
  recent.set(id, times)
}

setInterval(() => {
  const now = Date.now()
  for (const [id, times] of recent) if (times.every((t) => now - t >= WINDOW_MS)) recent.delete(id)
}, 60_000).unref()

function readBody(req) {
  return new Promise((done, reject) => {
    let size = 0
    const parts = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_REQUEST) {
        reject(new HookError(413, 40005, 'Request entity too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

/** The fields of a multipart body, as text. Files are not taken. */
function multipart(body, type) {
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1]
  if (!boundary) return {}
  const out = {}
  for (const part of body.toString('utf8').split(`--${boundary}`)) {
    const split = part.indexOf('\r\n\r\n')
    if (split < 0) continue
    const head = part.slice(0, split)
    if (/filename=/i.test(head)) continue
    const name = /name="([^"]+)"/i.exec(head)?.[1]
    if (name) out[name] = part.slice(split + 4).replace(/\r\n$/, '')
  }
  return out
}

/** What was sent, from JSON, a form, or a multipart form with payload_json, as Discord takes them. */
async function payload(req) {
  const body = await readBody(req)
  const type = String(req.headers['content-type'] ?? '')
  const bad = () => new HookError(400, 50109, 'The request body contains invalid JSON.')
  const json = (text) => {
    try {
      const value = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad()
      return value
    } catch {
      throw bad()
    }
  }
  if (/multipart\/form-data/i.test(type)) {
    const fields = multipart(body, type)
    return fields.payload_json ? json(fields.payload_json) : fields
  }
  if (/application\/x-www-form-urlencoded/i.test(type)) {
    const fields = Object.fromEntries(new URLSearchParams(body.toString('utf8')))
    return fields.payload_json ? json(fields.payload_json) : fields
  }
  return json(body.toString('utf8') || '{}')
}

function webAddress(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
  } catch {
    return ''
  }
}

/** The message as the app keeps it. The app checks every part again when it reads it. */
function messageBody(sent, forEdit = false) {
  const content = sent.content === undefined || sent.content === null ? '' : String(sent.content)
  if (content.length > MAX_CONTENT) {
    throw new HookError(400, 50035, 'Invalid Form Body', {
      errors: { content: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: `Must be ${MAX_CONTENT} or fewer in length.` }] } },
    })
  }
  const embeds = Array.isArray(sent.embeds) ? sent.embeds.slice(0, 10) : []
  if (!forEdit && !content.trim() && embeds.length === 0) throw new HookError(400, 50006, 'Cannot send an empty message')
  // An edit that leaves out the words keeps them.
  const body = forEdit && (sent.content === undefined || sent.content === null) ? {} : { text: content }
  if (embeds.length || (forEdit && Array.isArray(sent.embeds))) body.embeds = embeds
  if (!forEdit) {
    const name = typeof sent.username === 'string' ? sent.username.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
    if (name) body.name = name
    const avatar = webAddress(sent.avatar_url)
    if (avatar) body.avatar = avatar
  }
  return body
}

/** Lets the app show the pictures a webhook names, through this server, as a link card's are. */
function namePictures(body) {
  if (!PREVIEWS) return
  if (body.avatar) imagePath(body.avatar)
  for (const embed of body.embeds ?? []) {
    for (const url of [embed?.image?.url, embed?.thumbnail?.url, embed?.author?.icon_url]) {
      const address = webAddress(url)
      if (address) imagePath(address)
    }
  }
}

async function sealLine(key, event) {
  const envelope = { v: 1, id: event.id, from: event.author, t: event.at, type: 'ping', data: event }
  const aes = await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, Buffer.from(JSON.stringify(envelope))))
  const tag = hex(sha256(Buffer.concat([Buffer.from(KEY_LABEL), key]))).slice(0, 32)
  return `${tag}.${Buffer.concat([iv, sealed]).toString('base64url')}`
}

/**
 * Signs an event as the webhook, seals it with its key and keeps it. Its place in the log is
 * the time now, as the app's clock gives a place: see nextLamport in src/store/log.ts.
 */
async function post(hook, kind, body) {
  const { rows } = await pool.query('select exists (select 1 from lines where room = $1) as held', [hook.room])
  if (!rows[0].held) throw UNKNOWN()
  if (!(await mayWrite(hook.room, hook.write))) throw UNKNOWN()
  const now = Date.now()
  const base = { room: hook.room, author: hook.pub, lamport: now, kind, at: now, body }
  const id = hex(sha256(JSON.stringify([base.room, base.author, base.lamport, base.kind, base.at, base.body])))
  const event = { ...base, id, sig: hex(schnorr.sign(Buffer.from(id, 'hex'), hook.seed)) }
  await append(hook.room, [await sealLine(hook.key, event)])
  namePictures(body)
  return event
}

function discordMessage(hook, event, sent) {
  const when = new Date(event.at).toISOString()
  return {
    id: event.id,
    type: 0,
    content: event.body.text ?? '',
    channel_id: hook.channel,
    author: { id: hook.id, username: event.body.name ?? sent?.username ?? 'Webhook', avatar: null, discriminator: '0000', bot: true },
    attachments: [],
    embeds: Array.isArray(event.body.embeds) ? event.body.embeds : [],
    mentions: [],
    mention_roles: [],
    pinned: false,
    mention_everyone: false,
    tts: false,
    timestamp: when,
    edited_timestamp: event.kind === 'edit' ? when : null,
    flags: 0,
    components: [],
    webhook_id: hook.id,
  }
}

const MESSAGE_ID = /^[0-9a-f]{64}$/

/** Answers /api/webhooks/... Returns false when the path is not a webhook's. */
export async function handleWebhook(req, res, parts, url) {
  if (parts[0] !== 'api' || parts[1] !== 'webhooks') return false
  try {
    const [, , id, token, what, messageId, extra] = parts
    const method = req.method ?? 'GET'
    const hook = readToken(id, token)
    if (!what) {
      if (method === 'GET') {
        return discordReply(res, 200, {
          id: hook.id,
          type: 1,
          name: null,
          avatar: null,
          channel_id: hook.channel,
          guild_id: null,
          application_id: null,
          token,
        })
      }
      if (method === 'POST') {
        slowDown(hook.id)
        const sent = await payload(req)
        const event = await post(hook, 'said', { ...messageBody(sent), channel: hook.channel })
        const wait = /^(1|true)$/i.test(url.searchParams.get('wait') ?? '')
        return wait ? discordReply(res, 200, discordMessage(hook, event, sent)) : discordReply(res, 204)
      }
      if (method === 'DELETE') {
        await post(hook, 'hook', { id: hook.id, gone: true })
        return discordReply(res, 204)
      }
      throw new HookError(405, 0, '405: Method Not Allowed')
    }
    if (what === 'messages' && messageId && !extra) {
      if (!MESSAGE_ID.test(messageId)) throw new HookError(404, 10008, 'Unknown Message')
      slowDown(hook.id)
      if (method === 'PATCH') {
        const sent = await payload(req)
        const event = await post(hook, 'edit', { target: messageId, ...messageBody(sent, true) })
        return discordReply(res, 200, discordMessage(hook, event, sent))
      }
      if (method === 'DELETE') {
        await post(hook, 'retract', { target: messageId })
        return discordReply(res, 204)
      }
    }
    throw new HookError(405, 0, '405: Method Not Allowed')
  } catch (err) {
    if (err instanceof HookError) {
      discordReply(res, err.status, { message: err.message, code: err.code, ...err.extra })
      return true
    }
    throw err
  }
}
