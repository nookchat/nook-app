/**
 * The chat panel.
 *
 * It draws whatever the log currently adds up to, and calls back when somebody
 * does something. It holds no state of its own beyond what is half typed and
 * what is being replied to, so a redraw after a merge is always correct.
 *
 * Message text is turned into DOM nodes, never into HTML. Nothing a person
 * types is ever parsed as markup, which is the only way to be sure that a
 * message from a stranger cannot become a script.
 */

import { MAX_DM_BYTES, MAX_TEXT, type Message } from '../store/log'
import type { LinkPreview } from '../store/archive'
import { cleanName, EVERYONE, findMentions, mentionsMe } from '../chat'
import { shortKey } from '../store/identity'
import { clear, h } from './dom'
import {
  closeEmojiPicker,
  openEmojiPicker,
  placeNear,
  quickReactions,
  recentEmoji,
} from './emoji'

/**
 * The row offered straight away when reacting, before the picker is opened.
 *
 * Whatever this person reached for last, falling back to the usual five. One
 * click for the common case and the whole set one click further on, which is
 * the shape every chat app settled on because it is the right one.
 */
const QUICK = ['👍', '😂', '🔥', '❤️', '👀']

/**
 * A colour for a name, from the key that signs what they write.
 *
 * Eight hues, picked so that none of them is the accent and all of them hold up
 * on a dark background. It is worked out from the key rather than from the
 * name, so somebody who renames themselves keeps their colour, and two people
 * who pick the same name do not share one.
 */
const NAME_HUES = [205, 340, 145, 32, 265, 190, 95, 15]

function authorColour(key: string): string {
  let sum = 0
  for (let i = 0; i < key.length; i++) sum = (sum * 31 + key.charCodeAt(i)) % 100_000
  return `hsl(${NAME_HUES[sum % NAME_HUES.length]} 62% 70%)`
}

/**
 * Hidden until somebody asks for it.
 *
 * The text is in the DOM either way, which is the honest thing to say about a
 * spoiler anywhere: it hides it from a glance, not from anybody determined.
 */
function spoiler(text: string): HTMLElement {
  const box = h('span', {
    class: 'spoiler',
    text,
    title: 'Hidden. Click to show.',
    role: 'button',
    tabIndex: 0,
    on: {
      click: () => box.classList.add('shown'),
      keydown: (ev) => {
        const key = (ev as KeyboardEvent).key
        if (key === 'Enter' || key === ' ') box.classList.add('shown')
      },
    },
  })
  return box
}

/**
 * Somebody's face, or the next best thing.
 *
 * A picture when they have set one, and their initials on their own colour when
 * they have not, which is everybody on the first day. It is never nothing: a
 * row of identical grey circles would be worse than none at all.
 */
export function avatarOf(key: string, name: string, picture: string, size = 20): HTMLElement {
  const box = h('span', { class: 'avatar', title: name || shortKey(key) })
  box.style.width = `${size}px`
  box.style.height = `${size}px`
  if (picture) {
    const img = h('img', { class: 'avatar-img' })
    img.alt = ''
    img.src = picture
    box.append(img)
    return box
  }
  const letters = (name || shortKey(key).slice(1))
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase()
  box.style.background = authorColour(key)
  box.style.fontSize = `${Math.round(size * 0.44)}px`
  box.append(h('span', { text: letters || '?' }))
  return box
}

/** Held up at the top of the channel, said on the message itself. */
function pinMark(): HTMLElement {
  return h('span', { class: 'chat-pinned-mark', title: 'Pinned in this channel', text: 'pinned' })
}

function quickRow(): string[] {
  // Whatever this person pinned in settings comes first and stays put: a row
  // that reorders itself under the pointer is a row you cannot aim at.
  const out = [...quickReactions()]
  for (const ch of recentEmoji()) {
    if (out.length >= 5) break
    if (!out.includes(ch)) out.push(ch)
  }
  for (const ch of QUICK) {
    if (out.length >= 5) break
    if (!out.includes(ch)) out.push(ch)
  }
  return out.slice(0, 5)
}

export interface ChatActions {
  say(text: string, replyTo: string | null, inThread?: boolean): void
  /** Say it to one person, sealed so the room carries it and cannot read it. */
  sayDirect?(to: string, text: string): void
  edit(id: string, text: string): void
  react(id: string, emoji: string, on: boolean): void
  retract(id: string): void
  rename(name: string): void
  /** Hold a message up at the top of the channel, or stop holding it. */
  pin(id: string, on: boolean): void
  /** Pick an answer to a poll. */
  vote(id: string, choice: number): void
}

export class ChatPanel {
  readonly root: HTMLElement
  actions: ChatActions | null = null
  /** Only an admin may pin, so only an admin is offered the button. */
  canPin = false
  /** Asking a question is a different shape from saying something. See /poll. */
  onPoll: (() => void) | null = null
  /** Somebody is writing. Throttled by the caller, which owns the wire. */
  onTyping: (() => void) | null = null
  /** Open the thread hanging off a message, or close the one that is open. */
  onThread: ((rootId: string | null) => void) | null = null
  /** Open or close a private conversation. */
  onDirect: ((key: string | null) => void) | null = null
  /** Look for a GIF. The space owns the search, because it owns the key. */
  onGif: (() => void) | null = null
  /** Open the soundboard. The space owns it, because it owns the wire. */
  onSound: (() => void) | null = null
  /** Whether this person's stream is still up in this channel. The space
      knows; the panel only asks so a dead invitation is not offered. */
  streamLive: ((key: string, channel: string) => boolean) | null = null
  /** Put their stream on the screen, from the message that announced it. */
  onWatch: ((key: string, channel: string) => void) | null = null
  /** Asks the space what is behind a link. Null when nobody can answer. */
  previewFor: ((url: string) => Promise<LinkPreview | null>) | null = null

  private readonly log: HTMLDivElement
  private readonly nameInput: HTMLInputElement
  private readonly textInput: HTMLTextAreaElement
  private readonly sendButton: HTMLButtonElement
  private readonly emojiButton: HTMLButtonElement
  private readonly gifButton: HTMLButtonElement
  private readonly soundButton: HTMLButtonElement
  private readonly replyBar: HTMLDivElement
  private readonly nameRow: HTMLDivElement
  private readonly typingLine: HTMLDivElement
  private readonly roomLeft: HTMLSpanElement
  /** Whether the space is in a state where anything may be said at all. */
  private enabled = false
  private readonly title: HTMLSpanElement
  private readonly backButton: HTMLButtonElement
  private readonly head: HTMLDivElement
  private name: string
  private me = ''
  private replyTo: Message | null = null
  private editing: Message | null = null
  /** Who is in the room, so a mention can be spelled and lit up. */
  private names = new Map<string, string>()
  /** And what they look like, when they have said. */
  private avatars = new Map<string, string>()
  /** The thread being read, if one is. Its root is drawn above the replies. */
  private threadRoot: string | null = null
  /** The person this panel is writing to privately, if any. */
  private directWith: string | null = null
  private directName = ''
  /**
   * Everything above this clock value has been read here.
   *
   * Held for the drawing of one line across the log rather than for the badge,
   * which the rail works out for itself. It survives a redraw, so the line does
   * not jump away the moment the next message lands.
   */
  private readMark = 0
  /**
   * Whether the conversation was at the bottom the last time anybody looked.
   *
   * Kept rather than measured, because the question is always asked after
   * something grew, and by then the answer has already changed.
   */
  private pinned = true
  private suggestions: HTMLDivElement | null = null
  private suggestAt = -1
  /** Which kind of list is up, because Enter means different things to them. */
  private suggestKind: 'mention' | 'command' | 'name' | null = null
  /**
   * What was half typed in each channel.
   *
   * Switching channel used to throw it away, which is a small thing that
   * happens every day: you start an answer, check something in another channel,
   * and come back to an empty box.
   */
  private readonly drafts = new Map<string, string>()
  private draftKey = ''
  private readonly toBottom: HTMLButtonElement
  /** Told when a slash command is typed. Returns true when it handled it. */
  onCommand: ((line: string) => boolean) | null = null
  /** The commands offered while typing a slash. */
  commands: { name: string; note: string; takesName?: boolean; also?: string[] }[] = []

