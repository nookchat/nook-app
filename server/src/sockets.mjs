/**
 * WebSockets: a space's one connection, and the old bare relay.
 *
 *   /api/v1/spaces/:room/socket   a space on this server (also at /room/:room)
 *   /relay/:room                  frames passed on unread, for a peer to peer
 *                                 space that uses this server as its archive
 *
 * WebSocket by hand: the whole protocol this needs is a frame reader and a
 * frame writer, and every frame is text that fits in one frame.
 *
 * A space's socket speaks JSON, one message per frame:
 *
 *   in    hello {from}         everything after line `from`, page by page, then live
 *         get {from}           the same, without the live at the end
 *         put {id, lines, w}   keep these lines; `w` is the space's write token
 *         sig {d}              a sealed signal for everybody else, not kept
 *
 *   out   page {at, lines, more}   history
 *         live {at}                history done; from here on lines arrive as ev
 *         ev {at, lines}           lines somebody else wrote, or another server sent
 *         ack {id, at}             the put was kept
 *         nack {id, code, message} the put was refused
 *         sig {d}
 *
 * `at` is always the number of the newest line the message took the reader
 * to, and a reader keeps the highest it has seen: after a dropped connection,
 * hello from there is everything it missed.
 */

import { createHash } from 'node:crypto'
import { MAX_ROOM_SOCKETS, originAllowed } from './config.mjs'
import { append, kept, MAX_LINE, mayWrite, newest, ROOM, since } from './store.mjs'

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** A batch of writes is the biggest thing a device sends on a space's socket. */
const MAX_FRAME = 1024 * 1024
/** The bare relay only ever carries handshakes, which are small. */
const MAX_RELAY_FRAME = 128 * 1024
const MAX_SIGNAL = 512 * 1024
const PING_MS = 30_000

/** room -> sockets, one map per kind. */
const spaces = new Map()
const relays = new Map()

export function wsFrame(opcode, payload) {
  const len = payload.length
  let head
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len])
  } else if (len < 65_536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, payload])
}

const text = (message) => wsFrame(1, Buffer.from(JSON.stringify(message)))

function leave(rooms, room, socket) {
  const standing = rooms.get(room)
  if (!standing) return
  standing.delete(socket)
  if (standing.size === 0) rooms.delete(room)
}

/** Take an upgrade and hand every text frame after it to `onText`. */
function open(req, socket, rooms, room, onText, maxFrame = MAX_FRAME) {
  const key = req.headers['sec-websocket-key']
  const standing = rooms.get(room) ?? new Set()
  if (standing.size >= MAX_ROOM_SOCKETS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
    socket.destroy()
    return
  }
  const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.setNoDelay(true)
  standing.add(socket)
  rooms.set(room, standing)
  socket.cathodeAlive = true

  const goodbye = (code) => {
    try {
      const reason = Buffer.alloc(2)
      reason.writeUInt16BE(code, 0)
      socket.write(wsFrame(8, reason))
    } catch {
      /* it was already gone */
    }
    leave(rooms, room, socket)
    socket.destroy()
  }

  /*
   * A client frame is always masked, so an unmasked one is not a browser and
   * is shown the door, the way the RFC says. Fragmented frames are refused.
   */
  let held = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    held = held.length ? Buffer.concat([held, chunk]) : chunk
    for (;;) {
      if (held.length < 2) return
      const fin = (held[0] & 0x80) !== 0
      const opcode = held[0] & 0x0f
      const masked = (held[1] & 0x80) !== 0
      let len = held[1] & 0x7f
      let at = 2
      if (len === 126) {
        if (held.length < at + 2) return
        len = held.readUInt16BE(at)
        at += 2
      } else if (len === 127) {
        if (held.length < at + 8) return
        const big = held.readBigUInt64BE(at)
        if (big > BigInt(maxFrame)) return goodbye(1009)
        len = Number(big)
        at += 8
      }
      if (len > maxFrame) return goodbye(1009)
      if (!masked) return goodbye(1002)
      if (held.length < at + 4 + len) return
      const mask = held.subarray(at, at + 4)
      const payload = Buffer.from(held.subarray(at + 4, at + 4 + len))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      held = held.subarray(at + 4 + len)

      if (opcode === 8) return goodbye(1000)
      if (opcode === 9) {
        socket.write(wsFrame(10, payload))
        continue
      }
      if (opcode === 10) {
        socket.cathodeAlive = true
        continue
      }
      if (opcode !== 1 || !fin) return goodbye(1003)
      onText(payload)
    }
  })

  socket.on('close', () => leave(rooms, room, socket))
  socket.on('error', () => {
    leave(rooms, room, socket)
    socket.destroy()
  })
}

