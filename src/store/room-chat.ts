import { fromBase64, toBase64 } from '../bytes'
import { mentionsMe } from '../chat'
import { loadIdentity, sharedKey } from './identity'
import { openEvents } from './verify-pool'
import {
  cleanAvatar,
  cleanChannel,
  cleanNoteTitle,
  cleanFiles,
  DEFAULT_CHANNEL,
  makeEvent,
  MAX_DM_BYTES,
  MAX_TEXT,
  oneEmoji,
  RoomLog,
  trimToBytes,
  trimToWire,
  type Attachment,
  type Authority,
  type ChannelInfo,
  type NoteInfo,
  type BoardSound,
  type EventKind,
  type Level,
  type LogEvent,
  type Message,
  type Permission,
  type ThreadInfo,
} from './log'

export interface Unread {
  count: number
  mentions: number
  newest: number
}

export class RoomChat {
  readonly log: RoomLog
  readonly me: string
  onChange: (() => void) | null = null
  onLocal: ((event: LogEvent) => void) | null = null
  onDirect: (() => void) | null = null
  onFounder: ((pubkey: string) => void) | null = null

  private name: string
  private readonly opened = new Map<string, string>()
  private readonly openedFiles = new Map<string, Attachment[]>()
  private readDm: Record<string, number> = {}

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

  notes(): NoteInfo[] {
    return this.log.notes()
  }

  /** Makes the note when the id is new. Leave title or text undefined to keep what is there. */
  saveNote(id: string, title?: string, text?: string): Promise<LogEvent> {
    const body: Record<string, unknown> = { id }
    if (title !== undefined) body.title = cleanNoteTitle(title) || 'Untitled'
    if (text !== undefined) body.text = trimToWire(text, MAX_TEXT)
    return this.write('note', body)
  }

  boardSounds(): BoardSound[] {
    return this.log.boardSounds()
  }

  addBoardSound(id: string, label: string, emoji: string, file: Attachment): Promise<LogEvent> {
    return this.write('board', { id, label: label.slice(0, 24), emoji: oneEmoji(emoji), file })
  }

  dropBoardSound(id: string): Promise<LogEvent> {
    return this.write('board', { id, gone: true })
  }

  dropNote(id: string): Promise<LogEvent> {
    return this.write('note', { id, gone: true })
  }

  channelInfo(voice = false): ChannelInfo[] {
    return this.log.channelList(voice)
  }

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

  highWater(channel: string): number {
    let top = 0
    for (const m of this.log.messages()) {
      if (m.channel !== channel) continue
      if (m.lamport > top) top = m.lamport
    }
    return top
  }

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

  get founder(): string {
    return this.log.founder
  }

  authority(): Authority {
    return this.log.authority()
  }

  can(what: Permission): boolean {
    return this.log.can(this.me, what)
  }

  levelOf(pubkey: string): Level {
    return this.log.authority().levelOf(pubkey)
  }