  constructor(initialName: string, title = 'Chat') {
    this.name = initialName

    /*
     * A log, announced politely.
     *
     * Reconciliation is what makes this safe: only what is new is added to the
     * DOM, so a screen reader is told about the message that arrived rather
     * than read the whole conversation again every time anybody speaks.
     */
    this.log = h('div', {
      class: 'chat-log',
      role: 'log',
      ariaLabel: 'Conversation',
      tabIndex: 0,
    })
    this.log.setAttribute('aria-live', 'polite')
    this.log.setAttribute('aria-relevant', 'additions')
    this.replyBar = h('div', { class: 'chat-replying hidden' })

    this.nameInput = h('input', {
      type: 'text',
      value: this.name,
      ariaLabel: 'Your name in the chat',
      placeholder: 'Your name',
      on: {
        change: () => this.commitName(),
        blur: () => this.commitName(),
        keydown: (ev) => {
          if ((ev as KeyboardEvent).key === 'Enter') {
            this.commitName()
            this.textInput.focus()
          }
        },
      },
    })

    /*
     * A textarea, not a single line.
     *
     * Enter sends and shift with it makes a new line, which is what every chat
     * app does and what everybody's hands already expect. The box grows with
     * what is in it up to a few lines and then scrolls, so a pasted stack trace
     * does not take the whole panel.
     */
    this.textInput = h('textarea', {
      ariaLabel: 'Write a message',
      placeholder: 'Say something',
      rows: 1,
      on: {
        keydown: (ev) => this.onComposeKey(ev as KeyboardEvent),
        input: () => {
          this.grow()
          this.suggest()
          this.onTyping?.()
        },
        blur: () => this.closeSuggestions(),
      },
    })

    this.sendButton = h('button', { text: 'Send', on: { click: () => this.submit() } })
    this.emojiButton = h('button', {
      class: 'ghost',
      text: '\u263a',
      title: 'Emoji',
      ariaLabel: 'Emoji',
      on: {
        click: () =>
          openEmojiPicker({
            anchor: this.emojiButton,
            sticky: true,
            onPick: (ch) => this.insert(ch),
          }),
      },
    })

    /*
     * The two things beside the emoji button.
     *
     * Both were only reachable by typing a slash command, which is a way of
     * saying they were reachable by the people who already knew about them.
     * A button is how anybody else finds out they exist.
     */
    this.gifButton = h('button', {
      class: 'ghost tiny-btn',
      text: 'GIF',
      title: 'Find a GIF',
      ariaLabel: 'Find a GIF',
      on: { click: () => this.onGif?.() },
    })
    this.soundButton = h('button', {
      class: 'ghost',
      text: '🔊',
      title: 'Soundboard',
      ariaLabel: 'Soundboard',
      on: { click: () => this.onSound?.() },
    })

    this.nameRow = h('div', { class: 'row' }, [
      h('span', { class: 'tiny faint', text: 'You', style: { width: '26px' } }),
      this.nameInput,
    ])

    this.typingLine = h('div', { class: 'chat-typing hidden' })
    this.roomLeft = h('span', { class: 'chat-room-left tiny hidden', ariaLabel: 'Room left in this message' })
    /*
     * The way back down.
     *
     * Only there when it is needed, which is when you have scrolled up far
     * enough that new messages are arriving out of sight.
     */
    this.toBottom = h('button', {
      class: 'to-bottom hidden',
      text: 'Jump to the newest',
      title: 'Go to the end of the conversation',
      on: {
        click: () => {
          this.pinned = true
          this.log.scrollTop = this.log.scrollHeight
          this.toBottom.classList.add('hidden')
        },
      },
    })
    this.log.addEventListener('scroll', () => {
      this.pinned = this.isAtBottom()
      this.showJump()
    })

    /*
     * Follow a picture down as it arrives.
     *
     * A picture has no height until it has loaded, so the scroll to the end
     * that happens when the message is drawn lands at the end of a row that is
     * about to get two hundred pixels taller. The GIF then pushed itself half
     * off the bottom of the screen, which is a poor look for the thing the
     * message was.
     *
     * So the end is found again once the thing knows how big it is. Only when
     * the conversation was already sitting at the bottom: a picture loading in
     * something you scrolled up to read must not drag you away from it.
     *
     * Load does not bubble, hence the capture, and a video says loadedmetadata
     * rather than load.
     */
    this.log.addEventListener('load', () => this.followMedia(), true)
    this.log.addEventListener('loadedmetadata', () => this.followMedia(), true)
    this.title = h('span', { class: 'eyebrow', text: title })
    this.backButton = h('button', {
      class: 'ghost tiny-btn hidden',
      text: '← Back',
      title: 'Back to the channel',
      on: { click: () => (this.directWith ? this.onDirect?.(null) : this.onThread?.(null)) },
    })

    /*
     * The header only exists inside a thread.
     *
     * Outside one it said "Chat" above a channel already named at the top of
     * the column, beside a count of who is here that the members list and the
     * status bar both carry. Three labels for two facts.
     */
    this.head = h('div', { class: 'row spread chat-head hidden' }, [
      h('div', { class: 'row' }, [this.backButton, this.title]),
    ])

    this.root = h('div', { class: 'chat-panel' }, [
      this.head,
      h('div', { class: 'chat-scroll' }, [this.log, this.toBottom]),
      h('div', { class: 'chat-compose stack tight' }, [
        this.typingLine,
        this.replyBar,
        this.nameRow,
        h('div', { class: 'row' }, [
          this.textInput,
          this.roomLeft,
          this.gifButton,
          this.soundButton,
          this.emojiButton,
          this.sendButton,
        ]),
      ]),
    ])
  }

  get currentName(): string {
    return this.name
  }

  /** What the soundboard hangs off, for the times it is opened by command. */
  get soundAnchor(): HTMLElement {
    return this.soundButton
  }

  setMe(pubkey: string): void {
    this.me = pubkey
  }

  /** The name moved to settings, so the compose box does not need to carry it. */
  showNameField(show: boolean): void {
    this.nameRow.classList.toggle('hidden', !show)
  }

  /** The panel is built before the identity is loaded, so it is told later. */
  setName(name: string): void {
    this.name = name
    if (document.activeElement !== this.nameInput) this.nameInput.value = name
  }

  /** Who is in the room, by key, so a mention can be spelled and recognised. */
  setNames(names: Map<string, string>, avatars?: Map<string, string>): void {
    this.names = names
    if (avatars) this.avatars = avatars
  }

  /** What this panel is showing: a channel, or a thread inside one. */
  setTitle(text: string): void {
    this.title.textContent = text
  }

  /**
   * Draw the line between what has been read and what has not.
   *
   * Taken once, when a channel is opened, and kept while it stays open. Moving
   * it as each message arrives would rub out the line you came back to read.
   */
  setReadMark(lamport: number): void {
    this.readMark = lamport
  }

  get thread(): string | null {
    return this.threadRoot
  }

  setThread(rootId: string | null): void {
    this.threadRoot = rootId
    this.showHead()
    this.cancelPending()
  }

  /** Whose private conversation this is, or none. */
  setDirect(key: string | null, name = ''): void {
    this.directWith = key
    this.directName = name
    this.showHead()
    this.cancelPending()
    // A private message is measured in bytes and a channel one in letters, so
    // the count means something different the moment this changes.
    this.sayRoom()
  }

  private showHead(): void {
    const away = this.threadRoot !== null || this.directWith !== null
    this.backButton.classList.toggle('hidden', !away)
    this.head.classList.toggle('hidden', !away)
    this.textInput.placeholder = this.directWith
      ? `Message ${this.directName || 'them'}`
      : this.threadRoot
        ? 'Reply in this thread'
        : 'Say something'
  }