function send(socket, frame) {
  if (socket.destroyed) return
  /*
   * A socket still reading history holds live lines back until it is done,
   * so the lines it is told about arrive in order and the highest number it
   * has seen always means it has seen everything below.
   */
  if (socket.cathodeStreaming) socket.cathodeHeld.push(frame)
  else socket.write(frame)
}

/** Every page of history after a line, down one socket, then what arrived meanwhile. */
async function stream(room, socket, from, live) {
  socket.cathodeStreaming = true
  socket.cathodeHeld = []
  let cursor = from
  try {
    for (;;) {
      const page = await since(room, cursor)
      if (page.lines.length || !page.more) {
        socket.write(text({ t: 'page', at: page.at, lines: page.lines, more: page.more }))
      }
      cursor = page.at
      if (!page.more) break
    }
    if (live) socket.write(text({ t: 'live', at: Math.max(cursor, await newest(room)) }))
  } finally {
    socket.cathodeStreaming = false
    for (const frame of socket.cathodeHeld) if (!socket.destroyed) socket.write(frame)
    socket.cathodeHeld = []
  }
}

async function onSpace(room, socket, payload) {
  let message
  try {
    message = JSON.parse(payload.toString('utf8'))
  } catch {
    return
  }
  switch (message?.t) {
    case 'hello':
    case 'get': {
      const from = Math.max(0, Math.floor(Number(message.from)) || 0)
      await stream(room, socket, from, message.t === 'hello')
      return
    }
    case 'put': {
      const id = String(message.id ?? '').slice(0, 64)
      if (!(await mayWrite(room, message.w))) {
        send(socket, text({ t: 'nack', id, code: 'wrong_token', message: 'That is not the write token this space was claimed with.' }))
        return
      }
      const lines = (Array.isArray(message.lines) ? message.lines : []).filter(
        (e) => typeof e === 'string' && e.length > 0 && e.length <= MAX_LINE,
      )
      const fresh = await append(room, lines, '', socket)
      const at = fresh.length ? fresh[fresh.length - 1].seq : await newest(room)
      send(socket, text({ t: 'ack', id, at }))
      return
    }
    case 'sig': {
      if (typeof message.d !== 'string' || message.d.length > MAX_SIGNAL) return
      const frame = text({ t: 'sig', d: message.d })
      for (const other of spaces.get(room) ?? []) if (other !== socket) send(other, frame)
      return
    }
    default:
      return
  }
}

/* Every line kept, from a device or from another server, to everybody in the space but its writer. */
kept.on('lines', (room, rows, writer) => {
  const standing = spaces.get(room)
  if (!standing) return
  const frame = text({ t: 'ev', at: rows[rows.length - 1].seq, lines: rows.map((r) => r.body) })
  for (const socket of standing) if (socket !== writer) send(socket, frame)
})

export function upgrade(req, socket) {
  const path = (req.url ?? '').split('?')[0]
  const relay = /^\/relay\/([0-9a-f]{32})$/.exec(path)
  const space = /^\/api\/v1\/spaces\/([0-9a-f]{32})\/socket$/.exec(path) ?? /^\/room\/([0-9a-f]{32})$/.exec(path)
  const key = req.headers['sec-websocket-key']
  if ((!relay && !space) || typeof key !== 'string' || !/websocket/i.test(String(req.headers.upgrade ?? ''))) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }
  if (!originAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  if (relay) {
    const room = relay[1]
    open(
      req,
      socket,
      relays,
      room,
      (payload) => {
        const frame = wsFrame(1, payload)
        for (const other of relays.get(room) ?? []) if (other !== socket && !other.destroyed) other.write(frame)
      },
      MAX_RELAY_FRAME,
    )
    return
  }
  const room = space[1]
  if (!ROOM.test(room)) return
  // One message at a time per socket, so a page is never interleaved with an ack.
  let queue = Promise.resolve()
  open(req, socket, spaces, room, (payload) => {
    queue = queue.then(() => onSpace(room, socket, payload)).catch((err) => console.error('[cathode]', err))
  })
}

export function closeAll() {
  for (const standing of [...spaces.values(), ...relays.values()]) for (const s of standing) s.destroy()
}

/* One heartbeat for every socket. A socket that never answers a ping is a
   phone off the hook, and holding it open keeps a seat warm in the room. */
setInterval(() => {
  for (const standing of [...spaces.values(), ...relays.values()]) {
    for (const socket of standing) {
      if (!socket.cathodeAlive) {
        socket.destroy()
        continue
      }
      socket.cathodeAlive = false
      try {
        socket.write(wsFrame(9, Buffer.alloc(0)))
      } catch {
        socket.destroy()
      }
    }
  }
}, PING_MS).unref()
