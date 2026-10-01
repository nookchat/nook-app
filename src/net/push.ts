import { defaultServer, serverUrl } from '../backend'
import { health } from './server-api'
import { fromBase64Url, toBase64Url } from '../bytes'
import { mentionsMe } from '../chat'
import type { SpaceRuntime } from '../space/runtime'
import { shortKey } from '../store/identity'
import { cleanChannel, DEFAULT_CHANNEL, type LogEvent, type PushTarget } from '../store/log'
import { channelMutedItself, MUTED_CHANGED, spaceMuted } from '../store/mute'
import { stable } from '../store/server-spaces'
import { doNotDisturb, STATUS_CHANGED } from '../store/status'
import { NOTIFY_CHANGED, notifyState, notifyText, notifyWhat } from '../ui/notify'

/**
 * Notifications while Nook is closed. Each device that has notifications on subscribes with
 * its browser's push service, and says where in each space it is in, in the log, so only the
 * people in the space learn it. Whoever sends a message seals the notification for the
 * other person's browser, and a server passes it on to the push service without reading it.
 * Somebody online in the space gets none: their open page shows its own.
 */

const DEVICE_KEY = 'nook.push.device.v1'
const VIA_KEY = 'nook.push.via.v1'
const SYNC_WAIT_MS = 1500
const MAX_BODY_CHARS = 300
const PUSH_TTL_S = 24 * 60 * 60

const enc = new TextEncoder()

interface Subscription {
  endpoint: string
  p256dh: string
  auth: string
  via: string
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage blocked */
  }
}

/** This device's own id in every space, so a new push address takes the place of the old one. */
function deviceId(): string {
  let id = read(DEVICE_KEY)
  if (!/^[0-9a-f]{16}$/.test(id)) {
    id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
    write(DEVICE_KEY, id)
  }
  return id
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext
}

async function serverKey(server: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(`${server}/api/v1/push`, { mode: 'cors', signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const body = (await res.json()) as { key?: unknown }
    return typeof body.key === 'string' && /^[A-Za-z0-9_-]{87}$/.test(body.key) ? fromBase64Url(body.key) : null
  } catch {
    return null
  }
}

const same = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean =>
  !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i])

/** This browser's push subscription, made with the key of a server that takes pushes. */
async function subscribe(servers: string[]): Promise<Subscription | null> {
  if (!supported() || notifyState() !== 'on') return null
  const reg = await navigator.serviceWorker.ready
  const kept = serverUrl(read(VIA_KEY))
  for (const via of [...new Set([kept, defaultServer(), ...servers].filter(Boolean))]) {
    const key = await serverKey(via)
    if (!key) continue
    try {
      let sub = await reg.pushManager.getSubscription()
      if (sub && !same(sub.options.applicationServerKey, key)) {
        await sub.unsubscribe()
        sub = null
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource })
      const json = sub.toJSON()
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return null
      write(VIA_KEY, via)
      return { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, via }
    } catch (err) {
      // The desktop app, and some browsers, have no push service.
      console.info('[nook] no push for this browser', err)
      return null
    }
  }
  return null
}

function ours(space: SpaceRuntime): PushTarget | undefined {
  return space.chat.log.pushTargets().get(space.chat.me)?.find((t) => t.id === deviceId())
}

/** What this device should have said in this space, or null for nothing at all. */
function wanted(space: SpaceRuntime, sub: Subscription | null): Record<string, unknown> | null {
  const id = deviceId()
  if (!sub) return ours(space) ? { id, gone: true } : null
  const room = space.room.id
  const mute = space.chat.channels().filter((c) => channelMutedItself(room, c))
  return {
    id,
    endpoint: sub.endpoint,
    p256dh: sub.p256dh,
    auth: sub.auth,
    via: sub.via,
    what: notifyWhat(),
    text: notifyText(),
    muted: spaceMuted(room),
    mute,
    dnd: doNotDisturb(),
  }
}

function sameAsLog(space: SpaceRuntime, body: Record<string, unknown>): boolean {
  const had = ours(space)
  if (!had) return false
  const { person: _person, ...rest } = had
  return stable(rest) === stable(body)
}

let timer = 0
let running: Promise<void> = Promise.resolve()

/** Brings what each space has on this device's push address up to date. */
export function syncPush(all: () => SpaceRuntime[]): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    running = running.then(() => syncNow(all())).catch((err) => console.warn('[nook] push was not set up', err))
  }, SYNC_WAIT_MS)
}

async function syncNow(spaces: SpaceRuntime[]): Promise<void> {
  if (!supported()) return
  const ready = []
  for (const space of spaces) {
    await space.ready.catch(() => undefined)
    // Once its history is in, so it knows what this device said before.
    if (space.chat && space.channel) {
      await space.channel.loaded
      ready.push(space)
    }
  }
  if (ready.length === 0) return
  const sub = await subscribe(ready.map((s) => s.server))
  for (const space of ready) {
    if (space.chat.isClosed || space.chat.authority().isKicked(space.chat.me)) continue
    const body = wanted(space, sub)
    if (body && !sameAsLog(space, body)) await space.chat.setPushTarget(body)
  }
}

/** A log out: each space hears this device takes no more notifications, and the browser drops its address. */
export async function forgetPush(spaces: SpaceRuntime[]): Promise<void> {
  if (!supported()) return
  for (const space of spaces) {
    if (!space.chat || space.chat.isClosed || !ours(space)) continue
    await space.chat.setPushTarget({ id: deviceId(), gone: true }).catch(() => undefined)
  }
  const reg = await navigator.serviceWorker.getRegistration()
  await (await reg?.pushManager.getSubscription())?.unsubscribe()
}

