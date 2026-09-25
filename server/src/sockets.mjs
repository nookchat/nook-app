import { createHash } from 'node:crypto'
import { MAX_ROOM_SOCKETS, originAllowed } from './config.mjs'
import { emitLive } from './live.mjs'
import { append, kept, MAX_LINE, mayWrite, newest, ROOM, since } from './store.mjs'

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME = 1024 * 1024
const MAX_SIGNAL = 512 * 1024
const MAX_ROOMS_PER_SOCKET = 500
// A peer that dies silently is dropped within two pings.
const PING_MS = 10_000
const SESSION_ID = /^[0-9a-f]{1,32}$/

const roomMembers = new Map()
const sockets = new Set()
const remoteSessions = new Map()

export function localStates() {
  const out = []
  for (const [room, members] of roomMembers) {
    for (const member of members) if (member.state) out.push({ room, kind: 'state', id: member.state.id, d: member.state.d })
  }
  return out
}

function wsFrame(opcode, payload) {
  const text = typeof payload === 'string'
  const len = text ? Buffer.byteLength(payload) : payload.length
  const at = len < 126 ? 2 : len < 65_536 ? 4 : 10
  const frame = Buffer.allocUnsafe(at + len)
  frame[0] = 0x80 | opcode
  if (at === 2) {
    frame[1] = len
  } else if (at === 4) {
    frame[1] = 126
    frame.writeUInt16BE(len, 2)
  } else {
    frame[1] = 127
    frame.writeBigUInt64BE(BigInt(len), 2)
  }
  if (text) frame.write(payload, at)
  else payload.copy(frame, at)
  return frame
}

const PING = wsFrame(9, Buffer.alloc(0))

const textFrame = (message) => wsFrame(1, JSON.stringify(message))

function roomFrames(room, message) {
  let single
  let many
  return (member) => (member.single ? (single ??= textFrame(message)) : (many ??= textFrame({ ...message, room })))
}

function send(member, frame, live = true) {
  const { socket } = member
  if (socket.destroyed) return
  if (live && member.streaming) member.held.push(frame)
  else socket.write(frame)
}

function deliver(member, message, live = true) {
  send(member, textFrame(member.single ? message : { ...message, room: member.room }), live)
}

function toRoom(room, message, except = null) {
  const members = roomMembers.get(room)
  if (!members) return
  const frameFor = roomFrames(room, message)
  for (const member of members) if (member !== except) send(member, frameFor(member))
}

export function fromPeerLive(peer, event) {
  if (typeof event?.room !== 'string' || !ROOM.test(event.room)) return
  if (event.kind === 'sig' && typeof event.d === 'string') {
    toRoom(event.room, { t: 'sig', d: event.d })
    return
  }
  if (typeof event.id !== 'string' || !SESSION_ID.test(event.id)) return
  const key = `${peer}|${event.id}`
  if (event.kind === 'state' && typeof event.d === 'string') {
    let sessions = remoteSessions.get(event.room)
    if (!sessions) remoteSessions.set(event.room, (sessions = new Map()))
    sessions.set(key, { peer, id: event.id, d: event.d })
    toRoom(event.room, { t: 'sig', d: event.d })
  } else if (event.kind === 'left') {
    const sessions = remoteSessions.get(event.room)
    if (!sessions) return
    if (sessions.delete(key)) toRoom(event.room, { t: 'left', id: event.id })
    if (sessions.size === 0) remoteSessions.delete(event.room)
  }
}

export function peerGone(peer) {
  for (const [room, sessions] of remoteSessions) {
    for (const [key, session] of sessions) {
      if (session.peer !== peer) continue
      sessions.delete(key)
      toRoom(room, { t: 'left', id: session.id })
    }
    if (sessions.size === 0) remoteSessions.delete(room)
  }
}

function join(socket, room, single) {
  let member = socket.cathodeRooms.get(room)
  if (member) return member
  let members = roomMembers.get(room)
  if (members?.size >= MAX_ROOM_SOCKETS || socket.cathodeRooms.size >= MAX_ROOMS_PER_SOCKET) return null
  if (!members) roomMembers.set(room, (members = new Set()))
  member = { socket, room, single, state: null, streaming: false, held: [] }
  members.add(member)
  socket.cathodeRooms.set(room, member)
  return member
}

