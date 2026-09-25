// Plays a sealed file while it downloads. The page points a <video> at
// ./nook-stream/<token>; this worker asks the page what the token means, fetches
// only the sealed pieces the player asks for, opens them, and hands back the
// plain bytes as a range response. The layout matches sealPieces in
// src/net/files.ts: for each piece, a 12 byte IV and then the sealed piece with
// its 16 byte tag, with the piece's number and whether it is the last bound in.

const IV_BYTES = 12
const TAG_BYTES = 16
const MARK = '/nook-stream/'
const ASK_TIMEOUT_MS = 5000

/** token -> { info, key } */
const known = new Map()

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (ev) => ev.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url)
  if (url.origin !== self.location.origin || !url.pathname.includes(MARK) || ev.request.method !== 'GET') return
  const token = url.pathname.slice(url.pathname.lastIndexOf(MARK) + MARK.length)
  ev.respondWith(serve(ev, token).catch(() => new Response('That file could not be opened.', { status: 502 })))
})

function ask(client, token) {
  return new Promise((ok) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => ok(null), ASK_TIMEOUT_MS)
    channel.port1.onmessage = (ev) => {
      clearTimeout(timer)
      ok(ev.data ?? null)
    }
    client.postMessage({ type: 'nook-stream', token }, [channel.port2])
  })
}