/** Keeps each space told, as notifications, mutes and spaces come and go. */
export function watchPush(all: () => SpaceRuntime[], roomsChanged: string): void {
  const again = (): void => syncPush(all)
  window.addEventListener(NOTIFY_CHANGED, again)
  window.addEventListener(MUTED_CHANGED, again)
  window.addEventListener(STATUS_CHANGED, again)
  window.addEventListener(roomsChanged, again)
  again()
}

// RFC 8291: a message sealed for one browser, with its key and auth secret, as aes128gcm.
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    bytes * 8,
  )
  return new Uint8Array(bits)
}

const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export async function sealPush(target: { p256dh: string; auth: string }, message: unknown): Promise<string> {
  const theirs = fromBase64Url(target.p256dh)
  const secret = fromBase64Url(target.auth)
  const mine = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const minePublic = new Uint8Array(await crypto.subtle.exportKey('raw', mine.publicKey))
  const theirKey = await crypto.subtle.importKey('raw', theirs as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirKey }, mine.privateKey, 256))
  const ikm = await hkdf(secret, shared, join(enc.encode('WebPush: info\0'), theirs, minePublic), 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt'])
  // One record, so its padding delimiter is 2.
  const plain = join(enc.encode(JSON.stringify(message)), new Uint8Array([2]))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aes, plain as BufferSource))
  const head = new Uint8Array(21)
  head.set(salt, 0)
  new DataView(head.buffer).setUint32(16, 4096)
  head[20] = minePublic.length
  return toBase64Url(join(head, minePublic, sealed))
}

const relays = new Map<string, Promise<boolean>>()

/** Whether this server hands a push on to another: then the other never sees who wrote. */
function askRelay(server: string): Promise<boolean> {
  let held = relays.get(server)
  if (!held) {
    held = health(server).then((h) => h.pushRelay === true)
    relays.set(server, held)
  }
  return held
}

/**
 * The person's device names the server it takes pushes through, which any member can set. So
 * the push goes through the space's own server when that server hands it on: the one they named
 * sees that server, not this device's address. An older server does not, and gets it straight.
 */
async function send(target: PushTarget, message: unknown, tag: string, server: string): Promise<void> {
  try {
    const body = await sealPush(target, message)
    const push = { endpoint: target.endpoint, body, ttl: PUSH_TTL_S, urgency: 'high', topic: tag.slice(0, 32) }
    const own = serverUrl(server)
    const through = own && serverUrl(target.via) !== own && (await askRelay(own)) ? own : target.via
    await fetch(`${through}/api/v1/push`, {
      method: 'POST',
      mode: 'cors',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(through === target.via ? push : { ...push, via: target.via }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    /* their push server is down: they read it when they next open Nook */
  }
}

/**
 * After this device writes a message: a notification for each person it is for who has no
 * Nook open. Mentions and direct messages, or every message for whoever asked for that.
 */
export function pushAbout(space: SpaceRuntime, event: LogEvent): void {
  if (event.kind !== 'said' && event.kind !== 'dm') return
  // A direct message's words are known here only once it is sealed and kept.
  window.setTimeout(() => void pushNow(space, event), 0)
}

async function pushNow(space: SpaceRuntime, event: LogEvent): Promise<void> {
  const chat = space.chat
  const targets = chat.log.pushTargets()
  if (targets.size === 0) return
  const online = new Set((space.mesh?.peers() ?? []).map((p) => p.key))
  const who = chat.nameOf(chat.me) || chat.displayName || shortKey(chat.me)
  const spaceName = chat.spaceName() || 'a space'
  const files = Array.isArray(event.body.files) && event.body.files.length > 0
  const names = chat.log.names()
  const tag = event.id.slice(0, 32)
  const jobs: Promise<void>[] = []

  if (event.kind === 'dm') {
    const to = String(event.body.to ?? '')
    if (!to || to === chat.me || online.has(to)) return
    const text = chat.directText(event.id) || (typeof event.body.fbox === 'string' ? 'Sent you a file' : '')
    for (const target of targets.get(to) ?? []) {
      if (target.dnd) continue
      const body = target.text ? text || 'Sent you a message' : 'Sent you a message'
      jobs.push(send(target, { t: who, b: body.slice(0, MAX_BODY_CHARS), tag, room: space.room.id, dm: chat.me }, tag, space.server))
    }
    await Promise.all(jobs)
    return
  }

  const channel = cleanChannel(String(event.body.channel ?? '')) || DEFAULT_CHANNEL
  const text = String(event.body.text ?? '')
  for (const [person, devices] of targets) {
    if (person === chat.me || online.has(person) || !chat.mayEnter(person, channel)) continue
    const mention = mentionsMe(text, names, person)
    for (const target of devices) {
      if (target.muted || target.dnd || target.mute.includes(channel)) continue
      if (!mention && target.what !== 'all') continue
      const said = text || (files ? 'Sent a file' : '')
      const body = target.text && said ? said : mention ? 'Mentioned you' : 'Sent a message'
      const message = { t: `${who} (#${channel}, ${spaceName})`, b: body.slice(0, MAX_BODY_CHARS), tag, room: space.room.id, ch: channel }
      jobs.push(send(target, message, tag, space.server))
    }
  }
  await Promise.all(jobs)
}
