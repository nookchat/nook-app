/**
 * WebSockets: one connection per device, carrying every space it is in.
 *
 *   /api/v1/socket                   many spaces, each message names its room
 *   /api/v1/spaces/:room/socket      one space, and messages leave the room out
 *
 * A device is in several spaces at once, and wants to hear about all of them:
 * a direct message in one, a mention in another, somebody arriving in a
 * third. So it opens one connection to the server and joins each space on it,
 * rather than one connection per space.
 *
 * WebSocket by hand: the whole protocol this needs is a frame reader and a
 * frame writer, and every frame is text that fits in one frame.
 *
 * JSON, one message per frame. `room` is on every message on /api/v1/socket.
 *
 *   in    hello {room, from}        join; everything after line `from`, then live
 *         leave {room}              stop hearing about a space
 *         get {room, from}          history again, without the live at the end
 *         put {room, id, lines, w}  keep these lines; `w` is the space's write token
 *         sig {room, d}             a sealed signal for everybody else, not kept
 *         state {room, id, d}       this session's sealed presence: kept while it
 *                                   is joined, handed to whoever arrives, and
 *                                   followed by left {id} when it goes
 *
 *   out   page {room, at, lines, more}   history
 *         live {room, at}                history done; lines arrive as ev from here
 *         ev {room, at, lines}           lines somebody else wrote, or a peer sent
 *         ack {room, id, at}             the put was kept
 *         nack {room, id, code, message} the put was refused
 *         sig {room, d}                  somebody's signal or presence
 *         left {room, id}                a session went
 *
 * Nothing is sent on a timer except the heartbeat. Presence goes out when it
 * changes, the server holds the latest, and says left the moment a session
 * leaves, closes, or stops answering.
 *
 * `at` is the number of the newest line a message brings the reader to. The
 * lines of a space are sent in order, so a reader that keeps the highest `at`
 * it has seen can say hello from there after a dropped connection and miss
 * nothing.
 */

import { createHash } from 'node:crypto'
import { MAX_ROOM_SOCKETS, originAllowed } from './config.mjs'
import { emitLive } from './live.mjs'
import { append, kept, MAX_LINE, mayWrite, newest, ROOM, since } from './store.mjs'

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** A batch of writes is the biggest thing a device sends. */
const MAX_FRAME = 1024 * 1024
const MAX_SIGNAL = 512 * 1024
/** Spaces one connection may be in at once. */
const MAX_JOINED = 500
/*
 * A tab that closes says so, and is gone for everybody at once. One that
 * dies without a word (a laptop lid, a dropped network) is only found by
 * this, within two of them, so it is short enough that nobody is shown as
 * here for long after they went. A ping is two bytes.
 */
const PING_MS = 10_000

/*
 * Who is in each space: room -> the memberships in it. A membership is one
 * connection in one space, with that session's presence and its place in the
 * history it is being sent.
 */
const rooms = new Map()
const sockets = new Set()

/*
 * The presence of sessions on the other servers of the cluster, by room, so
 * somebody arriving here is told who is there as well as who is here. Kept
 * per server they came from, so a server that goes quiet takes its sessions
 * with it. See live.mjs.
 */
const remote = new Map()

/** Everybody here, as each last said it, for a server that is starting to read. */
export function localStates() {
  const out = []
  for (const [room, standing] of rooms) {
    for (const member of standing) if (member.state) out.push({ room, kind: 'state', id: member.state.id, d: member.state.d })
  }
  return out
}

function toRoom(room, message) {
  for (const member of rooms.get(room) ?? []) deliver(member, message)
}

/** Something said on another server of the cluster, for the devices here. */
export function fromPeerLive(peer, event) {
  if (typeof event?.room !== 'string' || !ROOM.test(event.room)) return
  if (event.kind === 'sig' && typeof event.d === 'string') {
    toRoom(event.room, { t: 'sig', d: event.d })
    return
  }
  if (typeof event.id !== 'string' || !/^[0-9a-f]{1,32}$/.test(event.id)) return
  const held = remote.get(event.room) ?? new Map()
  const key = `${peer}|${event.id}`
  if (event.kind === 'state' && typeof event.d === 'string') {
    held.set(key, { peer, id: event.id, d: event.d })
    remote.set(event.room, held)
    toRoom(event.room, { t: 'sig', d: event.d })
  } else if (event.kind === 'left') {
    if (held.delete(key)) toRoom(event.room, { t: 'left', id: event.id })
    if (held.size === 0) remote.delete(event.room)
  }
}