  /** "Alice is typing", or nothing at all, which is most of the time. */
  setTyping(who: string[]): void {
    const names = who.filter(Boolean)
    this.typingLine.classList.toggle('hidden', names.length === 0)
    if (names.length === 0) return
    this.typingLine.textContent =
      names.length === 1
        ? `${names[0]} is typing...`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing...`
          : 'Several people are typing...'
  }

  setEnabled(enabled: boolean, why = ''): void {
    this.enabled = enabled
    this.textInput.disabled = !enabled
    this.textInput.placeholder = enabled ? 'Say something' : why || 'Connecting...'
    // Two things can stop Send: the space is not ready, or the message is too
    // long. One place decides, so neither of them undoes the other.
    this.sayRoom()
  }

  focus(): void {
    this.textInput.focus()
  }

  /**
   * Drop an emoji into the message being written, where the caret is.
   *
   * At the caret rather than at the end, because a picker that only ever
   * appends cannot be used to fix the middle of a sentence. The caret is put
   * back after what was inserted, so picking three in a row reads left to
   * right.
   */
  insert(text: string): void {
    const input = this.textInput
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    input.value = input.value.slice(0, start) + text + input.value.slice(end)
    const at = start + text.length
    input.setSelectionRange(at, at)
    input.focus()
    this.grow()
  }

  // ---- the compose box ----

  /**
   * Enter sends. Shift and Enter make a line. Escape puts down whatever was
   * being replied to or edited. While the mention list is up it takes the
   * arrows and Enter first, because that is what the keys are for at that
   * moment.
   */
  private onComposeKey(ev: KeyboardEvent): void {
    if (this.suggestions && this.onSuggestKey(ev)) return
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      this.submit()
      return
    }
    /*
     * Up on an empty box edits the last thing you said, the way it does in
     * every terminal and every chat app. Only when the box is empty, or it
     * would eat the cursor of somebody writing a paragraph.
     */
    if (ev.key === 'ArrowUp' && !this.textInput.value && !this.editing) {
      const mine = [...this.shown].reverse().find((m) => m.author === this.me && !m.poll)
      if (mine) {
        this.startEdit(mine)
        ev.preventDefault()
      }
      return
    }
    if (ev.key === 'Escape') {
      this.cancelPending()
      if (this.threadRoot) this.onThread?.(null)
      else if (this.directWith) this.onDirect?.(null)
    }
  }

  /** Whether the way back down is needed. */
  private showJump(): void {
    const far = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight > 220
    this.toBottom.classList.toggle('hidden', !far)
  }

  /**
   * Keep what is half written, per channel or per thread.
   *
   * Called by whoever is about to change what the panel is showing, before it
   * changes, so the box that is about to be emptied is remembered first.
   */
  keepDraft(): void {
    if (!this.draftKey) return
    const half = this.textInput.value
    if (half) this.drafts.set(this.draftKey, half)
    else this.drafts.delete(this.draftKey)
  }

  /** Put back whatever was half written here last time. */
  useDraft(key: string): void {
    if (key === this.draftKey) return
    this.keepDraft()
    this.draftKey = key
    this.textInput.value = this.drafts.get(key) ?? ''
    this.grow()
  }

  /** As tall as what is in it, up to a point. */
  private grow(): void {
    const input = this.textInput
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 116)}px`
    this.sayRoom()
  }

  /**
   * How much room is left, once there is a reason to care.
   *
   * A message past the limit is refused by everybody who receives it, so it
   * would look sent here and arrive nowhere. Rather than let that happen the
   * count appears in the last stretch, turns red when the box is over, and
   * Send stops working until it is not.
   *
   * A private message is sealed before it is written, and sealing counts bytes
   * rather than letters, so the number shown for one is the byte budget. One
   * emoji spends four of them and one letter spends one.
   */
  /** How much of the limit is left, in whatever the limit is counted in. */
  private roomFor(): number {
    const limit = this.directWith ? MAX_DM_BYTES : MAX_TEXT
    // A channel message is measured the way it travels: the bytes of its
    // JSON form, where a quote or a newline costs two.
    const used = this.directWith
      ? new TextEncoder().encode(this.textInput.value).length
      : new TextEncoder().encode(JSON.stringify(this.textInput.value)).length
    return limit - used
  }

  private tooLong(): boolean {
    return this.roomFor() < 0
  }

  private sayRoom(): void {
    const left = this.roomFor()
    const limit = this.directWith ? MAX_DM_BYTES : MAX_TEXT
    const near = left <= Math.max(200, Math.round(limit / 12))
    this.roomLeft.classList.toggle('hidden', !near)
    this.roomLeft.classList.toggle('over', left < 0)
    this.roomLeft.textContent = left < 0 ? `${-left} too many` : `${left} left`
    this.sendButton.disabled = !this.enabled || left < 0
  }

  // ---- mentions ----