  levels(): Level[] {
    return this.log.authority().list()
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

  get isClosed(): boolean {
    return this.log.closed()
  }

  async claimFounder(): Promise<LogEvent> {
    this.log.founder = this.me
    return this.write('role', { subject: this.me, role: 'admin' })
  }

  setSpaceName(name: string): Promise<LogEvent> {
    return this.write('space', { name: name.slice(0, 32).trim() })
  }

  setRole(subject: string, role: string): Promise<LogEvent> {
    return this.write('role', { subject, role })
  }

  setLevel(level: Level): Promise<LogEvent> {
    return this.write('level', { id: level.id, name: level.name, colour: level.colour, rank: level.rank, can: level.can })
  }

  dropLevel(id: string): Promise<LogEvent> {
    return this.write('level', { id, gone: true })
  }

  private async write(kind: EventKind, body: Record<string, unknown>): Promise<LogEvent> {
    const event = await makeEvent(this.log.room, this.me, this.log.nextLamport(), kind, body)
    this.log.add(event)
    this.onLocal?.(event)
    this.onChange?.()
    return event
  }

  say(
    text: string,
    channel: string,
    replyTo?: string | null,
    inThread = false,
    emote = false,
    files: Attachment[] = [],
  ): Promise<LogEvent> {
    const body: Record<string, unknown> = {
      text: trimToWire(text, MAX_TEXT),
      channel: cleanChannel(channel) || DEFAULT_CHANNEL,
    }
    if (replyTo) body.replyTo = replyTo
    if (replyTo && inThread) body.thread = true
    if (emote) body.emote = true
    const attached = cleanFiles(files)
    if (attached.length) body.files = attached
    return this.write('said', body)
  }

  threads(): ThreadInfo[] {
    const threads = this.log.threads()
    const names = this.log.names()
    for (const t of threads) t.root.name = names.get(t.root.author) ?? t.root.name ?? ''
    return threads
  }

  threadOf(rootId: string): Message[] {
    const thread = this.log.thread(rootId)
    const names = this.log.names()
    for (const m of thread) m.name = names.get(m.author) ?? m.name ?? ''
    return thread
  }

  makeChannel(name: string, voice = false): Promise<LogEvent> {
    return this.write('channel', voice ? { name: cleanChannel(name), voice: true } : { name: cleanChannel(name) })
  }

  labelChannel(name: string, label: string, voice = false): Promise<LogEvent> {
    const body: Record<string, unknown> = { name: cleanChannel(name), label: label.slice(0, 32).trim() }
    if (voice) body.voice = true
    return this.write('channel', body)
  }

  setTopic(name: string, topic: string, voice = false): Promise<LogEvent> {
    const body: Record<string, unknown> = { name: cleanChannel(name), topic: topic.slice(0, 140).trim() }
    if (voice) body.voice = true
    return this.write('channel', body)
  }

  dropChannel(name: string, voice = false): Promise<LogEvent> {
    const body: Record<string, unknown> = { name: cleanChannel(name), gone: true }
    if (voice) body.voice = true
    return this.write('channel', body)
  }

  edit(target: string, text: string): Promise<LogEvent> {
    return this.write('edit', { target, text: trimToWire(text, MAX_TEXT) })
  }

  react(target: string, emoji: string, on: boolean): Promise<LogEvent> {
    return this.write('react', { target, emoji: oneEmoji(emoji), on })
  }

  retract(target: string): Promise<LogEvent> {
    return this.write('retract', { target })
  }

  askPoll(question: string, options: string[], channel: string): Promise<LogEvent> {
    return this.write('poll', {
      question: question.slice(0, 200),
      options: options.slice(0, 6),
      channel: cleanChannel(channel) || DEFAULT_CHANNEL,
    })
  }

  vote(target: string, choice: number): Promise<LogEvent> {
    return this.write('vote', { target, choice })
  }

  reset(): Promise<LogEvent> {
    return this.write('reset', { before: this.log.nextLamport() })
  }

  closeSpace(): Promise<LogEvent> {
    return this.write('close', { at: Date.now() })
  }

  async sayDirect(to: string, text: string, files: Attachment[] = []): Promise<LogEvent> {
    const key = await sharedKey(to)
    const seal = async (plain: string): Promise<{ iv: string; box: string }> => {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const box = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: iv as BufferSource },
          key,
          new TextEncoder().encode(plain) as BufferSource,
        ),
      )
      return { iv: toBase64(iv), box: toBase64(box) }
    }
    const plain = trimToBytes(text, MAX_DM_BYTES)
    const words = await seal(plain)
    const body: Record<string, unknown> = { to, iv: words.iv, box: words.box }
    // Files are sealed in their own box so clients that know only `box` still open the words.
    const attached = cleanFiles(files)
    if (attached.length) {
      const sealed = await seal(JSON.stringify(attached))
      body.fiv = sealed.iv
      body.fbox = sealed.box
    }
    const event = await this.write('dm', body)
    this.opened.set(event.id, plain)
    if (attached.length) this.openedFiles.set(event.id, attached)
    this.onDirect?.()
    return event
  }

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
          { name: 'AES-GCM', iv: fromBase64(String(e.body.iv ?? '')) },
          key,
          fromBase64(String(e.body.box ?? '')),
        )
        this.opened.set(e.id, new TextDecoder().decode(plain))
        if (typeof e.body.fbox === 'string') {
          const files = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: fromBase64(String(e.body.fiv ?? '')) },
            key,
            fromBase64(e.body.fbox),
          )
          this.openedFiles.set(e.id, cleanFiles(JSON.parse(new TextDecoder().decode(files))))
        }
        fresh = true
      } catch {
        this.opened.set(e.id, '')
      }
    }
    if (fresh) this.onDirect?.()
  }

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
      const files = this.openedFiles.get(e.id) ?? []
      if (!text && files.length === 0) continue
      out.push({
        id: e.id,
        author: e.author,
        name: names.get(e.author) ?? '',
        channel: '',
        at: e.at,
        lamport: e.lamport,
        text: text ?? '',
        replyTo: null,
        files,
        edited: false,
        retracted: false,
        reactions: new Map(),
      })
    }
    return out
  }

  setDirectRead(marks: Record<string, number>): void {
    this.readDm = { ...marks }
  }

  directHighWater(other: string): number {
    let top = 0
    for (const m of this.directWith(other)) if (m.lamport > top) top = m.lamport
    return top
  }

  pin(target: string, on: boolean): Promise<LogEvent> {
    return this.write('pin', { target, on })
  }

  announceName(name: string, avatar?: string): Promise<LogEvent | null> {
    this.name = name
    const picture = avatar === undefined ? this.log.avatars().get(this.me) ?? '' : cleanAvatar(avatar)
    const sameName = this.log.names().get(this.me) === name
    const samePicture = (this.log.avatars().get(this.me) ?? '') === picture
    if (sameName && samePicture) return Promise.resolve(null)
    return this.write('profile', { name, avatar: picture })
  }

  async absorb(candidates: unknown[]): Promise<LogEvent[]> {
    const fresh: LogEvent[] = []
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