async function lookUp(ev, token) {
  const had = known.get(token)
  if (had) return had
  const first = ev.clientId ? await self.clients.get(ev.clientId) : null
  const others = await self.clients.matchAll({ type: 'window' })
  for (const client of [first, ...others.filter((c) => c !== first)]) {
    if (!client) continue
    const info = await ask(client, token)
    if (!info) continue
    const raw = Uint8Array.from(atob(info.key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
    const found = { info, key }
    known.set(token, found)
    return found
  }
  return null
}

function label(index, last) {
  const out = new Uint8Array(5)
  new DataView(out.buffer).setUint32(0, index)
  out[4] = last ? 1 : 0
  return out
}

function pieces(info) {
  return Math.max(1, Math.ceil(info.size / info.chunk))
}

function plainOf(info, index) {
  return index < pieces(info) - 1 ? info.chunk : info.size - index * info.chunk
}

function sealedAt(info, index) {
  return index * (IV_BYTES + info.chunk + TAG_BYTES)
}

async function serve(ev, token) {
  const found = await lookUp(ev, token)
  if (!found) return new Response('Unknown file.', { status: 404 })
  const { info, key } = found
  const size = info.size

  const asked = /^bytes=(\d*)-(\d*)$/.exec(ev.request.headers.get('range') ?? '')
  let start = 0
  let end = size - 1
  if (asked && (asked[1] || asked[2])) {
    if (asked[1]) {
      start = Number(asked[1])
      if (asked[2]) end = Math.min(Number(asked[2]), size - 1)
    } else {
      start = Math.max(0, size - Number(asked[2]))
    }
  }
  const headers = { 'content-type': info.type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' }
  if (size === 0 || start >= size || end < start) {
    return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } })
  }

  const first = Math.floor(start / info.chunk)
  const last = Math.floor(end / info.chunk)
  const body = await piecesStream(info, key, first, last, start, end)
  return new Response(body, {
    status: asked ? 206 : 200,
    headers: {
      ...headers,
      'content-length': String(end - start + 1),
      ...(asked ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    },
  })
}

async function fetchSealed(info, from, to) {
  let last = null
  for (const url of info.urls) {
    try {
      const res = await fetch(url, { mode: 'cors', headers: { range: `bytes=${from}-${to}` } })
      if (res.status === 206 && res.body) return { res, skip: 0 }
      // A server without ranges sends it all: read past what comes before.
      if (res.status === 200 && res.body) return { res, skip: from }
      last = new Error(`The server said ${res.status}.`)
    } catch (err) {
      last = err
    }
  }
  throw last ?? new Error('No server had that file.')
}

// Opened pieces, shared by every request for the same file, so the jumps a
// player makes to find its index do not fetch the same bytes twice.
const CACHE_BYTES = 96 * 1024 * 1024
/** `${id}:${index}` -> { promise, bytes } in the order they were used */
const cache = new Map()
let cachedBytes = 0

function remember(name, entry) {
  cache.set(name, entry)
  while (cachedBytes > CACHE_BYTES && cache.size > 1) {
    const [oldName, old] = cache.entries().next().value
    if (oldName === name) break
    cache.delete(oldName)
    cachedBytes -= old.bytes
  }
}

/** Pieces fetched in one go: enough to play on, not the whole rest of the file. */
function windowOf(info) {
  return Math.max(2, Math.floor((2 * 1024 * 1024) / info.chunk))
}

/** Starts fetching from piece `first`, up to a window's worth, skipping what is held. */
function fetchWindow(info, key, first) {
  const total = pieces(info)
  let last = first
  while (last + 1 < total && last + 1 < first + windowOf(info) && !cache.has(`${info.id}:${last + 1}`)) last++

  const waiting = []
  for (let i = first; i <= last; i++) {
    let settle
    const promise = new Promise((ok, fail) => (settle = { ok, fail }))
    promise.catch(() => undefined)
    const entry = { promise, bytes: 0 }
    remember(`${info.id}:${i}`, entry)
    waiting.push({ index: i, settle, entry })
  }

  void (async () => {
    try {
      const from = sealedAt(info, first)
      const to = sealedAt(info, last) + IV_BYTES + plainOf(info, last) + TAG_BYTES - 1
      const { res, skip } = await fetchSealed(info, from, to)
      const reader = res.body.getReader()
      let held = new Uint8Array(0)
      let toSkip = skip
      for (const wait of waiting) {
        const need = IV_BYTES + plainOf(info, wait.index) + TAG_BYTES
        while (held.length < need) {
          const { done, value } = await reader.read()
          if (done) throw new Error('The file arrived cut short.')
          let chunk = value
          if (toSkip > 0) {
            const drop = Math.min(toSkip, chunk.length)
            toSkip -= drop
            chunk = chunk.subarray(drop)
          }
          if (!chunk.length) continue
          const joined = new Uint8Array(held.length + chunk.length)
          joined.set(held)
          joined.set(chunk, held.length)
          held = joined
        }
        const sealed = held.subarray(0, need)
        held = held.slice(need)
        const opened = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: sealed.subarray(0, IV_BYTES), additionalData: label(wait.index, wait.index === total - 1) },
            key,
            sealed.subarray(IV_BYTES),
          ),
        )
        wait.entry.bytes = opened.length
        // Counted only while held: one dropped while it was on its way never counted.
        if (cache.get(`${info.id}:${wait.index}`) === wait.entry) cachedBytes += opened.length
        wait.settle.ok(opened)
      }
      reader.cancel().catch(() => undefined)
    } catch (err) {
      for (const wait of waiting) {
        if (cache.get(`${info.id}:${wait.index}`) === wait.entry && wait.entry.bytes === 0) cache.delete(`${info.id}:${wait.index}`)
        wait.settle.fail(err)
      }
    }
  })()
}

function piece(info, key, index) {
  const name = `${info.id}:${index}`
  let entry = cache.get(name)
  if (!entry) {
    fetchWindow(info, key, index)
    entry = cache.get(name)
  } else {
    // Used again: move it to the back, so it is the last to go.
    cache.delete(name)
    cache.set(name, entry)
  }
  return entry.promise
}

async function piecesStream(info, key, first, last, start, end) {
  const total = pieces(info)
  let index = first
  // The first piece is waited for here, so a failure is a failed response, not a broken body.
  await piece(info, key, first)
  return new ReadableStream({
    async pull(controller) {
      if (index > last) {
        controller.close()
        return
      }
      const opened = await piece(info, key, index)
      // Read ahead while this one is played.
      const ahead = index + Math.ceil(windowOf(info) / 2)
      if (ahead <= last && ahead < total && !cache.has(`${info.id}:${ahead}`)) piece(info, key, ahead)
      const base = index * info.chunk
      const lo = Math.max(0, start - base)
      const hi = Math.min(opened.length, end - base + 1)
      controller.enqueue(opened.subarray(lo, hi))
      index++
    },
  })
}