  /**
   * Offer the names that fit what has been typed after an @.
   *
   * Nothing is inserted until it is chosen: a mention that completes itself
   * while you are still typing is a mention of the wrong person half the time.
   */
  private suggest(): void {
    if (this.suggestCommands()) return
    const input = this.textInput
    const caret = input.selectionStart ?? 0
    const before = input.value.slice(0, caret)
    const at = before.lastIndexOf('@')
    // An @ in the middle of a word is an email address.
    const startsWord = at === 0 || (at > 0 && /[\s(]/.test(before[at - 1]))
    const fragment = at === -1 ? '' : before.slice(at + 1)
    if (at === -1 || !startsWord || fragment.length > 24 || /\n/.test(fragment)) {
      this.closeSuggestions()
      return
    }

    const wanted = fragment.toLowerCase()
    const hits = [...this.names]
      .filter(([key, name]) => name && key !== this.me && name.toLowerCase().startsWith(wanted))
      .slice(0, 6)
    if (fragment === '' || 'everyone'.startsWith(wanted)) hits.unshift([EVERYONE, 'everyone'])
    if (hits.length === 0) {
      this.closeSuggestions()
      return
    }

    this.suggestAt = at
    this.suggestKind = 'mention'
    const list = this.suggestions ?? h('div', { class: 'mention-pop' })
    clear(list)
    hits.forEach(([, name], i) => {
      list.append(
        h('button', {
          class: `mention-option${i === 0 ? ' on' : ''}`,
          text: name,
          // The blur that a click would cause closes the list first, so the
          // pick has to happen before the browser gets that far.
          on: { mousedown: (ev) => { ev.preventDefault(); this.takeSuggestion(name) } },
        }),
      )
    })
    if (!this.suggestions) {
      this.suggestions = list
      document.body.append(list)
    }
    placeNear(list, this.textInput)
  }

  /** The commands, while the line being written is one. */
  private suggestCommands(): boolean {
    const value = this.textInput.value
    if (!value.startsWith('/') || value.startsWith('//') || /\n/.test(value)) return false
    const space = value.indexOf(' ')
    if (space !== -1) return this.suggestPerson(value, space)
    const wanted = value.slice(1).toLowerCase()
    const hits = this.commands.filter((c) => c.name.startsWith(wanted))
    if (hits.length === 0) {
      this.closeSuggestions()
      return true
    }
    this.suggestAt = 0
    this.suggestKind = 'command'
    const list = this.suggestions ?? h('div', { class: 'mention-pop' })
    clear(list)
    hits.forEach((command, i) => {
      list.append(
        h(
          'button',
          {
            class: `mention-option${i === 0 ? ' on' : ''}`,
            on: {
              mousedown: (ev) => {
                ev.preventDefault()
                this.textInput.value = `/${command.name} `
                this.closeSuggestions()
                this.textInput.focus()
              },
            },
          },
          [
            h('span', { text: `/${command.name}` }),
            h('span', { class: 'tiny faint', text: command.note }),
          ],
        ),
      )
    })
    if (!this.suggestions) {
      this.suggestions = list
      document.body.append(list)
    }
    placeNear(list, this.textInput)
    return true
  }

  /**
   * The people, while the word being written is the name a command wants.
   *
   * A command like /nudge or /dm is answered by a name spelled exactly, and
   * the room is the only place that spelling lives, so the box offers it the
   * same way it offers a mention. No at sign goes in: the command wants the
   * name itself.
   *
   * Returns false when this is not that, so an @ later in the same line is
   * still a mention.
   */
  private suggestPerson(value: string, space: number): boolean {
    // The other spelling of a command is the same command, so /msg offers what
    // /dm offers rather than nothing at all.
    const typed = value.slice(1, space).toLowerCase()
    const command = this.commands.find((c) => c.name === typed || c.also?.includes(typed))
    if (!command?.takesName) return false
    const caret = this.textInput.selectionStart ?? 0
    const start = space + 1
    if (caret < start) return false
    // What has been typed of the name, which may be nothing yet. Taking it up
    // to the caret rather than to the next space is what lets a name with a
    // space in it finish itself.
    const fragment = value.slice(start, caret)
    if (fragment.length > 32) return false

    const wanted = fragment.toLowerCase()
    const hits = [...this.names]
      .filter(([key, name]) => name && key !== this.me && name.toLowerCase().startsWith(wanted))
      .map(([, name]) => name)
      .slice(0, 6)
    if (hits.length === 0) return false

    this.suggestAt = start
    this.suggestKind = 'name'
    const list = this.suggestions ?? h('div', { class: 'mention-pop' })
    clear(list)
    hits.forEach((name, i) => {
      list.append(
        h('button', {
          class: `mention-option${i === 0 ? ' on' : ''}`,
          text: name,
          on: { mousedown: (ev) => { ev.preventDefault(); this.takeName(name) } },
        }),
      )
    })
    if (!this.suggestions) {
      this.suggestions = list
      document.body.append(list)
    }
    placeNear(list, this.textInput)
    return true
  }

  private onSuggestKey(ev: KeyboardEvent): boolean {
    const list = this.suggestions
    if (!list) return false
    const options = [...list.querySelectorAll('.mention-option')]
    const at = options.findIndex((el) => el.classList.contains('on'))
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const next = (at + (ev.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length
      options[at]?.classList.remove('on')
      options[next]?.classList.add('on')
      ev.preventDefault()
      return true
    }
    /*
     * Enter finishes a mention, because you are in the middle of a word and
     * the list is helping you spell it. Enter runs a command, because the line
     * is the command and finishing it is not what pressing return means. Tab
     * completes either.
     */
    if (ev.key === 'Enter' && this.suggestKind === 'command') {
      this.closeSuggestions()
      return false
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      const chosen = options[at === -1 ? 0 : at]
      const label = chosen?.querySelector('span')?.textContent ?? chosen?.textContent ?? ''
      if (this.suggestKind === 'command') {
        this.textInput.value = `${label} `
        this.closeSuggestions()
        this.grow()
      } else if (label && this.suggestKind === 'name') {
        this.takeName(label)
      } else if (label) {
        this.takeSuggestion(label)
      }
      ev.preventDefault()
      return true
    }
    if (ev.key === 'Escape') {
      this.closeSuggestions()
      ev.preventDefault()
      return true
    }
    return false
  }

  private takeSuggestion(name: string): void {
    const input = this.textInput
    const caret = input.selectionStart ?? 0
    const head = input.value.slice(0, this.suggestAt)
    const tail = input.value.slice(caret)
    const insert = `@${name} `
    input.value = head + insert + tail
    const at = head.length + insert.length
    input.setSelectionRange(at, at)
    this.closeSuggestions()
    input.focus()
    this.grow()
  }

  /** Put a name where a command wants one, with the space that follows it. */
  private takeName(name: string): void {
    const input = this.textInput
    const caret = input.selectionStart ?? 0
    const head = input.value.slice(0, this.suggestAt)
    const tail = input.value.slice(caret)
    // The space after the name is what a command reads as the end of it,
    // unless there is already one there.
    const insert = tail.startsWith(' ') ? name : `${name} `
    input.value = head + insert + tail
    const at = head.length + insert.length
    input.setSelectionRange(at, at)
    this.closeSuggestions()
    input.focus()
    this.grow()
  }

  private closeSuggestions(): void {
    this.suggestions?.remove()
    this.suggestions = null
    this.suggestAt = -1
    this.suggestKind = null
  }

  /** What is on screen, so up-arrow knows what your last message was. */
  private shown: Message[] = []
  /** What is drawn, by key, so a redraw can leave most of it alone. */
  private readonly rows = new Map<string, { el: HTMLElement; sig: string }>()

  /**
   * Draw the conversation, touching only what changed.
   *
   * It used to clear the log and build every message again on every change, so
   * one arriving line re-created the whole channel: a few hundred milliseconds
   * at a few thousand messages, and worse than the cost, it wiped whatever you
   * were in the middle of. Selecting text to copy it, with anybody else typing,
   * lost the selection the moment they sent.
   *
   * So every row carries a key and a signature of everything drawn in it. A row
   * whose signature has not changed is left exactly where it is, untouched, and
   * a new message is one insert. That is also what makes the log safe to
   * announce to a screen reader: only what is new is new.
   */
  render(messages: Message[], joins: { at: number; text: string }[] = []): void {
    this.shown = messages
    const stuck = this.isAtBottom()

    const byId = new Map(messages.map((m) => [m.id, m]))
    /*
     * The messages arrive already ordered by the log, whose order every peer
     * agrees on, and that order is not touched here. Notes about arrivals are
     * merged in beside them by wall clock, which is all a note has. Sorting
     * the whole feed by wall clock, which this used to do, quietly reordered
     * messages whenever somebody's clock ran ahead, so two people could read
     * the same argument in two different orders.
     */
    const feed: ({ kind: 'msg'; m: Message } | { kind: 'note'; at: number; text: string })[] = []
    const notes = [...joins].sort((a, b) => a.at - b.at)
    let n = 0
    for (const m of messages) {
      while (n < notes.length && notes[n].at <= m.at) {
        feed.push({ kind: 'note', at: notes[n].at, text: notes[n].text })
        n += 1
      }
      feed.push({ kind: 'msg', m })
    }
    while (n < notes.length) {
      feed.push({ kind: 'note', at: notes[n].at, text: notes[n].text })
      n += 1
    }

    const items: { key: string; sig: string; make: () => HTMLElement }[] = []
    let lastDay = ''
    let lastAuthor = ''
    let drawnUnread = false

    for (const item of feed) {
      if (item.kind === 'note') {
        items.push({
          key: `note:${item.at}:${item.text}`,
          sig: item.text,
          make: () => h('div', { class: 'chat-line system', text: item.text }),
        })
        lastAuthor = ''
        continue
      }
      const m = item.m
      const day = new Date(m.at).toDateString()
      if (day !== lastDay) {
        lastDay = day
        lastAuthor = ''
        const label = dayLabel(m.at)
        items.push({
          key: `day:${day}`,
          sig: label,
          make: () => h('div', { class: 'chat-day', text: label }),
        })
      }

      /*
       * The line you came back to read.
       *
       * Drawn once, above the first thing that arrived after this device last
       * looked, and never above your own message: coming back to "new" and
       * finding it is something you wrote is a small daily insult.
       */
      if (!drawnUnread && this.readMark > 0 && m.lamport > this.readMark && m.author !== this.me) {
        drawnUnread = true
        lastAuthor = ''
        items.push({
          key: 'new',
          sig: `new:${m.id}`,
          make: () => h('div', { class: 'chat-new' }, [h('span', { text: 'New' })]),
        })
      }

      const first = m.author !== lastAuthor
      lastAuthor = m.replyTo ? '' : m.author
      items.push({
        key: `m:${m.id}`,
        sig: this.signature(m, first, byId),
        make: () => this.messageRow(m, first, byId),
      })

      // In a thread, a rule under the question it hangs off. What follows is
      // the answers, and they read as answers rather than as more questions.
      if (this.threadRoot && m.id === this.threadRoot) {
        const count = messages.length - 1
        const text = count === 0 ? 'No replies yet' : `${count} ${count === 1 ? 'reply' : 'replies'}`
        items.push({
          key: 'thread-rule',
          sig: text,
          make: () => h('div', { class: 'chat-new thread' }, [h('span', { text })]),
        })
        lastAuthor = ''
      }
    }

    this.reconcile(items)
    if (stuck) {
      this.log.scrollTop = this.log.scrollHeight
      this.pinned = true
    }
    this.showJump()
  }

  /**
   * Everything about a message that ends up on the screen, as one string.
   *
   * If this misses something, that something stops updating, so it is written
   * beside the thing that draws it and holds every value that drawing reads.
   */
  private signature(m: Message, first: boolean, byId: Map<string, Message>): string {
    const reactions = [...m.reactions]
      .map(([emoji, who]) => `${emoji}${who.size}${who.has(this.me) ? '*' : ''}`)
      .sort()
      .join(',')
    const poll = m.poll
      ? `${m.poll.question}|${m.poll.options.join(',')}|${m.poll.total}|${m.poll.mine}|${[...m.poll.votes]
          .map(([choice, who]) => `${choice}:${who.size}`)
          .sort()
          .join(',')}`
      : ''
    const parent = m.replyTo ? byId.get(m.replyTo) : null
    return [
      m.text,
      m.name ?? '',
      this.avatars.get(m.author) ?? '',
      m.at,
      m.edited ? 'e' : '',
      m.pinned ? 'p' : '',
      m.emote ? 'm' : '',
      // The way in to a stream comes and goes with the stream itself, not
      // with anything on the message, so the row must redraw when it turns.
      m.live && m.author !== this.me && this.streamLive?.(m.author, m.channel) ? 'live' : '',
      m.replies ?? 0,
      first ? 'f' : '',
      this.canPin ? 'a' : '',
      mentionsMe(m.text, this.names, this.me) ? 'c' : '',
      this.threadRoot === m.id ? 'root' : '',
      parent ? `${parent.name ?? ''}:${parent.text.slice(0, 60)}` : m.replyTo ? 'gone' : '',
      reactions,
      poll,
    ].join('\u0001')
  }

  /**
   * Line the log up with what it should be showing.
   *
   * Anything whose signature still matches is left alone, which means its
   * selection, its scroll, its open menu and its half finished animation all
   * survive. The rest is inserted, moved or removed.
   */
  private reconcile(items: { key: string; sig: string; make: () => HTMLElement }[]): void {
    const wanted = new Set(items.map((i) => i.key))
    for (const [key, held] of this.rows) {
      if (wanted.has(key)) continue
      held.el.remove()
      this.rows.delete(key)
    }

    let at = 0
    for (const item of items) {
      let held = this.rows.get(item.key)
      if (!held || held.sig !== item.sig) {
        const el = item.make()
        el.dataset.key = item.key
        held?.el.remove()
        held = { el, sig: item.sig }
        this.rows.set(item.key, held)
      }
      const current = this.log.childNodes[at]
      if (current !== held.el) this.log.insertBefore(held.el, current ?? null)
      at += 1
    }
    while (this.log.childNodes.length > items.length) this.log.lastChild?.remove()
  }

  /** One message, drawn. */
  private messageRow(m: Message, first: boolean, byId: Map<string, Message>): HTMLElement {
    const mine = m.author === this.me
    const at = h('span', { class: 'chat-at', text: clockLabel(m.at) })
    const line = h('div', {
      class:
        `chat-line${mine ? ' mine' : ''}${m.pinned ? ' pinned' : ''}` +
        `${mentionsMe(m.text, this.names, this.me) ? ' calls-me' : ''}`,
    })
    line.dataset.id = m.id
    // The line sits in a row, and the row is what the actions hang off, so
    // they are beside the message rather than on top of the end of it.
    const row = h('div', { class: `chat-row${mine ? ' mine' : ''}` }, [line])
    /*
     * On a touch screen there is no hovering, so the actions are asked for by
     * tapping the message. One at a time: opening a second closes the first,
     * which is what a pointer does for free.
     */
    line.addEventListener('click', (ev) => {
      if (window.matchMedia('(hover: hover)').matches) return
      const target = ev.target as HTMLElement
      if (target.closest('button, a, .spoiler')) return
      const open = row.classList.contains('acting')
      for (const other of this.log.querySelectorAll('.chat-row.acting')) {
        other.classList.remove('acting')
      }
      row.classList.toggle('acting', !open)
    })

    /*
     * What this answers, unless the answer is standing inside the thread it
     * belongs to. Quoting the message at the top of the pane above every
     * reply to it says nothing anybody cannot see.
     */
    if (m.replyTo && m.replyTo !== this.threadRoot) {
      const parent = byId.get(m.replyTo)
      line.append(
        h('button', {
          class: 'chat-reply truncate',
          title: parent ? 'Go to what this answers' : 'That message is no longer here',
          text: parent
            ? `${parent.name || shortKey(parent.author)}: ${parent.text.slice(0, 60)}`
            : 'a message that is gone',
          on: { click: () => parent && this.jumpTo(parent.id) },
        }),
      )
    }
    if (this.threadRoot && m.id === this.threadRoot) line.classList.add('thread-root')

    /*
     * A run from one person shows the name once, at the top of the run.
     *
     * The name carries a colour worked out from the key that signs the
     * messages, so it is the same colour on every device and for everybody,
     * your own included: every line sits on the same side and wears no
     * bubble now, and the coloured name is what tells the runs apart.
     */
    if (first) {
      const name = h('span', { class: 'chat-name', text: m.name || shortKey(m.author) })
      name.style.color = authorColour(m.author)
      line.append(
        h('div', { class: 'chat-who' }, [
          avatarOf(m.author, m.name ?? '', this.avatars.get(m.author) ?? '', 24),
          name,
          m.pinned ? pinMark() : null,
        ]),
      )
    } else {
      at.classList.add('on-hover')
      if (m.pinned) line.append(h('div', { class: 'chat-who' }, [pinMark()]))
      line.classList.add('runs-on')
    }

    const text = h('span', { class: `chat-text${m.emote ? ' emote' : ''}` })
    if (m.emote) text.append(document.createTextNode(`${m.name || shortKey(m.author)} `))
    if (m.poll) {
      text.append(h('strong', { text: m.poll.question }))
      line.append(text)
      line.append(this.pollBox(m))
    } else {
      // A message that IS a picture, written rather than linked. Drawn the
      // way every picture here is drawn, through an img, never parsed into
      // the page: see svgSource for what that buys.
      const svg = m.emote ? null : svgSource(m.text)
      if (svg) {
        line.classList.add('has-picture')
        line.append(
          svgEmbed(svg, () => {
            // It would not draw, so it goes back to being what it was: text.
            line.classList.remove('has-picture')
            for (const node of formatText(m.text, this.names, this.me)) text.append(node)
            line.prepend(text)
          }),
        )
      }
      const pictures = svg ? [] : imageLinks(m.text)
      // A message that is nothing but a picture link is the picture. The
      // address under it said the same thing worse.
      const bare = !m.emote && pictures.length === 1 && m.text.trim() === pictures[0]
      /*
       * A picture stands apart from the words.
       *
       * Any words in the same message sit on their own line above it, so the
       * picture is not jammed into the middle of a sentence.
       */
      if (pictures.length > 0) line.classList.add('has-picture')
      if (!bare && !svg) {
        if (pictures.length > 0) text.classList.add('boxed')
        for (const node of formatText(m.text, this.names, this.me)) text.append(node)
        line.append(text)
      }
      for (const src of pictures) line.append(embed(src))
      this.attachPreview(line, m.text)
    }

    /*
     * The way in to a stream, on the line that announced it.
     *
     * Only while the screen is still up, and never on your own: a button that
     * joins a stream that ended is a lie, and the sharer already has theirs.
     */
    if (m.live && m.author !== this.me && this.streamLive?.(m.author, m.channel)) {
      line.append(
        h('button', {
          class: 'chat-join primary',
          text: 'Join stream',
          title: `Put ${m.name || shortKey(m.author)}’s screen on yours`,
          on: { click: () => this.onWatch?.(m.author, m.channel) },
        }),
      )
    }

    if (m.edited) line.append(h('span', { class: 'chat-edited', text: '(edited)' }))
    line.append(at)

    // The way into a thread, and the count of what is waiting in it.
    if (!this.threadRoot && m.replies) {
      line.append(
        h('button', {
          class: 'chat-thread',
          text: `${m.replies} ${m.replies === 1 ? 'reply' : 'replies'}`,
          title: 'Open this thread',
          on: { click: () => this.onThread?.(m.id) },
        }),
      )
    }

    if (m.reactions.size) {
      const reacts = h('div', { class: 'chat-reacts' })
      for (const [emoji, who] of m.reactions) {
        reacts.append(
          h('button', {
            class: `chat-react${who.has(this.me) ? ' on' : ''}`,
            text: `${emoji} ${who.size}`,
            title: who.has(this.me) ? 'Take yours back' : 'React with this too',
            on: { click: () => this.actions?.react(m.id, emoji, !who.has(this.me)) },
          }),
        )
      }
      // One more, on the end of the ones already there, which is where
      // somebody about to add a different one is already looking.
      const more = h('button', {
        class: 'chat-react add',
        text: '+',
        title: 'React with something else',
        ariaLabel: 'React with something else',
        on: { click: () => this.reactWith(m, more) },
      })
      reacts.append(more)
      line.append(reacts)
    }

    // Hung off the line rather than off the row, so they sit against the
    // message they act on however wide it is.
    line.append(this.rowActions(m, mine))
    return row

  }

  // ---- internals ----

  /**
   * A card under a message that carries a link, when anybody can say what is
   * behind it.
   *
   * A browser cannot read another site's page, so the card only exists where
   * the space has an archive: the one machine the space already trusts to be
   * awake goes and looks. The hook is null without one, and messages carry
   * plain links the way they always did. The card fills in when the answer
   * arrives; a row redrawn later asks again and is answered from the cache.
   */
  private attachPreview(line: HTMLElement, text: string): void {
    if (!this.previewFor) return
    const link = text.match(/https?:\/\/[^\s<>"')\]]+/)?.[0]
    if (!link || imageLinks(text).includes(link)) return
    const box = h('a', { class: 'link-card hidden' })
    box.href = link
    box.target = '_blank'
    box.rel = 'noreferrer noopener'
    line.append(box)
    void this.previewFor(link)
      .then((p) => {
        if (!p || (!p.title && !p.description && !p.image)) return
        const image = p.image && /^https?:\/\//.test(p.image) ? p.image : ''
        if (image) {
          const img = h('img', { class: 'link-card-img' })
          img.alt = ''
          img.loading = 'lazy'
          img.referrerPolicy = 'no-referrer'
          img.src = image
          img.addEventListener('error', () => img.remove())
          box.append(img)
        }
        let host = ''
        try {
          host = new URL(link).hostname
        } catch {
          /* the link drew a card, so it parsed once already */
        }
        box.append(
          h('div', { class: 'link-card-body stack tight' }, [
            h('div', { class: 'link-card-title truncate', text: p.title || link }),
            p.description
              ? h('div', { class: 'link-card-desc tiny', text: p.description })
              : null,
            h('div', { class: 'tiny faint truncate', text: p.site || host }),
          ]),
        )
        box.classList.remove('hidden')
      })
      .catch(() => undefined)
  }

  /**
   * A poll, drawn as a bar per answer.
   *
   * The counts are always shown, because hiding them until you vote makes
   * people vote to see them, which is a way of getting a worse answer. The bar
   * is the share of the votes cast; a poll nobody has answered draws no bars
   * rather than four empty ones.
   */
  private pollBox(m: Message): HTMLElement {
    const poll = m.poll!
    const box = h('div', { class: 'poll' })

    poll.options.forEach((option, i) => {
      const count = poll.votes.get(i)?.size ?? 0
      const share = poll.total > 0 ? Math.round((count / poll.total) * 100) : 0
      const mine = poll.mine === i

      const fill = h('div', { class: 'poll-fill' })
      fill.style.width = `${poll.total > 0 ? share : 0}%`

      box.append(
        h(
          'button',
          {
            class: `poll-option${mine ? ' on' : ''}`,
            title: mine ? 'Your answer' : `Pick "${option}"`,
            on: { click: () => this.actions?.vote(m.id, i) },
          },
          [
            fill,
            h('span', { class: 'poll-label truncate', text: option }),
            h('span', { class: 'poll-count', text: poll.total > 0 ? `${count}` : '' }),
          ],
        ),
      )
    })

    box.append(
      h('div', {
        class: 'tiny faint',
        text:
          poll.total === 0
            ? 'No answers yet'
            : `${poll.total} ${poll.total === 1 ? 'answer' : 'answers'}${
                poll.mine === null ? '' : ', including yours'
              }`,
      }),
    )
    return box
  }

  /** Take somebody to a message and light it up, from anywhere. */
  jump(id: string): void {
    this.jumpTo(id)
  }

  private jumpTo(id: string): void {
    const row = this.log.querySelector(`[data-id="${id}"]`)
    if (!(row instanceof HTMLElement)) return
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row.classList.remove('found')
    // Restart the highlight even when the same one is clicked twice.
    void row.offsetWidth
    row.classList.add('found')
  }

  private rowActions(m: Message, mine: boolean): HTMLElement {
    const bar = h('div', { class: 'chat-actions' })
    if (this.canPin) {
      bar.append(
        h('button', {
          text: m.pinned ? '\u2691' : '\u2690',
          title: m.pinned ? 'Stop holding this one up' : 'Pin this one',
          on: { click: () => this.actions?.pin(m.id, !m.pinned) },
        }),
      )
    }
    const react = h('button', {
      text: '☺',
      title: 'React',
      ariaLabel: 'React to this message',
      on: { click: () => this.reactWith(m, react) },
    })
    bar.append(
      react,
      h('button', {
        text: '↩',
        title: 'Reply here, where everybody is reading',
        ariaLabel: 'Reply',
        on: { click: () => this.startReply(m) },
      }),
    )
    /*
     * Replying in a thread rather than in the channel.
     *
     * The same event either way, carrying the same id: what changes is where it
     * is drawn. Twenty answers to one question belong under the question rather
     * than through the middle of everybody else's conversation.
     */
    if (!this.threadRoot) {
      bar.append(
        h('button', {
          text: '⌥',
          title: 'Reply in a thread',
          ariaLabel: 'Reply in a thread',
          on: { click: () => this.onThread?.(m.id) },
        }),
      )
    }
    if (mine) {
      bar.append(
        h('button', { text: '✎', title: 'Edit', ariaLabel: 'Edit', on: { click: () => this.startEdit(m) } }),
        h('button', {
          text: '✕',
          title: 'Delete for everybody who has not already read it',
          ariaLabel: 'Delete',
          on: { click: () => this.actions?.retract(m.id) },
        }),
      )
    } else if (this.canPin) {
      /*
       * Somebody has to be able to take down what was posted in a room they
       * are responsible for. Behind a question, because it is somebody else's
       * words and it cannot be undone.
       */
      bar.append(
        h('button', {
          text: '✕',
          title: `Delete this message from ${m.name || shortKey(m.author)}`,
          ariaLabel: 'Delete this message',
          on: {
            click: () => {
              const who = m.name || shortKey(m.author)
              if (!window.confirm(`Delete this message from ${who}?`)) return
              this.actions?.retract(m.id)
            },
          },
        }),
      )
    }
    return bar
  }

  /**
   * React to a message.
   *
   * A short row of the ones this person actually uses, and the whole set behind
   * one more click. This used to hang a row of five off `.chat-line:hover`,
   * which meant it appeared on whatever the pointer happened to be over rather
   * than on the message whose button was pressed, and a redraw took it away
   * mid-reach. It hangs off the button now, and the button belongs to one
   * message.
   *
   * Reacting a second time with the same emoji takes it back, so the row is a
   * toggle rather than a one way door.
   */
  private reactWith(m: Message, anchor: HTMLElement): void {
    const toggle = (emoji: string): void => {
      const mine = m.reactions.get(emoji)?.has(this.me) === true
      this.actions?.react(m.id, emoji, !mine)
    }

    const row = h('div', { class: 'emoji-quick' })
    for (const emoji of quickRow()) {
      row.append(
        h('button', {
          class: `chat-react${m.reactions.get(emoji)?.has(this.me) ? ' on' : ''}`,
          text: emoji,
          title: `React with ${emoji}`,
          on: {
            click: () => {
              toggle(emoji)
              pop.remove()
            },
          },
        }),
      )
    }
    row.append(
      h('button', {
        class: 'chat-react add',
        text: '···',
        title: 'All emoji',
        ariaLabel: 'All emoji',
        on: {
          click: () => {
            pop.remove()
            openEmojiPicker({
              anchor,
              title: 'React to this message',
              sticky: true,
              onPick: toggle,
            })
          },
        },
      }),
    )

    const pop = h('div', { class: 'emoji-pop quick' }, [row])
    closeEmojiPicker()
    document.body.append(pop)
    placeNear(pop, anchor)

    const away = (ev: Event): void => {
      if (pop.contains(ev.target as Node) || anchor.contains(ev.target as Node)) return
      pop.remove()
    }
    const key = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') pop.remove()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    // The row is short lived: whichever way it goes, the listeners go with it.
    new MutationObserver((_records, self) => {
      if (pop.isConnected) return
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
      self.disconnect()
    }).observe(document.body, { childList: true })
  }

  private startReply(m: Message): void {
    this.editing = null
    this.replyTo = m
    this.showPending(`Replying to ${m.name || shortKey(m.author)}`)
  }

  private startEdit(m: Message): void {
    this.replyTo = null
    this.editing = m
    this.textInput.value = m.text
    this.showPending('Editing your message')
    this.textInput.focus()
  }

  private showPending(label: string): void {
    clear(this.replyBar)
    this.replyBar.classList.remove('hidden')
    this.replyBar.append(
      h('span', { class: 'grow truncate', text: label }),
      h('button', { class: 'ghost', text: '✕', title: 'Cancel', on: { click: () => this.cancelPending() } }),
    )
  }

  private cancelPending(): void {
    this.replyTo = null
    if (this.editing) this.textInput.value = ''
    this.editing = null
    this.replyBar.classList.add('hidden')
    clear(this.replyBar)
  }

  /**
   * The end again, one frame after something in the log changed size.
   *
   * A frame later rather than now, because the picture knows its size before
   * the row around it has been laid out with it, and scrolling to a height
   * that is about to change is what this exists to stop.
   */
  private followMedia(): void {
    if (!this.pinned) return
    requestAnimationFrame(() => {
      if (!this.pinned) return
      this.log.scrollTop = this.log.scrollHeight
      this.showJump()
    })
  }

  private isAtBottom(): boolean {
    return this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 24
  }

  private commitName(): void {
    const next = cleanName(this.nameInput.value)
    if (!next || next === this.name) {
      this.nameInput.value = this.name
      return
    }
    this.name = next
    this.nameInput.value = next
    this.actions?.rename(next)
  }

  private submit(): void {
    const text = this.textInput.value.trim()
    if (!text) return
    // Past the limit nobody would receive it, so it does not leave the box.
    // The count beside Send has been saying so since the last stretch.
    if (!this.enabled || this.tooLong()) return
    /*
     * A line starting with a slash is an instruction rather than something to
     * say. The panel does not know what any of them mean: it hands the line to
     * whoever owns the space, and only clears the box if they took it.
     *
     * A slash followed by nothing, or by a space, is not an attempt at a
     * command; it is a message that happens to start with one. It used to be
     * scolded with "There is no /", which helped nobody say "/ 10" about a
     * film.
     */
    if (/^\/[^/\s]/.test(text) && !this.editing) {
      /*
       * Emptied before the command runs, not after.
       *
       * A command can change what the panel is showing, and changing that keeps
       * whatever is half written as a draft. With the box still full, the draft
       * kept was the command that had just been run, and it came back the next
       * time you opened the channel.
       */
      this.textInput.value = ''
      this.grow()
      this.closeSuggestions()
      this.drafts.delete(this.draftKey)
      if (this.onCommand?.(text) !== true) {
        // Nobody took it, so it goes back rather than into the bin.
        this.textInput.value = text
        this.grow()
      }
      return
    }
    this.textInput.value = ''
    this.grow()
    this.closeSuggestions()
    if (this.editing) {
      this.actions?.edit(this.editing.id, text)
    } else if (this.directWith) {
      this.actions?.sayDirect?.(this.directWith, text)
    } else if (text.startsWith('//')) {
      this.actions?.say(text.slice(1), this.replyTo?.id ?? null)
    } else if (this.threadRoot) {
      // Everything written in a thread answers its root, whichever message in
      // it was being looked at. Flat, like every thread anybody reads.
      this.actions?.say(text, this.threadRoot, true)
    } else {
      this.actions?.say(text, this.replyTo?.id ?? null)
    }
    this.cancelPending()
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g

/**
 * Turn message text into nodes.
 *
 * Bold, italic, inline code, links, mentions and line breaks, built as elements
 * rather than parsed as markup, so nothing a person types can become a tag.
 * Links open in a new tab with no referrer, because a room code lives in this
 * page's fragment and has no business travelling to somebody else's site.
 *
 * Line by line, because a message can hold several now and a newline in a text
 * node is whitespace to a browser rather than a break.
 */
export function formatText(text: string, names?: Map<string, string>, me = ''): Node[] {
  const out: Node[] = []
  const lines = text.split('\n')
  let i = 0

  /** Everything up to the closing fence, kept exactly as it was typed. */
  const fence = (): void => {
    const language = lines[i].slice(3).trim().slice(0, 20)
    const body: string[] = []
    i += 1
    while (i < lines.length && !lines[i].startsWith('```')) {
      body.push(lines[i])
      i += 1
    }
    i += 1 // the closing fence, or the end of the message
    const block = h('pre', { class: 'chat-code' }, [h('code', { text: body.join('\n') })])
    if (language) block.dataset.language = language
    out.push(block)
  }

  const quote = (): void => {
    const body: string[] = []
    while (i < lines.length && /^>\s?/.test(lines[i])) {
      body.push(lines[i].replace(/^>\s?/, ''))
      i += 1
    }
    const block = h('blockquote', { class: 'chat-quote' })
    body.forEach((line, n) => {
      if (n > 0) block.append(h('br'))
      for (const node of formatLine(line, names, me)) block.append(node)
    })
    out.push(block)
  }

  const list = (ordered: boolean): void => {
    const items: string[] = []
    const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/
    while (i < lines.length && pattern.test(lines[i])) {
      items.push(lines[i].replace(pattern, ''))
      i += 1
    }
    const block = h(ordered ? 'ol' : 'ul', { class: 'chat-list' })
    for (const item of items) {
      const li = h('li')
      for (const node of formatLine(item, names, me)) li.append(node)
      block.append(li)
    }
    out.push(block)
  }

  let plain = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      fence()
      plain = 0
      continue
    }
    if (/^>\s?/.test(line)) {
      quote()
      plain = 0
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      list(false)
      plain = 0
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      list(true)
      plain = 0
      continue
    }
    if (plain > 0) out.push(h('br'))
    for (const node of formatLine(line, names, me)) out.push(node)
    plain += 1
    i += 1
  }
  return out
}

function formatLine(text: string, names?: Map<string, string>, me = ''): Node[] {
  const out: Node[] = []
  const rest = text

  /** The @somebody parts, drawn as themselves and lit up when they are you. */
  const pushMentions = (chunk: string, plain: (s: string) => void): void => {
    const hits = names?.size ? findMentions(chunk, names) : []
    if (hits.length === 0) {
      plain(chunk)
      return
    }
    let at = 0
    for (const hit of hits) {
      if (hit.at > at) plain(chunk.slice(at, hit.at))
      const mine = hit.key === me || hit.key === EVERYONE
      out.push(h('span', { class: `mention${mine ? ' me' : ''}`, text: `@${hit.label}` }))
      at = hit.at + hit.length
    }
    if (at < chunk.length) plain(chunk.slice(at))
  }

  const pushInline = (raw: string): void => {
    pushMentions(raw, (chunk) => {
      /*
       * One pass, character by character, because the alternative is a stack of
       * regular expressions that cannot see each other.
       *
       * A backslash makes the next marker literal, which is how anybody writes
       * a file path or the shrug without it turning into italics. An underscore
       * only opens italics at the edge of a word, so snake_case survives, which
       * is the thing that would otherwise be wrong in every message a
       * programmer sends.
       */
      const MARKERS = '*_~`|\\'
      let text = ''
      const flush = (): void => {
        if (text) out.push(document.createTextNode(text))
        text = ''
      }
      let i = 0
      while (i < chunk.length) {
        const ch = chunk[i]
        if (ch === '\\' && MARKERS.includes(chunk[i + 1] ?? '')) {
          text += chunk[i + 1]
          i += 2
          continue
        }
        const rest = chunk.slice(i)
        const wordBefore = /\w/.test(chunk[i - 1] ?? '')
        let match: RegExpExecArray | null = null
        let node: Node | null = null

        if ((match = /^`([^`]+)`/.exec(rest))) node = h('code', { text: match[1] })
        else if ((match = /^\|\|([\s\S]+?)\|\|/.exec(rest))) node = spoiler(match[1])
        else if ((match = /^~~([\s\S]+?)~~/.exec(rest))) node = h('s', { text: match[1] })
        else if ((match = /^\*\*([\s\S]+?)\*\*/.exec(rest))) node = h('strong', { text: match[1] })
        else if ((match = /^\*([^*\s][\s\S]*?)\*/.exec(rest))) node = h('em', { text: match[1] })
        else if (!wordBefore && (match = /^_([^_\s][\s\S]*?)_(?!\w)/.exec(rest))) {
          node = h('em', { text: match[1] })
        }

        if (node && match) {
          flush()
          out.push(node)
          i += match[0].length
          continue
        }
        text += ch
        i += 1
      }
      flush()
    })
  }

  URL_RE.lastIndex = 0
  let last = 0
  for (const match of rest.matchAll(URL_RE)) {
    const at = match.index ?? 0
    if (at > last) pushInline(rest.slice(last, at))
    const anchor = h('a', { text: match[0] })
    anchor.href = match[0]
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    out.push(anchor)
    last = at + match[0].length
  }
  if (last < rest.length) pushInline(rest.slice(last))
  return out
}

/**
 * Pictures and GIFs, from links.
 *
 * There is no upload, because there is nowhere to upload to: the whole point
 * of this thing is that it runs without a server holding anybody's files. What
 * there is instead is the same thing every chat did before uploads existed.
 * Paste a link to a picture and the picture is what you see.
 *
 * That is enough for GIFs, which is what people actually want. Any GIF site
 * gives you a direct link, and it plays because the browser plays it: an
 * animated GIF needs no player and no permission.
 *
 * Only https, and only links that are obviously a picture. A link is still a
 * request to somebody else's server, which tells them you are here, so this
 * never follows one that could be a page.
 *
 * "Obviously a picture" used to mean the address ended in .png or .gif, and
 * that turned out to be too strict: a PNG from Twitter ends in ?format=png,
 * one from an image host often ends in nothing at all, and every one of them
 * drew as a bare link beside a GIF that drew as a picture. So there are now
 * three ways to be a picture, in order of how sure each one is.
 *
 * A wrong guess costs nothing visible. A picture that fails to load takes its
 * own frame out of the message, which leaves the link that was there anyway.
 */

/** Ends in a picture: the plain case, with or without a query after it. */
const IMAGE_RE = /\.(gif|png|jpe?g|webp|avif|apng|bmp|svg)(\?[^\s]*)?$/i
/** The extension is in the path but the address carries on past it. */
const IMAGE_PATH_RE = /\.(gif|png|jpe?g|webp|avif|apng)(\/|$)/i
/** The picture is named in the query: ?format=png, ?fm=jpg, ?ext=gif. */
const IMAGE_QUERY_RE = /(?:^|&)(?:format|fm|ext|type)=(gif|png|jpe?g|webp|avif)(?:&|$)/i

/**
 * A short clip, drawn as a picture that moves.
 *
 * Every GIF service hands out a webm or an mp4 of the same animation, a
 * fraction of the weight of the gif, and every browser plays one. So a link to
 * one is embedded like a picture: no controls, no sound, no gesture needed to
 * start it, and it goes round for ever, which is what a GIF is.
 *
 * Muted is not politeness, it is the rule: a browser refuses to start a clip
 * with sound in it until somebody clicks the page, and a clip that will not
 * start is a grey rectangle.
 */
const CLIP_RE = /\.(webm|mp4|m4v)(\?[^\s]*)?$/i

/**
 * Hosts that serve pictures and nothing else, for the links that carry no
 * extension at all. Each one is matched on the whole host or on a dot before
 * it, so example.com.evil.test is not i.imgur.com.
 */
const IMAGE_HOSTS = [
  'i.imgur.com',
  'pbs.twimg.com',
  'i.redd.it',
  'preview.redd.it',
  'cdn.discordapp.com',
  'media.discordapp.net',
  'media.tenor.com',
  'c.tenor.com',
  'media.giphy.com',
  'i.giphy.com',
  'i.ibb.co',
  'files.catbox.moe',
  'images.unsplash.com',
  'user-images.githubusercontent.com',
]

function isClipLink(url: URL): boolean {
  return CLIP_RE.test(url.pathname + url.search)
}

function looksLikePicture(url: URL): boolean {
  const query = url.search.replace(/^\?/, '')
  if (isClipLink(url)) return true
  if (IMAGE_RE.test(url.pathname + url.search)) return true
  if (IMAGE_PATH_RE.test(url.pathname)) return true
  if (IMAGE_QUERY_RE.test(query)) return true
  return IMAGE_HOSTS.includes(url.hostname.toLowerCase())
}

export function imageLinks(text: string): string[] {
  const out: string[] = []
  URL_RE.lastIndex = 0
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0]
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol !== 'https:') continue
    if (!looksLikePicture(url)) continue
    if (!out.includes(raw)) out.push(raw)
    if (out.length === 4) break // a wall of pictures is somebody else's problem
  }
  return out
}

function embed(src: string): HTMLElement {
  const media = CLIP_RE.test(src) ? clip(src) : picture(src)
  // A link that turns out to be neither leaves nothing behind.
  media.addEventListener('error', () => wrap.remove(), true)
  const wrap = h('a', { class: 'chat-image-wrap' }, [media])
  wrap.href = src
  wrap.target = '_blank'
  wrap.rel = 'noopener noreferrer'
  wrap.title = 'Look closer'
  /*
   * A plain click looks closer, right here, instead of leaving for the
   * address the picture came from. The address keeps working the way any
   * link does for a modified click, a middle click, or a copy.
   */
  wrap.addEventListener('click', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return
    ev.preventDefault()
    openLightbox(media)
  })
  return wrap
}

/**
 * The picture, as big as the window can show it.
 *
 * Over the conversation rather than instead of it: escape, or a click
 * anywhere, puts it away and hands focus back to where it was. A clip keeps
 * being a GIF that weighs less, only bigger, so it arrives already moving
 * and still has no controls to trip on.
 */
function openLightbox(media: HTMLElement): void {
  const was = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const shown = media.cloneNode(true) as HTMLElement
  shown.classList.remove('chat-image')
  shown.classList.add('lightbox-media')
  if (shown instanceof HTMLVideoElement) {
    shown.muted = true
    shown.loop = true
    void shown.play().catch(() => undefined)
  }
  /*
   * A drawing sized from its viewBox wears that size as attributes, and it
   * scales losslessly, so up close it gets the whole window: the same shape,
   * grown to fit. A raster picture keeps its own size and the style caps it.
   */
  const w = Number(shown.getAttribute('width'))
  const tall = Number(shown.getAttribute('height'))
  if (w > 0 && tall > 0) {
    const scale = Math.min((window.innerWidth * 0.94) / w, (window.innerHeight * 0.92) / tall)
    shown.style.width = `${Math.round(w * scale)}px`
    shown.style.height = `${Math.round(tall * scale)}px`
  }
  function close(): void {
    box.remove()
    was?.focus()
  }
  const box = h(
    'div',
    {
      class: 'lightbox',
      role: 'dialog',
      ariaLabel: 'Picture, up close',
      tabIndex: -1,
      on: {
        click: () => close(),
        keydown: (ev) => {
          if ((ev as KeyboardEvent).key === 'Escape') close()
        },
      },
    },
    [shown],
  )
  document.body.append(box)
  box.focus()
}

/**
 * The message, when the whole thing is one written-out svg element.
 *
 * Drawn through an img and a data: address, which is the deal every picture
 * here gets. In image context the browser runs no script the file carries,
 * fires no event handler on it, and lets nothing inside it reach the network.
 * Parsing it into the page instead is what would make those live, and it is
 * exactly what the rule at the top of this file forbids.
 *
 * Only the whole message counts. An svg element in the middle of a sentence
 * stays text, because a reader quoting markup is not posting a drawing.
 */
export function svgSource(text: string): string | null {
  const t = text.trim()
  if (t.length > MAX_TEXT) return null
  if (!/^<svg[\s>]/i.test(t)) return null
  if (!/<\/svg>$/i.test(t)) return null
  return t
}

function svgEmbed(source: string, fallback: () => void): HTMLElement {
  const img = h('img', { class: 'chat-image' })
  img.alt = 'Shared drawing'
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
  /*
   * An svg that names no width gets the browser's 300 by 150 default, which
   * draws a tall logo as a postage stamp. Its viewBox says the true shape, so
   * the size comes from there: shrunk to fit the cap every picture has, and
   * never blown up past the size it asked for.
   */
  const head = source.slice(0, source.indexOf('>') + 1)
  const shape = /viewBox\s*=\s*["']\s*[\d.+-]+[\s,]+[\d.+-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(source)
  if (!/\swidth\s*=/i.test(head) && shape) {
    const w = parseFloat(shape[1])
    const tall = parseFloat(shape[2])
    if (w > 0 && tall > 0) {
      const scale = Math.min(340 / w, 240 / tall, 1)
      img.width = Math.round(w * scale)
      img.height = Math.round(tall * scale)
    }
  }
  // A file that does not draw leaves nothing behind; the caller says what
  // stands in for it.
  img.addEventListener(
    'error',
    () => {
      wrap.remove()
      fallback()
    },
    true,
  )
  const wrap = h('span', {
    class: 'chat-image-wrap',
    role: 'button',
    tabIndex: 0,
    title: 'Look closer',
    on: {
      click: () => openLightbox(img),
      keydown: (ev) => {
        const key = (ev as KeyboardEvent).key
        if (key === 'Enter' || key === ' ') {
          ev.preventDefault()
          openLightbox(img)
        }
      },
    },
  }, [img])
  return wrap
}

function picture(src: string): HTMLElement {
  const img = h('img', { class: 'chat-image' })
  img.alt = 'Shared image'
  img.loading = 'lazy'
  img.referrerPolicy = 'no-referrer'
  img.src = src
  return img
}

function clip(src: string): HTMLElement {
  const video = h('video', { class: 'chat-image chat-clip', ariaLabel: 'Shared clip' })
  video.src = src
  video.autoplay = true
  video.loop = true
  video.muted = true
  video.playsInline = true
  video.controls = false
  video.preload = 'auto'
  // No referrer on the request, the same as every picture here. A video
  // element has no property for it, so it is set as the attribute it is.
  video.setAttribute('referrerpolicy', 'no-referrer')
  // Safari wants the attribute as well as the property before it will start
  // one without a click, and a paused clip is a still frame pretending to be
  // a GIF. The play itself can be refused, and there is nothing to do about
  // that but let the poster frame sit there.
  video.setAttribute('muted', '')
  video.setAttribute('playsinline', '')
  void video.play().catch(() => undefined)
  return video
}

function dayLabel(at: number): string {
  const day = new Date(at)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (day.toDateString() === today.toDateString()) return 'Today'
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