function part(member) {
  const members = roomMembers.get(member.room)
  members?.delete(member)
  if (members?.size === 0) roomMembers.delete(member.room)
  member.socket.cathodeRooms.delete(member.room)
  if (!member.state) return
  toRoom(member.room, { t: 'left', id: member.state.id })
  emitLive({ room: member.room, kind: 'left', id: member.state.id })
}

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
      for (const other of roomMembers.get(member.room) ?? []) {
        if (other !== member && other.state) deliver(member, { t: 'sig', d: other.state.d }, false)
      }
      for (const session of remoteSessions.get(member.room)?.values() ?? []) {
        deliver(member, { t: 'sig', d: session.d }, false)
      }
      deliver(member, { t: 'live', at: Math.max(cursor, await newest(member.room)) }, false)
    }
  } finally {
    member.streaming = false
    for (const frame of member.held) if (!member.socket.destroyed) member.socket.write(frame)
    member.held = []
  }
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
    socket.write(textFrame(isSingle ? refusal : { ...refusal, room }))
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
      toRoom(room, { t: 'sig', d: message.d }, member)
      emitLive({ room, kind: 'sig', d: message.d })
      return
    }
    case 'state': {
      if (typeof message.d !== 'string' || message.d.length > MAX_SIGNAL) return
      if (typeof message.id !== 'string' || !SESSION_ID.test(message.id)) return
      member.state = { id: message.id, d: message.d }
      toRoom(room, { t: 'sig', d: message.d }, member)
      emitLive({ room, kind: 'state', id: message.id, d: message.d })
      return
    }
    default:
      return
  }
}

kept.on('lines', (room, rows, writer) => {
  if (!roomMembers.has(room)) return
  toRoom(room, { t: 'ev', at: rows[rows.length - 1].seq, lines: rows.map((r) => r.body) }, writer)
})

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
    for (const member of socket.cathodeRooms.values()) part(member)
  }
  const goodbye = (code) => {
    try {
      const reason = Buffer.alloc(2)
      reason.writeUInt16BE(code, 0)
      socket.write(wsFrame(8, reason))
    } catch {
      /* already gone */
    }
    away()
    socket.destroy()
  }

  // One message at a time per connection, so a page is never interleaved with an ack.
  let queue = Promise.resolve()

  // RFC 6455: a client frame is always masked. Fragmented frames are refused.
  let held = Buffer.alloc(0)
  let pending = []
  let pendingBytes = 0
  let need = 2
  socket.on('data', (chunk) => {
    pending.push(chunk)
    pendingBytes += chunk.length
    if (held.length + pendingBytes < need) return
    held = held.length === 0 && pending.length === 1 ? chunk : Buffer.concat([held, ...pending])
    pending = []
    pendingBytes = 0
    for (;;) {
      need = 2
      if (held.length < need) return
      const fin = (held[0] & 0x80) !== 0
      const opcode = held[0] & 0x0f
      const masked = (held[1] & 0x80) !== 0
      let len = held[1] & 0x7f
      let at = 2
      if (len === 126) {
        need = at + 2
        if (held.length < need) return
        len = held.readUInt16BE(at)
        at += 2
      } else if (len === 127) {
        need = at + 8
        if (held.length < need) return
        const big = held.readBigUInt64BE(at)
        if (big > BigInt(MAX_FRAME)) return goodbye(1009)
        len = Number(big)
        at += 8
      }
      if (len > MAX_FRAME) return goodbye(1009)
      if (!masked) return goodbye(1002)
      need = at + 4 + len
      if (held.length < need) return
      const mask = held.subarray(at, at + 4)
      const payload = held.subarray(at + 4, need)
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      held = held.subarray(need)

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

setInterval(() => {
  for (const socket of sockets) {
    if (!socket.cathodeAlive) {
      socket.destroy()
      continue
    }
    socket.cathodeAlive = false
    try {
      socket.write(PING)
    } catch {
      socket.destroy()
    }
  }
}, PING_MS).unref()
