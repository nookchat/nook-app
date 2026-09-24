/**
 * One room's chat: the log, and what is written to it and read from it.
 *
 * Everything a person does becomes an event, which is signed, written to this
 * device, and handed to whoever is connected. Everything that arrives is
 * verified, merged, and written down. Both directions go through here, so the
 * host and a viewer run identical code and differ only in who they are connected
 * to.
 */

import { mentionsMe } from '../chat'
import { loadIdentity, sharedKey } from './identity'
import { openEvents } from './verify-pool'
import {
  cleanChannel,
  cleanAvatar,
  DEFAULT_CHANNEL,
  makeEvent,
  MAX_DM_BYTES,
  MAX_TEXT,
  trimToBytes,
  trimToWire,
  oneEmoji,
  RoomLog,
  type ChannelInfo,
  type LogEvent,
  type ThreadInfo,
  type Message,
} from './log'

/** Base64, for the two byte strings a sealed message is made of. */
function b64(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return btoa(out)
}

function unb64(text: string): Uint8Array {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export interface Unread {
  count: number
  mentions: number
  /** The clock value of the newest one, which is the mark for reading them. */
  newest: number
}

export class RoomChat {
  readonly log: RoomLog
  readonly me: string
  onChange: (() => void) | null = null
  /**
   * Everything written here, on its way out to everybody else.
   *
   * This used to be the caller's job, and the caller forgot. Saying something
   * went through a publish helper that broadcast it; claiming the space, naming
   * it and announcing your own name called write directly and went no further
   * than this device. The symptom was that everybody else saw a key where your
   * name should be, because the profile event proving the name was yours never
   * left the room it was written in.
   *
   * So the send lives with the write. There is now one way out and no way to
   * write an event that nobody hears about.
   */
  onLocal: ((event: LogEvent) => void) | null = null

  private name: string
  /**
   * Private messages, opened.
   *
   * The log holds them sealed, because that is how they reach the person they
   * are for: they travel with everything else and every device stores them.
   * Opening one needs a key only two people can work out, so this map is what
   * this device can read, and it is built once as events arrive rather than on
   * every redraw, which would mean asking the browser to decrypt on a frame.
   */
  private readonly opened = new Map<string, string>()
  /** Told when a private message is opened, so the panel can draw it. */
  onDirect: (() => void) | null = null

  constructor(roomId: string, founder = '') {
    this.log = new RoomLog(roomId)
    this.log.founder = founder
    const id = loadIdentity()
    this.me = id.pubkey
    this.log.me = id.pubkey
    this.name = id.name
  }

  get displayName(): string {
    return this.name
  }

  channels(voice = false): string[] {
    return this.log.channels(voice)
  }

  messages(channel?: string): Message[] {
    const messages = this.log.messages(channel)
    const names = this.log.names()
    for (const m of messages) m.name = names.get(m.author) ?? m.name ?? ''
    return messages
  }

  nameOf(author: string): string {
    return this.log.names().get(author) ?? ''
  }

  avatarOf(author: string): string {
    return this.log.avatars().get(author) ?? ''
  }

  /** The channels with what an admin has said about them. */
  channelInfo(voice = false): ChannelInfo[] {
    return this.log.channelList(voice)
  }

  /**
   * What is waiting in each channel, and how much of it is addressed to you.
   *
   * Counted against a mark this device keeps per channel, in log clock rather
   * than wall clock: the mark has to mean the same thing as the ordering, or a
   * device with a fast clock marks tomorrow's messages read today.
   *
   * Nothing of your own is ever unread. Reading your own message is not a task.
   */
  unread(marks: Record<string, number>): Map<string, Unread> {
    const out = new Map<string, Unread>()
    const names = this.log.names()
    for (const m of this.log.messages()) {
      if (m.author === this.me) continue
      const mark = marks[m.channel] ?? 0
      if (m.lamport <= mark) continue
      const was = out.get(m.channel) ?? { count: 0, mentions: 0, newest: 0 }
      was.count += 1
      if (mentionsMe(m.text, names, this.me)) was.mentions += 1
      if (m.lamport > was.newest) was.newest = m.lamport
      out.set(m.channel, was)
    }
    return out
  }

  /** The newest thing in a channel, so reading it can be marked as read. */
  highWater(channel: string): number {
    let top = 0
    for (const m of this.log.messages()) {
      if (m.channel !== channel) continue
      if (m.lamport > top) top = m.lamport
    }
    return top
  }

  /**
   * Take the earliest claim to the space as the founder, once, and keep it.
   *
   * Only used when this device has no founder yet. Whoever made the space sets
   * it directly; whoever joins learns it from the first claim they sync.
   */
  private pinFounder(): void {
    if (this.log.founder) return
    const claim = this.log
      .all()
      .find((e) => e.kind === 'role' && e.body.subject === e.author && e.body.role === 'admin')
    if (claim) {
      this.log.founder = claim.author
      this.onFounder?.(claim.author)
    }
  }

  onFounder: ((pubkey: string) => void) | null = null

  get founder(): string {
    return this.log.founder
  }

  get myRole(): string {
    return this.log.roleOf(this.me)
  }

  get isAdmin(): boolean {
    return this.myRole === 'admin'
  }

  lastSeen(): Map<string, number> {
    return this.log.lastSeen()
  }

  roleOf(pubkey: string): string {
    return this.log.roleOf(pubkey)
  }

  roles(): Map<string, string> {
    return this.log.roles()
  }

  spaceName(): string {
    return this.log.spaceName()
  }

  /** True once an admin has shut this space down, here or anywhere else. */
  get isClosed(): boolean {
    return this.log.closed()
  }

  /** Claim the space. Only ever called by whoever made it. */
  async claimFounder(): Promise<LogEvent> {
    this.log.founder = this.me
    return this.write('role', { subject: this.me, role: 'admin' })
  }

  setSpaceName(name: string): Promise<LogEvent> {
    return this.write('space', { name: name.slice(0, 32).trim() })
  }

  setRole(subject: string, role: 'admin' | 'member' | 'kicked'): Promise<LogEvent> {
    return this.write('role', { subject, role })
  }

  // ---- writing ----

  private async write(
    kind:
      | 'said'
      | 'edit'
      | 'react'
      | 'retract'
      | 'profile'
      | 'channel'
      | 'role'
      | 'space'
      | 'pin'
      | 'poll'
      | 'vote'
      | 'reset'
      | 'close'
      | 'dm',
    body: Record<string, unknown>,
  ): Promise<LogEvent> {
    const event = await makeEvent(this.log.room, this.me, this.log.nextLamport(), kind, body)
    this.log.add(event)
    this.onLocal?.(event)
    this.onChange?.()
    return event
  }

  /**
   * Say something.
   *
   * `inThread` is the difference between answering somebody where everybody is
   * reading and answering them in the thread hanging off their message. It is
   * the writer's choice, carried on the event, so every device draws it in the
   * same place rather than guessing from the shape of the replies.
   */
  say(
    text: string,
    channel: string,
    replyTo?: string | null,
    inThread = false,
    emote = false,
  ): Promise<LogEvent> {
    const body: Record<string, unknown> = {
      // The composer stops a person here first and says so. This is the
      // backstop, for a message that arrived from anywhere else.
      text: trimToWire(text, MAX_TEXT),
      channel: cleanChannel(channel) || DEFAULT_CHANNEL,
    }
    if (replyTo) body.replyTo = replyTo
    if (replyTo && inThread) body.thread = true
    if (emote) body.emote = true
    return this.write('said', body)
  }

  /**
   * Say that a stream just started here.
   *
   * An emote, so it reads as something done rather than said, and marked
   * live so every panel can hang the way in off it while the screen is up.
   */
  sayLive(channel: string): Promise<LogEvent> {
    return this.write('said', {
      text: 'started sharing their screen',
      channel: cleanChannel(channel) || DEFAULT_CHANNEL,
      emote: true,
      live: true,
    })
  }

  /** Every thread here, the one that moved last at the top. */
  threads(): ThreadInfo[] {
    const threads = this.log.threads()
    const names = this.log.names()
    for (const t of threads) t.root.name = names.get(t.root.author) ?? t.root.name ?? ''
    return threads
  }

  /** One thread, root first. */
  threadOf(rootId: string): Message[] {
    const thread = this.log.thread(rootId)
    const names = this.log.names()
    for (const m of thread) m.name = names.get(m.author) ?? m.name ?? ''
    return thread
  }

  makeChannel(name: string, voice = false): Promise<LogEvent> {
    return this.write('channel', voice ? { name: cleanChannel(name), voice: true } : { name: cleanChannel(name) })
  }

  /** What a channel is called on screen. The name it routes by never moves. */
  labelChannel(name: string, label: string, voice = false): Promise<LogEvent> {
    const body: Record<string, unknown> = { name: cleanChannel(name), label: label.slice(0, 32).trim() }
    if (voice) body.voice = true
    return this.write('channel', body)
  }

  /** A line saying what a channel is for, or nothing. */
  setTopic(name: string, topic: string, voice = false): Promise<LogEvent> {
    const body: Record<string, unknown> = { name: cleanChannel(name), topic: topic.slice(0, 140).trim() }
    if (voice) body.voice = true
    return this.write('channel', body)
  }

  /** Take a channel away, and what was said in it with it. */
  dropChannel(name: string, voice = false): Promise<LogEvent> {
    const body: Record<string, unknown> = { name: cleanChannel(name), gone: true }
    if (voice) body.voice = true
    return this.write('channel', body)
  }

  edit(target: string, text: string): Promise<LogEvent> {
    return this.write('edit', { target, text: trimToWire(text, MAX_TEXT) })
  }

  /** One emoji goes on the wire, so what everybody stores is what was picked. */
  react(target: string, emoji: string, on: boolean): Promise<LogEvent> {
    return this.write('react', { target, emoji: oneEmoji(emoji), on })
  }

  retract(target: string): Promise<LogEvent> {
    return this.write('retract', { target })
  }

  /** Ask a question with a fixed set of answers. */
  askPoll(question: string, options: string[], channel: string): Promise<LogEvent> {
    return this.write('poll', {
      question: question.slice(0, 200),
      options: options.slice(0, 6),
      channel: cleanChannel(channel) || DEFAULT_CHANNEL,
    })
  }

  /** Pick one. Voting again moves your vote rather than adding another. */
  vote(target: string, choice: number): Promise<LogEvent> {
    return this.write('vote', { target, choice })
  }

  /**
   * Draw a line under everything said so far.
   *
   * The line is a lamport value, and the clock is derived from the wall clock,
   * so "now" is where it goes. Everything below it stops being shown on every
   * device that reads the log, and is thrown away the next time each of them
   * compacts.
   */
  reset(): Promise<LogEvent> {
    return this.write('reset', { before: this.log.nextLamport() })
  }

  /**
   * Shut the space down for everybody.
   *
   * Written like anything else, so it travels like anything else: to whoever is
   * connected now, and to whoever reads the space from the server later.
   * Every device that reads it forgets the space. See RoomLog.closed for what
   * that can and cannot reach.
   */
  closeSpace(): Promise<LogEvent> {
    return this.write('close', { at: Date.now() })
  }

  // ---- private messages ----

  /**
   * Say something to one person.
   *
   * Sealed with a key derived from the two identity keys, so the room carries
   * it and cannot read it. What the room can see is that you sent somebody
   * something, and how long it was. That is the honest limit of doing this
   * without a server: delivery rides on the log everybody already shares, and
   * the price is that the shape of the traffic is not hidden.
   */
  async sayDirect(to: string, text: string): Promise<LogEvent> {
    const key = await sharedKey(to)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        new TextEncoder().encode(trimToBytes(text, MAX_DM_BYTES)) as BufferSource,
      ),
    )
    const event = await this.write('dm', { to, iv: b64(iv), box: b64(sealed) })
    this.opened.set(event.id, trimToBytes(text, MAX_DM_BYTES))
    this.onDirect?.()
    return event
  }

  /** Open whatever has arrived that this device can read. Never throws. */
  async readDirect(): Promise<void> {
    let fresh = false
    for (const e of this.log.all()) {
      if (e.kind !== 'dm' || this.opened.has(e.id)) continue
      const to = String(e.body.to ?? '')
      const other = e.author === this.me ? to : e.author
      if (e.author !== this.me && to !== this.me) continue
      try {
        const key = await sharedKey(other)
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: unb64(String(e.body.iv ?? '')) as BufferSource },
          key,
          unb64(String(e.body.box ?? '')) as BufferSource,
        )
        this.opened.set(e.id, new TextDecoder().decode(plain))
        fresh = true
      } catch {
        // Not for us, or not what it claims to be. Either way it is not shown.
        this.opened.set(e.id, '')
      }
    }
    if (fresh) this.onDirect?.()
  }

  /** Everybody this device has a private conversation with, most recent first. */
  directs(): { key: string; name: string; last: number; unread: number }[] {
    const names = this.log.names()
    const out = new Map<string, { key: string; name: string; last: number; unread: number }>()
    for (const e of this.log.all()) {
      if (e.kind !== 'dm') continue
      const to = String(e.body.to ?? '')
      const mine = e.author === this.me
      if (!mine && to !== this.me) continue
      const other = mine ? to : e.author
      if (!/^[0-9a-f]{64}$/.test(other)) continue
      const was = out.get(other) ?? { key: other, name: names.get(other) ?? '', last: 0, unread: 0 }
      was.name = names.get(other) ?? was.name
      if (e.at > was.last) was.last = e.at
      if (!mine && e.lamport > (this.readDm[other] ?? 0)) was.unread += 1
      out.set(other, was)
    }
    return [...out.values()].sort((a, b) => b.last - a.last)
  }

  /** One private conversation, in log order. */
  directWith(other: string): Message[] {
    const names = this.log.names()
    const out: Message[] = []
    for (const e of this.log.all()) {
      if (e.kind !== 'dm') continue
      const to = String(e.body.to ?? '')
      const mine = e.author === this.me
      const them = mine ? to : e.author
      if (them !== other) continue
      if (!mine && to !== this.me) continue
      const text = this.opened.get(e.id)
      if (!text) continue
      out.push({
        id: e.id,
        author: e.author,
        name: names.get(e.author) ?? '',
        channel: '',
        at: e.at,
        lamport: e.lamport,
        text,
        replyTo: null,
        edited: false,
        retracted: false,
        reactions: new Map(),
      })
    }
    return out
  }

  /** How far this device has read in each private conversation. */
  private readDm: Record<string, number> = {}

  setDirectRead(marks: Record<string, number>): void {
    this.readDm = { ...marks }
  }

  /** The newest thing said in one, so reading it can be marked. */
  directHighWater(other: string): number {
    let top = 0
    for (const m of this.directWith(other)) if (m.lamport > top) top = m.lamport
    return top
  }

  /** Hold a message up at the top of its channel, or stop holding it. */
  pin(target: string, on: boolean): Promise<LogEvent> {
    return this.write('pin', { target, on })
  }

  /**
   * Say what you are called, if the log does not already say it.
   *
   * Called on the way into every space, so writing unconditionally meant one
   * profile event per visit, for ever, and the server keeps every line it is
   * ever given.
   */
  announceName(name: string, avatar?: string): Promise<LogEvent | null> {
    this.name = name
    const picture = avatar === undefined ? this.log.avatars().get(this.me) ?? '' : cleanAvatar(avatar)
    const sameName = this.log.names().get(this.me) === name
    const samePicture = (this.log.avatars().get(this.me) ?? '') === picture
    if (sameName && samePicture) return Promise.resolve(null)
    return this.write('profile', picture ? { name, avatar: picture } : { name })
  }

  /**
   * Take a pile of events from anywhere and keep the ones that hold up.
   *
   * Everything from the server is checked this way, hash and signature,
   * which is why the server can be somebody else's machine without that
   * mattering.
   */
  async absorb(candidates: unknown[]): Promise<LogEvent[]> {
    const fresh: LogEvent[] = []
    // Checked in parallel, off this thread, and added in the order given.
    for (const event of await openEvents(candidates, this.log.room)) {
      if (!event) continue
      if (this.log.add(event)) fresh.push(event)
    }
    if (fresh.length) {
      this.pinFounder()
      this.onChange?.()
    }
    return fresh
  }
}