/** Another server went quiet, or started again: everybody on it is gone until it says otherwise. */
export function peerGone(peer) {
  for (const [room, held] of remote) {
    for (const [key, session] of held) {
      if (session.peer !== peer) continue
      held.delete(key)
      toRoom(room, { t: 'left', id: session.id })
    }
    if (held.size === 0) remote.delete(room)
  }
}

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

/** A message for one membership, with its room when the connection carries many. */
function frameFor(member, message) {
  const body = member.single ? message : { ...message, room: member.room }
  return wsFrame(1, Buffer.from(JSON.stringify(body)))
}

/** Send to one membership, holding live lines back while it is still reading history. */
function deliver(member, message, live = true) {
  const { socket } = member
  if (socket.destroyed) return
  const frame = frameFor(member, message)
  if (live && member.streaming) member.held.push(frame)
  else socket.write(frame)
}

function join(socket, room, single) {
  let member = socket.cathodeRooms.get(room)
  if (member) return member
  const standing = rooms.get(room) ?? new Set()
  if (standing.size >= MAX_ROOM_SOCKETS || socket.cathodeRooms.size >= MAX_JOINED) return null
  member = { socket, room, single, state: null, streaming: false, held: [] }
  standing.add(member)
  rooms.set(room, standing)
  socket.cathodeRooms.set(room, member)
  return member
}

/** A membership ends: everybody still in the space hears it at once. */
function part(member) {
  const standing = rooms.get(member.room)
  standing?.delete(member)
  if (standing && standing.size === 0) rooms.delete(member.room)
  member.socket.cathodeRooms.delete(member.room)
  if (!member.state) return
  for (const other of standing ?? []) deliver(other, { t: 'left', id: member.state.id })
  emitLive({ room: member.room, kind: 'left', id: member.state.id })
}

/** Every page of history after a line, down one membership, then what arrived meanwhile. */
async function stream(member, from, live) {
  member.streaming = true
  member.held = []
  let cursor = from
  try {
    for (;;) {
      const page = await since(member.room, cursor)
      if (page.lines.length || !page.more) {
        deliver(member, { t: 'page', at: page.at, lines: page.lines, more: page.more }, false)
      }
      cursor = page.at
      if (!page.more) break
    }
    if (live) {
      // Who else is here, as each of them last said it.
      for (const other of rooms.get(member.room) ?? []) {
        if (other !== member && other.state) deliver(member, { t: 'sig', d: other.state.d }, false)
      }
      // And who is on the other servers of the cluster.
      for (const session of remote.get(member.room)?.values() ?? []) deliver(member, { t: 'sig', d: session.d }, false)
      deliver(member, { t: 'live', at: Math.max(cursor, await newest(member.room)) }, false)
    }
  } finally {
    member.streaming = false
    for (const frame of member.held) if (!member.socket.destroyed) member.socket.write(frame)
    member.held = []
  }
}

function others(member, message) {
  for (const other of rooms.get(member.room) ?? []) if (other !== member) deliver(other, message)
}

async function onMessage(socket, single, payload) {
  let message
  try {
    message = JSON.parse(payload.toString('utf8'))
  } catch {
    return
  }
  const room = single ?? message?.room
  if (typeof room !== 'string' || !ROOM.test(room)) return
  const isSingle = single !== null

  if (message.t === 'leave') {
    const member = socket.cathodeRooms.get(room)
    if (member) part(member)
    return
  }

  const member = join(socket, room, isSingle)
  if (!member) {
    const refusal = { t: 'nack', code: 'full', message: 'Too many connections.' }
    socket.write(wsFrame(1, Buffer.from(JSON.stringify(isSingle ? refusal : { ...refusal, room }))))
    return
  }

  switch (message.t) {
    case 'hello':
    case 'get': {
      const from = Math.max(0, Math.floor(Number(message.from)) || 0)
      await stream(member, from, message.t === 'hello')
      return
    }
    case 'put': {
      const id = String(message.id ?? '').slice(0, 64)
      if (!(await mayWrite(room, message.w))) {
        deliver(member, { t: 'nack', id, code: 'wrong_token', message: 'That is not the write token this space was claimed with.' })
        return
      }
      const lines = (Array.isArray(message.lines) ? message.lines : []).filter(
        (e) => typeof e === 'string' && e.length > 0 && e.length <= MAX_LINE,
      )
      const fresh = await append(room, lines, '', member)
      const at = fresh.length ? fresh[fresh.length - 1].seq : await newest(room)
      deliver(member, { t: 'ack', id, at })
      return
    }
    case 'sig': {
      if (typeof message.d !== 'string' || message.d.length > MAX_SIGNAL) return
      others(member, { t: 'sig', d: message.d })
      emitLive({ room, kind: 'sig', d: message.d })
      return
    }
    case 'state': {
      if (typeof message.d !== 'string' || message.d.length > MAX_SIGNAL) return
      if (typeof message.id !== 'string' || !/^[0-9a-f]{1,32}$/.test(message.id)) return
      // Sealed like everything else: this keeps it, and cannot read it.
      member.state = { id: message.id, d: message.d }
      others(member, { t: 'sig', d: message.d })
      emitLive({ room, kind: 'state', id: message.id, d: message.d })
      return
    }
    default:
      return
  }
}

/* Every line kept, from a device or from another server, to everybody in the space but its writer. */
kept.on('lines', (room, rows, writer) => {
  const standing = rooms.get(room)
  if (!standing) return
  const message = { t: 'ev', at: rows[rows.length - 1].seq, lines: rows.map((r) => r.body) }
  for (const member of standing) if (member !== writer) deliver(member, message)
})

/** Take an upgrade, and hand every text frame after it to onMessage. */
function open(req, socket, single) {
  const key = req.headers['sec-websocket-key']
  const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.setNoDelay(true)
  socket.cathodeAlive = true
  socket.cathodeRooms = new Map()
  sockets.add(socket)

  let gone = false
  const away = () => {
    if (gone) return
    gone = true
    sockets.delete(socket)
    for (const member of [...socket.cathodeRooms.values()]) part(member)
  }
  const goodbye = (code) => {
    try {
      const reason = Buffer.alloc(2)
      reason.writeUInt16BE(code, 0)
      socket.write(wsFrame(8, reason))
    } catch {
      /* it was already gone */
    }
    away()
    socket.destroy()
  }

  // One message at a time per connection, so a page is never interleaved with an ack.
  let queue = Promise.resolve()

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
        if (big > BigInt(MAX_FRAME)) return goodbye(1009)
        len = Number(big)
        at += 8
      }
      if (len > MAX_FRAME) return goodbye(1009)
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
      queue = queue.then(() => onMessage(socket, single, payload)).catch((err) => console.error('[cathode]', err))
    }
  })

  socket.on('close', away)
  socket.on('error', () => {
    away()
    socket.destroy()
  })
}

export function upgrade(req, socket) {
  const path = (req.url ?? '').split('?')[0]
  const many = path === '/api/v1/socket'
  const one = /^\/api\/v1\/spaces\/([0-9a-f]{32})\/socket$/.exec(path)
  const key = req.headers['sec-websocket-key']
  if ((!many && !one) || typeof key !== 'string' || !/websocket/i.test(String(req.headers.upgrade ?? ''))) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }
  if (!originAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  open(req, socket, one ? one[1] : null)
}

export function closeAll() {
  for (const socket of sockets) socket.destroy()
}

/* One heartbeat for every connection. One that never answers a ping is a
   phone off the hook, and holding it open keeps its seats warm. */
setInterval(() => {
  for (const socket of sockets) {
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
}, PING_MS).unref()
