import { MAX_DM_BYTES, MAX_TEXT, type Attachment, type Message } from '../store/log'
import type { SpaceFiles } from '../net/files'
import type { LinkPreview } from '../net/server-api'
import { cleanName, EVERYONE, findMentions, mentionsMe } from '../chat'
import { shortKey } from '../store/identity'
import { AttachTray, attachmentBlock } from './attachments'
import { clear, h } from './dom'
import {
  closeEmojiPicker,
  emojiFor,
  emojiStartingWith,
  openEmojiPicker,
  placeNear,
  quickReactions,
  recentEmoji,
  withEmoji,
} from './emoji'
import { icon } from './icons'
import { toast } from './toast'

const FALLBACK_REACTIONS = ['👍', '😂', '🔥', '❤️', '👀']
const QUICK_ROW_LENGTH = 5

const NAME_HUES = [205, 340, 145, 32, 265, 190, 95, 15]

function authorColour(key: string): string {
  let sum = 0
  for (let i = 0; i < key.length; i++) sum = (sum * 31 + key.charCodeAt(i)) % 100_000
  return `hsl(${NAME_HUES[sum % NAME_HUES.length]} 62% 70%)`
}

const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[‍️\u{e0020}-\u{e007f}]|[#*0-9]️?⃣|\s)+$/u
const JUMBO_MOST = 27
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function onlyEmoji(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || !EMOJI_ONLY.test(trimmed)) return false
  let faces = 0
  for (const { segment } of GRAPHEMES.segment(trimmed)) {
    if (segment.trim() && ++faces > JUMBO_MOST) return false
  }
  return faces > 0
}

const UTF8 = new TextEncoder()

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

function pinMark(): HTMLElement {
  return h('span', { class: 'chat-pinned-mark', title: 'Pinned in this channel', text: 'pinned' })
}

function quickRow(): string[] {
  const out = [...quickReactions()]
  for (const ch of [...recentEmoji(), ...FALLBACK_REACTIONS]) {
    if (out.length >= QUICK_ROW_LENGTH) break
    if (!out.includes(ch)) out.push(ch)
  }
  return out.slice(0, QUICK_ROW_LENGTH)
}

/** Picks on mousedown, because the blur that a click causes closes the list first. */
function pickOnPress(pick: () => void): { mousedown: (ev: Event) => void } {
  return {
    mousedown: (ev) => {
      ev.preventDefault()
      pick()
    },
  }
}

interface ChatActions {
  say(text: string, replyTo: string | null, inThread?: boolean, files?: Attachment[]): void
  sayDirect?(to: string, text: string, files?: Attachment[]): void
  edit(id: string, text: string): void
  react(id: string, emoji: string, on: boolean): void
  retract(id: string): void
  rename(name: string): void
  pin(id: string, on: boolean): void
  vote(id: string, choice: number): void
}

type Join = { at: number; text: string }
type Row = { key: string; sig: string; make: () => HTMLElement }
type SuggestKind = 'mention' | 'command' | 'name' | 'emoji'

const WINDOW_STEP = 120
const WINDOW_MAX = 600

export class ChatPanel {
  readonly root: HTMLElement
  actions: ChatActions | null = null
  canPin = false
  canDelete = false
  colourOf: (key: string) => string = () => ''
  onTyping: (() => void) | null = null
  onThread: ((rootId: string | null) => void) | null = null
  onDirect: ((key: string | null) => void) | null = null
  onGif: (() => void) | null = null
  onSound: (() => void) | null = null
  streamLive: ((key: string, channel: string) => boolean) | null = null
  onWatch: ((key: string, channel: string) => void) | null = null
  previewFor: ((url: string) => Promise<LinkPreview | null>) | null = null
  onCommand: ((line: string) => boolean) | null = null
  commands: { name: string; note: string; takesName?: boolean; also?: string[] }[] = []

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
  private readonly tray: AttachTray
  private readonly attachButton: HTMLButtonElement
  private readonly fileInput: HTMLInputElement
  private readonly dropCover: HTMLDivElement
  private readonly title: HTMLSpanElement
  private readonly backButton: HTMLButtonElement
  private readonly head: HTMLDivElement
  private readonly toBottom: HTMLButtonElement
  private enabled = false
  private files: SpaceFiles | null = null
  private sendWaiting = false
  private name: string
  private me = ''
  private replyTo: Message | null = null
  private editing: Message | null = null
  private names = new Map<string, string>()
  private avatars = new Map<string, string>()
  private threadRoot: string | null = null
  private directWith: string | null = null
  private directName = ''
  private readMark = 0
  private pinned = true
  private suggestions: HTMLDivElement | null = null
  private suggestAt = -1
  private suggestKind: SuggestKind | null = null
  private readonly drafts = new Map<string, string>()
  private draftKey = ''
  private olderQueued = false
  private windowSize = WINDOW_STEP
  private windowKey: string | null = null
  private lastFeed: { messages: Message[]; joins: Join[] } | null = null
  private hiddenAbove = 0
  private intro: { title: string; text: string } | null = null
  private readonly rows = new Map<string, { el: HTMLElement; sig: string }>()
  private quickFor: HTMLElement | null = null
  private found: { id: string; at: number } | null = null

  constructor(initialName: string, title = 'Chat') {
    this.name = initialName

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

    this.sendButton = h(
      'button',
      { class: 'send-button', title: 'Send (Enter)', ariaLabel: 'Send', on: { click: () => this.submit() } },
      [icon('send', 18)],
    )

    this.tray = new AttachTray(() => this.files)
    this.tray.onChange = () => {
      this.sendButton.classList.toggle('waiting', this.sendWaiting && this.tray.busy)
    }
    this.fileInput = h('input', { type: 'file', class: 'hidden', ariaLabel: 'Choose files' })
    this.fileInput.multiple = true
    this.fileInput.addEventListener('change', () => {
      this.tray.add([...(this.fileInput.files ?? [])])
      this.fileInput.value = ''
      this.textInput.focus()
    })
    this.attachButton = h(
      'button',
      {
        class: 'ghost icon-only attach-button hidden',
        title: 'Attach files. You can drop or paste them too.',
        ariaLabel: 'Attach files',
        on: { click: () => this.fileInput.click() },
      },
      [icon('paperclip', 19)],
    )
    this.textInput.addEventListener('paste', (ev) => {
      const files = [...(ev.clipboardData?.files ?? [])]
      if (files.length === 0 || !this.files || this.editing) return
      ev.preventDefault()
      this.tray.add(files)
    })
    this.dropCover = h('div', { class: 'drop-cover hidden' }, [
      h('div', { class: 'drop-card' }, [icon('paperclip', 26), h('span', { class: 'drop-words', text: 'Drop to attach' })]),
    ])
    this.emojiButton = h(
      'button',
      {
        class: 'ghost icon-only',
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
      },
      [icon('smile', 19)],
    )
    this.gifButton = h('button', {
      class: 'ghost gif-button',
      text: 'GIF',
      title: 'Find a GIF',
      ariaLabel: 'Find a GIF',
      on: { click: () => this.onGif?.() },
    })
    this.soundButton = h(
      'button',
      {
        class: 'ghost icon-only hidden',
        title: 'Soundboard',
        ariaLabel: 'Soundboard',
        on: { click: () => this.onSound?.() },
      },
      [icon('volume', 19)],
    )

    this.nameRow = h('div', { class: 'row' }, [
      h('span', { class: 'tiny faint', text: 'You', style: { width: '26px' } }),
      this.nameInput,
    ])

    this.typingLine = h('div', { class: 'chat-typing hidden' })
    this.roomLeft = h('span', { class: 'chat-room-left tiny hidden', ariaLabel: 'Room left in this message' })
    this.toBottom = h('button', {
      class: 'to-bottom hidden',
      text: 'Jump to the newest',
      title: 'Go to the end of the conversation',
    })
    let pressedAt = 0
    this.toBottom.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return
      ev.preventDefault()
      pressedAt = Date.now()
      this.jumpToNewest()
    })
    // The keyboard, and anything that clicks without pressing first.
    this.toBottom.addEventListener('click', () => {
      if (Date.now() - pressedAt > 600) this.jumpToNewest()
    })
    this.toBottom.addEventListener('pointerleave', () => this.showJump())
    this.log.addEventListener('scroll', () => {
      this.pinned = this.isAtBottom()
      this.showJump()
      if (this.log.scrollTop < 400 && this.hiddenAbove > 0) this.drawOlder()
    })
    // Media events do not bubble, hence the capture.
    this.log.addEventListener('load', () => this.followMedia(), true)
    this.log.addEventListener('loadedmetadata', () => this.followMedia(), true)
    new ResizeObserver(() => {
      if (this.pinned) this.log.scrollTop = this.log.scrollHeight
      this.showJump()
    }).observe(this.log)
    this.title = h('span', { class: 'eyebrow', text: title })
    this.backButton = h('button', {
      class: 'ghost tiny-btn hidden',
      text: '← Back',
      title: 'Back to the channel',
      on: { click: () => (this.directWith ? this.onDirect?.(null) : this.onThread?.(null)) },
    })

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
        this.tray.root,
        h('div', { class: 'row compose-box' }, [
          this.attachButton,
          this.fileInput,
          this.textInput,
          this.roomLeft,
          this.gifButton,
          this.soundButton,
          this.emojiButton,
          this.sendButton,
        ]),
      ]),
      this.dropCover,
    ])
    this.watchDrops()
  }

  setFiles(files: SpaceFiles | null): void {
    this.files = files
    this.attachButton.classList.toggle('hidden', !files)
  }

  private watchDrops(): void {
    const carriesFiles = (ev: DragEvent): boolean => !!ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')
    let depth = 0
    this.root.addEventListener('dragenter', (ev) => {
      if (!carriesFiles(ev) || !this.files || !this.enabled) return
      ev.preventDefault()
      depth += 1
      this.dropCover.classList.remove('hidden')
    })
    this.root.addEventListener('dragover', (ev) => {
      if (!carriesFiles(ev) || !this.files || !this.enabled) return
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
    })
    this.root.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) this.dropCover.classList.add('hidden')
    })
    this.root.addEventListener('drop', (ev) => {
      depth = 0
      this.dropCover.classList.add('hidden')
      if (!carriesFiles(ev) || !this.files || !this.enabled) return
      ev.preventDefault()
      this.tray.add([...(ev.dataTransfer?.files ?? [])])
      this.textInput.focus()
    })
  }

  showSoundboard(on: boolean): void {
    this.soundButton.classList.toggle('hidden', !on)
  }

  get soundAnchor(): HTMLElement {
    return this.soundButton
  }

  get gifAnchor(): HTMLElement {
    return this.gifButton
  }

  setMe(pubkey: string): void {
    this.me = pubkey
  }

  showNameField(show: boolean): void {
    this.nameRow.classList.toggle('hidden', !show)
  }

  setName(name: string): void {
    this.name = name
    if (document.activeElement !== this.nameInput) this.nameInput.value = name
  }

  setNames(names: Map<string, string>, avatars?: Map<string, string>): void {
    this.names = names
    if (avatars) this.avatars = avatars
  }

  setTitle(text: string): void {
    this.title.textContent = text
  }

  setReadMark(lamport: number): void {
    this.readMark = lamport
  }

  setThread(rootId: string | null): void {
    this.threadRoot = rootId
    this.showHead()
    this.cancelPending()
  }

  setDirect(key: string | null, name = ''): void {
    this.directWith = key
    this.directName = name
    this.showHead()
    this.cancelPending()
    this.sayRoom()
  }

  private showHead(): void {
    const away = this.threadRoot !== null || this.directWith !== null
    this.backButton.classList.toggle('hidden', !away)
    this.head.classList.toggle('hidden', !away)
    this.textInput.placeholder = this.modePlaceholder()
  }

  private modePlaceholder(): string {
    if (this.directWith) return `Message ${this.directName || 'them'}`
    return this.threadRoot ? 'Reply in this thread' : 'Say something'
  }

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
    this.textInput.placeholder = enabled ? this.modePlaceholder() : why || 'Connecting...'
    this.sayRoom()
  }

  focus(): void {
    this.textInput.focus()
  }

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

  private onComposeKey(ev: KeyboardEvent): void {
    if (this.suggestions && this.onSuggestKey(ev)) return
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      this.submit()
      return
    }
    if (ev.key === 'ArrowUp' && !this.textInput.value && !this.editing) {
      const shown = this.lastFeed?.messages ?? []
      const mine = [...shown].reverse().find((m) => m.author === this.me && !m.poll)
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

  private drawOlder(): void {
    if (this.olderQueued || !this.lastFeed) return
    this.olderQueued = true
    requestAnimationFrame(() => {
      this.olderQueued = false
      if (!this.lastFeed || this.hiddenAbove === 0) return
      const fromBottom = this.log.scrollHeight - this.log.scrollTop
      this.windowSize += WINDOW_STEP
      this.render(this.lastFeed.messages, this.lastFeed.joins)
      this.log.scrollTop = this.log.scrollHeight - fromBottom
    })
  }

  private showJump(): void {
    const gap = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight
    const shown = !this.toBottom.classList.contains('hidden')
    const want = shown ? gap > 60 || this.toBottom.matches(':hover') : gap > 300
    this.toBottom.classList.toggle('hidden', !want)
  }

  private jumpToNewest(): void {
    this.pinned = true
    this.log.scrollTop = this.log.scrollHeight
    this.toBottom.classList.add('hidden')
  }

  keepDraft(): void {
    if (!this.draftKey) return
    const half = this.textInput.value
    if (half) this.drafts.set(this.draftKey, half)
    else this.drafts.delete(this.draftKey)
  }

  useDraft(key: string): void {
    if (key === this.draftKey) return
    this.keepDraft()
    this.tray.clear()
    this.sendWaiting = false
    this.draftKey = key
    this.textInput.value = this.drafts.get(key) ?? ''
    this.grow()
  }

  private grow(): void {
    const input = this.textInput
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 116)}px`
    this.sayRoom()
  }

  private limit(): number {
    return this.directWith ? MAX_DM_BYTES : MAX_TEXT
  }

  private room(): number {
    const value = this.textInput.value
    // A sealed message counts plain bytes; a channel message counts the bytes of its JSON form.
    return this.limit() - UTF8.encode(this.directWith ? value : JSON.stringify(value)).length
  }

  private sayRoom(): void {
    const left = this.room()
    const near = left <= Math.max(200, Math.round(this.limit() / 12))
    this.roomLeft.classList.toggle('hidden', !near)
    this.roomLeft.classList.toggle('over', left < 0)
    this.roomLeft.textContent = left < 0 ? `${-left} too many` : `${left} left`
    this.sendButton.disabled = !this.enabled || left < 0
  }

  private showSuggestions(kind: SuggestKind, at: number, options: HTMLElement[]): void {
    this.suggestAt = at
    this.suggestKind = kind
    options[0]?.classList.add('on')
    const list = this.suggestions ?? h('div', { class: 'mention-pop' })
    clear(list)
    list.append(...options)
    if (!this.suggestions) {
      this.suggestions = list
      document.body.append(list)
    }
    placeNear(list, this.textInput)
  }

  private nameHits(fragment: string): string[] {
    const wanted = fragment.toLowerCase()
    const hits: string[] = []
    for (const [key, name] of this.names) {
      if (hits.length === 6) break
      if (name && key !== this.me && name.toLowerCase().startsWith(wanted)) hits.push(name)
    }
    return hits
  }

  private suggest(): void {
    if (this.suggestCommands()) return
    if (this.suggestEmoji()) return
    const input = this.textInput
    const before = input.value.slice(0, input.selectionStart ?? 0)
    const at = before.lastIndexOf('@')
    const startsWord = at === 0 || (at > 0 && /[\s(]/.test(before[at - 1]))
    const fragment = at === -1 ? '' : before.slice(at + 1)
    if (at === -1 || !startsWord || fragment.length > 24 || fragment.includes('\n')) {
      this.closeSuggestions()
      return
    }

    const hits = this.nameHits(fragment)
    if (fragment === '' || 'everyone'.startsWith(fragment.toLowerCase())) hits.unshift('everyone')
    if (hits.length === 0) {
      this.closeSuggestions()
      return
    }
    this.showSuggestions(
      'mention',
      at,
      hits.map((name) =>
        h('button', { class: 'mention-option', text: name, on: pickOnPress(() => this.takeSuggestion(name)) }),
      ),
    )
  }

  private suggestEmoji(): boolean {
    const input = this.textInput
    const caret = input.selectionStart ?? 0
    const before = input.value.slice(0, caret)
    const finished = /(^|[\s(]):([a-z0-9_+-]{1,32}):$/i.exec(before)
    if (finished) {
      const ch = emojiFor(finished[2])
      if (ch) {
        const start = caret - finished[2].length - 2
        input.value = input.value.slice(0, start) + ch + input.value.slice(caret)
        input.setSelectionRange(start + ch.length, start + ch.length)
        this.closeSuggestions()
        this.grow()
        return true
      }
    }
    const typing = /(^|[\s(]):([a-z0-9_+-]{2,32})$/i.exec(before)
    if (!typing) return false
    const hits = emojiStartingWith(typing[2])
    if (hits.length === 0) {
      this.closeSuggestions()
      return true
    }
    this.showSuggestions(
      'emoji',
      caret - typing[2].length - 1,
      hits.map(({ code, ch }) =>
        h(
          'button',
          { class: 'mention-option emoji-option', data: { emoji: ch }, on: pickOnPress(() => this.takeEmoji(ch)) },
          [h('span', { class: 'emoji-option-face', text: ch }), h('span', { class: 'tiny faint', text: `:${code}:` })],
        ),
      ),
    )
    return true
  }

  private suggestCommands(): boolean {
    const value = this.textInput.value
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\n')) return false
    const space = value.indexOf(' ')
    if (space !== -1) return this.suggestPerson(value, space)
    const wanted = value.slice(1).toLowerCase()
    const hits = this.commands.filter((c) => c.name.startsWith(wanted))
    if (hits.length === 0) {
      this.closeSuggestions()
      return true
    }
    this.showSuggestions(
      'command',
      0,
      hits.map((command) =>
        h(
          'button',
          {
            class: 'mention-option',
            on: pickOnPress(() => {
              this.textInput.value = `/${command.name} `
              this.closeSuggestions()
              this.textInput.focus()
            }),
          },
          [h('span', { text: `/${command.name}` }), h('span', { class: 'tiny faint', text: command.note })],
        ),
      ),
    )
    return true
  }

  private suggestPerson(value: string, space: number): boolean {
    const typed = value.slice(1, space).toLowerCase()
    const command = this.commands.find((c) => c.name === typed || c.also?.includes(typed))
    if (!command?.takesName) return false
    const caret = this.textInput.selectionStart ?? 0
    const start = space + 1
    if (caret < start) return false
    const fragment = value.slice(start, caret)
    if (fragment.length > 32) return false

    const hits = this.nameHits(fragment)
    if (hits.length === 0) return false
    this.showSuggestions(
      'name',
      start,
      hits.map((name) =>
        h('button', { class: 'mention-option', text: name, on: pickOnPress(() => this.takeName(name)) }),
      ),
    )
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
    if (ev.key === 'Enter' && this.suggestKind === 'command') {
      this.closeSuggestions()
      return false
    }
    if ((ev.key === 'Enter' || ev.key === 'Tab') && this.suggestKind === 'emoji') {
      const chosen = options[at === -1 ? 0 : at] as HTMLElement | undefined
      if (chosen?.dataset.emoji) this.takeEmoji(chosen.dataset.emoji)
      ev.preventDefault()
      return true
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

  private replaceSuggested(insert: string): void {
    const input = this.textInput
    const head = input.value.slice(0, this.suggestAt)
    const tail = input.value.slice(input.selectionStart ?? 0)
    input.value = head + insert + tail
    const at = head.length + insert.length
    input.setSelectionRange(at, at)
    this.closeSuggestions()
    input.focus()
    this.grow()
  }

  private takeEmoji(ch: string): void {
    this.replaceSuggested(ch)
  }

  private takeSuggestion(name: string): void {
    this.replaceSuggested(`@${name} `)
  }

  private takeName(name: string): void {
    const tail = this.textInput.value.slice(this.textInput.selectionStart ?? 0)
    this.replaceSuggested(tail.startsWith(' ') ? name : `${name} `)
  }

  private closeSuggestions(): void {
    this.suggestions?.remove()
    this.suggestions = null
    this.suggestAt = -1
    this.suggestKind = null
  }

  setIntro(intro: { title: string; text: string } | null): void {
    this.intro = intro
  }

  render(messages: Message[], joins: Join[] = []): void {
    this.lastFeed = { messages, joins }
    const stuck = this.isAtBottom()

    const all = messages
    let byId: Map<string, Message> | null = null
    const parentOf = (m: Message): Message | undefined =>
      m.replyTo ? (byId ??= new Map(all.map((x) => [x.id, x]))).get(m.replyTo) : undefined

    if (this.windowKey !== this.draftKey) {
      this.windowKey = this.draftKey
      this.windowSize = WINDOW_STEP
      if (this.readMark > 0) {
        const first = messages.findIndex((m) => m.lamport > this.readMark && m.author !== this.me)
        if (first >= 0) {
          this.windowSize = Math.min(WINDOW_MAX, Math.max(WINDOW_STEP, messages.length - first + 20))
        }
      }
    }
    const start = Math.max(0, messages.length - this.windowSize)
    this.hiddenAbove = start
    if (start > 0) {
      const since = messages[start].at
      messages = messages.slice(start)
      joins = joins.filter((j) => j.at >= since)
    }
    // Messages keep the log order every peer agrees on; notes merge in by wall clock.
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

    const items: Row[] = []
    const intro = this.intro
    if (intro && this.hiddenAbove === 0 && !this.threadRoot) {
      items.push({
        key: 'intro',
        sig: `${intro.title}|${intro.text}`,
        make: () =>
          h('div', { class: 'chat-intro' }, [
            h('div', { class: 'chat-intro-title', text: intro.title }),
            h('div', { class: 'chat-intro-text', text: intro.text }),
          ]),
      })
    }
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
      const parent = parentOf(m)
      const callsMe = m.text.includes('@') && mentionsMe(m.text, this.names, this.me)
      const live = !!m.live && m.author !== this.me && !!this.streamLive?.(m.author, m.channel)
      items.push({
        key: `m:${m.id}`,
        sig: this.signature(m, first, parent, callsMe, live),
        make: () => this.messageRow(m, first, parent, callsMe, live),
      })

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

  /** Must hold every value messageRow reads, or that value stops updating. */
  private signature(m: Message, first: boolean, parent: Message | undefined, callsMe: boolean, live: boolean): string {
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
    return [
      m.text,
      `${m.files?.map((f) => f.id.slice(0, 8)).join(',') ?? ''}${this.files ? '+' : ''}`,
      m.name ?? '',
      this.avatars.get(m.author) ?? '',
      m.at,
      m.edited ? 'e' : '',
      m.pinned ? 'p' : '',
      m.emote ? 'm' : '',
      live ? 'live' : '',
      m.replies ?? 0,
      first ? 'f' : '',
      this.canPin ? 'a' : '',
      this.canDelete ? 'd' : '',
      this.colourOf(m.author),
      parent ? this.colourOf(parent.author) : '',
      callsMe ? 'c' : '',
      this.threadRoot === m.id ? 'root' : '',
      parent ? `${parent.name ?? ''}:${parent.text.slice(0, 60)}` : m.replyTo ? 'gone' : '',
      reactions,
      poll,
    ].join('\u0001')
  }

  private reconcile(items: Row[]): void {
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

  private messageRow(
    m: Message,
    first: boolean,
    parent: Message | undefined,
    callsMe: boolean,
    live: boolean,
  ): HTMLElement {
    const mine = m.author === this.me
    const who = m.name || shortKey(m.author)
    const at = h('span', { class: 'chat-at', text: CLOCK.format(m.at) })
    const line = h('div', {
      class: `chat-line${mine ? ' mine' : ''}${m.pinned ? ' pinned' : ''}${callsMe ? ' calls-me' : ''}`,
    })
    line.dataset.id = m.id
    // Drawn again while lit: the light carries on from where it had got to.
    const since = this.found?.id === m.id ? Date.now() - this.found.at : Infinity
    if (since < 5000) {
      line.classList.add('found')
      line.style.animationDelay = `-${since}ms`
    }
    const row = h('div', { class: `chat-row${mine ? ' mine' : ''}` }, [line])
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

    if (m.replyTo && m.replyTo !== this.threadRoot) {
      let quoted: HTMLElement | null = null
      if (parent) {
        quoted = h('span', { class: 'chat-reply-name', text: parent.name || shortKey(parent.author) })
        const colour = this.colourOf(parent.author)
        if (colour) quoted.style.color = colour
      }
      line.append(
        h(
          'button',
          {
            class: 'chat-reply truncate',
            title: parent ? 'Go to what this answers' : 'That message is no longer here',
            on: { click: () => parent && this.jump(parent.id) },
          },
          parent
            ? [quoted, `: ${parent.text.slice(0, 60) || (parent.files?.length ? 'a file' : '')}`]
            : ['a message that is gone'],
        ),
      )
    }
    if (this.threadRoot && m.id === this.threadRoot) line.classList.add('thread-root')

    if (first) {
      const name = h('span', { class: 'chat-name', text: who })
      const colour = this.colourOf(m.author)
      if (colour) name.style.color = colour
      row.classList.add('first')
      line.append(
        h('div', { class: 'chat-who' }, [
          avatarOf(m.author, m.name ?? '', this.avatars.get(m.author) ?? '', 40),
          name,
          at,
          m.pinned ? pinMark() : null,
        ]),
      )
    } else {
      at.classList.add('on-hover')
      if (m.pinned) line.append(h('div', { class: 'chat-who' }, [pinMark()]))
      line.classList.add('runs-on')
    }

    const text = h('span', { class: `chat-text${m.emote ? ' emote' : ''}` })
    if (m.emote) text.append(document.createTextNode(`${who} `))
    if (m.poll) {
      text.append(h('strong', { text: m.poll.question }))
      line.append(text, this.pollBox(m))
    } else {
      const svg = m.emote ? null : svgSource(m.text)
      if (svg) {
        line.classList.add('has-picture')
        line.append(
          svgEmbed(svg, () => {
            line.classList.remove('has-picture')
            for (const node of formatText(m.text, this.names, this.me)) text.append(node)
            line.prepend(text)
          }),
        )
      }
      const links = imageLinks(m.text)
      const pictures = svg ? [] : links
      const bare = !m.emote && pictures.length === 1 && m.text.trim() === pictures[0]
      if (pictures.length > 0) line.classList.add('has-picture')
      const onlyFiles = !m.text && (m.files?.length ?? 0) > 0
      const beside =
        !m.emote && pictures.length > 0 ? pictures.reduce((rest, src) => rest.split(src).join(' '), m.text).trim() : ''
      if (onlyEmoji(beside)) {
        text.classList.add('jumbo')
        text.append(beside)
        line.append(text)
      } else if (!bare && !svg && !onlyFiles) {
        if (pictures.length > 0) text.classList.add('boxed')
        else if (!m.emote && onlyEmoji(m.text)) text.classList.add('jumbo')
        for (const node of formatText(m.text, this.names, this.me)) text.append(node)
        line.append(text)
      }
      for (const src of pictures) line.append(embed(src))
      if (m.files?.length) line.append(attachmentBlock(m.files, this.files))
      this.attachPreview(line, m.text, links)
    }

    if (live) {
      line.append(
        h('button', {
          class: 'chat-join primary',
          text: 'Join stream',
          title: `Put ${who}’s screen on yours`,
          on: { click: () => this.onWatch?.(m.author, m.channel) },
        }),
      )
    }

    if (m.edited) line.append(h('span', { class: 'chat-edited', text: '(edited)' }))
    if (!first) line.append(at)

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
      for (const [emoji, people] of m.reactions) {
        const on = people.has(this.me)
        reacts.append(
          h('button', {
            class: `chat-react${on ? ' on' : ''}`,
            text: `${emoji} ${people.size}`,
            title: on ? 'Take yours back' : 'React with this too',
            on: { click: () => this.actions?.react(m.id, emoji, !people.has(this.me)) },
          }),
        )
      }
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

    line.append(this.rowActions(m, mine, who))
    return row
  }

  private attachPreview(line: HTMLElement, text: string, pictures: string[]): void {
    if (!this.previewFor) return
    const link = text.match(/https?:\/\/[^\s<>"')\]]+/)?.[0]
    if (!link || pictures.includes(link)) return
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
          /* leave the host empty */
        }
        box.append(
          h('div', { class: 'link-card-body stack tight' }, [
            h('div', { class: 'link-card-title truncate', text: p.title || link }),
            p.description ? h('div', { class: 'link-card-desc tiny', text: p.description }) : null,
            h('div', { class: 'tiny faint truncate', text: p.site || host }),
          ]),
        )
        box.classList.remove('hidden')
      })
      .catch(() => undefined)
  }

  private pollBox(m: Message): HTMLElement {
    const poll = m.poll!
    const box = h('div', { class: 'poll' })

    poll.options.forEach((option, i) => {
      const count = poll.votes.get(i)?.size ?? 0
      const share = poll.total > 0 ? Math.round((count / poll.total) * 100) : 0
      const mine = poll.mine === i

      const fill = h('div', { class: 'poll-fill' })
      fill.style.width = `${share}%`

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

  jump(id: string): void {
    if (!this.log.querySelector(`[data-id="${id}"]`) && this.lastFeed) {
      const { messages, joins } = this.lastFeed
      const at = messages.findIndex((m) => m.id === id)
      if (at >= 0) {
        this.windowSize = messages.length - at + 20
        this.render(messages, joins)
      }
    }
    const row = this.log.querySelector(`[data-id="${id}"]`)
    if (!(row instanceof HTMLElement)) return
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    this.found = { id, at: Date.now() }
    row.classList.remove('found')
    // Restart the highlight even when the same one is clicked twice.
    void row.offsetWidth
    row.classList.add('found')
  }

  private rowActions(m: Message, mine: boolean, who: string): HTMLElement {
    const bar = h('div', { class: 'chat-actions' })
    if (this.canPin) {
      bar.append(
        h(
          'button',
          {
            class: m.pinned ? 'on' : '',
            title: m.pinned ? 'Stop holding this one up' : 'Pin this one',
            ariaLabel: m.pinned ? 'Unpin' : 'Pin',
            on: { click: () => this.actions?.pin(m.id, !m.pinned) },
          },
          [icon('pin', 17)],
        ),
      )
    }
    const react = h(
      'button',
      {
        title: 'React',
        ariaLabel: 'React to this message',
        on: { click: () => this.reactWith(m, react) },
      },
      [icon('smile', 17)],
    )
    bar.append(
      react,
      h(
        'button',
        {
          title: 'Reply here, where everybody is reading',
          ariaLabel: 'Reply',
          on: { click: () => this.startReply(m) },
        },
        [icon('reply', 17)],
      ),
    )
    if (!this.threadRoot) {
      bar.append(
        h(
          'button',
          {
            title: 'Reply in a thread',
            ariaLabel: 'Reply in a thread',
            on: { click: () => this.onThread?.(m.id) },
          },
          [icon('thread', 17)],
        ),
      )
    }
    if (mine) {
      bar.append(
        h('button', { title: 'Edit', ariaLabel: 'Edit', on: { click: () => this.startEdit(m) } }, [icon('edit', 17)]),
        h(
          'button',
          {
            class: 'danger',
            title: 'Delete for everybody who has not already read it',
            ariaLabel: 'Delete',
            on: { click: () => this.actions?.retract(m.id) },
          },
          [icon('trash', 17)],
        ),
      )
    } else if (this.canDelete) {
      bar.append(
        h(
          'button',
          {
            class: 'danger',
            title: `Delete this message from ${who}`,
            ariaLabel: 'Delete this message',
            on: {
              click: () => {
                if (!window.confirm(`Delete this message from ${who}?`)) return
                this.actions?.retract(m.id)
              },
            },
          },
          [icon('trash', 17)],
        ),
      )
    }
    return bar
  }

  private reactWith(m: Message, anchor: HTMLElement): void {
    const already = document.querySelector('.emoji-pop.quick')
    if (already && this.quickFor === anchor) {
      already.remove()
      this.quickFor = null
      return
    }
    this.quickFor = anchor
    const reacted = (emoji: string): boolean => m.reactions.get(emoji)?.has(this.me) === true
    const toggle = (emoji: string): void => {
      this.actions?.react(m.id, emoji, !reacted(emoji))
    }

    const row = h('div', { class: 'emoji-quick' })
    for (const emoji of quickRow()) {
      row.append(
        h('button', {
          class: `chat-react${reacted(emoji) ? ' on' : ''}`,
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

  /** Waits a frame, because a loaded picture resizes its row only after the next layout. */
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
    const typed = this.textInput.value.trim()
    const isCommand = /^\/[^/\s]/.test(typed)
    const text = isCommand ? typed : withEmoji(typed)
    const attaching = this.tray.count > 0 && !this.editing
    if (!text && !attaching) return
    if (!this.enabled || this.room() < 0) return
    if (attaching) {
      if (this.tray.failed) {
        toast('A file did not upload. Take it off, or attach it again.', 'warn')
        return
      }
      if (this.tray.busy) {
        this.sendWaiting = true
        this.sendButton.classList.add('waiting')
        void this.tray.whenSettled().then(() => {
          if (!this.sendWaiting) return
          this.sendWaiting = false
          this.sendButton.classList.remove('waiting')
          this.submit()
        })
        return
      }
    }
    const files = attaching ? this.tray.ready : []
    if (isCommand && !this.editing && !attaching) {
      // Emptied before the command runs, so a command that switches view does not keep itself as a draft.
      this.textInput.value = ''
      this.grow()
      this.closeSuggestions()
      this.drafts.delete(this.draftKey)
      if (this.onCommand?.(text) !== true) {
        this.textInput.value = text
        this.grow()
      }
      return
    }
    this.textInput.value = ''
    this.grow()
    this.closeSuggestions()
    if (files.length) this.tray.clear()
    if (this.editing) {
      this.actions?.edit(this.editing.id, text)
    } else if (this.directWith) {
      this.actions?.sayDirect?.(this.directWith, text, files)
    } else if (text.startsWith('//')) {
      this.actions?.say(text.slice(1), this.replyTo?.id ?? null, false, files)
    } else if (this.threadRoot) {
      this.actions?.say(text, this.threadRoot, true, files)
    } else {
      this.actions?.say(text, this.replyTo?.id ?? null, false, files)
    }
    this.cancelPending()
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g
const ESCAPABLE = '*_~`|\\'
const INLINE_OPENERS = '`|~*_'

/** Builds DOM nodes, never HTML, so nothing a person types can become markup. */
function formatText(text: string, names: Map<string, string>, me: string): Node[] {
  const out: Node[] = []
  const lines = text.split('\n')
  let i = 0

  const fence = (): void => {
    const language = lines[i].slice(3).trim().slice(0, 20)
    const body: string[] = []
    i += 1
    while (i < lines.length && !lines[i].startsWith('```')) {
      body.push(lines[i])
      i += 1
    }
    i += 1
    const block = h('pre', { class: 'chat-code' }, [h('code', { text: body.join('\n') })])
    if (language) block.dataset.language = language
    out.push(block)
  }

  const quote = (): void => {
    const block = h('blockquote', { class: 'chat-quote' })
    let n = 0
    while (i < lines.length && /^>\s?/.test(lines[i])) {
      if (n > 0) block.append(h('br'))
      for (const node of formatLine(lines[i].replace(/^>\s?/, ''), names, me)) block.append(node)
      n += 1
      i += 1
    }
    out.push(block)
  }

  const list = (ordered: boolean): void => {
    const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/
    const block = h(ordered ? 'ol' : 'ul', { class: 'chat-list' })
    while (i < lines.length && pattern.test(lines[i])) {
      block.append(h('li', {}, formatLine(lines[i].replace(pattern, ''), names, me)))
      i += 1
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

function formatLine(line: string, names: Map<string, string>, me: string): Node[] {
  const out: Node[] = []

  const pushMentions = (chunk: string, plain: (s: string) => void): void => {
    const hits = names.size && chunk.includes('@') ? findMentions(chunk, names) : []
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
      let text = ''
      const flush = (): void => {
        if (text) out.push(document.createTextNode(text))
        text = ''
      }
      let i = 0
      while (i < chunk.length) {
        const ch = chunk[i]
        if (ch === '\\' && ESCAPABLE.includes(chunk[i + 1] ?? '')) {
          text += chunk[i + 1]
          i += 2
          continue
        }
        if (INLINE_OPENERS.includes(ch)) {
          const rest = chunk.slice(i)
          let match: RegExpExecArray | null = null
          let node: Node | null = null
          if ((match = /^`([^`]+)`/.exec(rest))) node = h('code', { text: match[1] })
          else if ((match = /^\|\|([\s\S]+?)\|\|/.exec(rest))) node = spoiler(match[1])
          else if ((match = /^~~([\s\S]+?)~~/.exec(rest))) node = h('s', { text: match[1] })
          else if ((match = /^\*\*([\s\S]+?)\*\*/.exec(rest))) node = h('strong', { text: match[1] })
          else if ((match = /^\*([^*\s][\s\S]*?)\*/.exec(rest))) node = h('em', { text: match[1] })
          else if (!/\w/.test(chunk[i - 1] ?? '') && (match = /^_([^_\s][\s\S]*?)_(?!\w)/.exec(rest))) {
            node = h('em', { text: match[1] })
          }
          if (node && match) {
            flush()
            out.push(node)
            i += match[0].length
            continue
          }
        }
        text += ch
        i += 1
      }
      flush()
    })
  }

  let last = 0
  for (const match of line.matchAll(URL_RE)) {
    const at = match.index ?? 0
    if (at > last) pushInline(line.slice(last, at))
    const anchor = h('a', { text: match[0] })
    anchor.href = match[0]
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    out.push(anchor)
    last = at + match[0].length
  }
  if (last < line.length) pushInline(line.slice(last))
  return out
}

const IMAGE_RE = /\.(gif|png|jpe?g|webp|avif|apng|bmp|svg)(\?[^\s]*)?$/i
const IMAGE_PATH_RE = /\.(gif|png|jpe?g|webp|avif|apng)(\/|$)/i
const IMAGE_QUERY_RE = /(?:^|&)(?:format|fm|ext|type)=(gif|png|jpe?g|webp|avif)(?:&|$)/i
const CLIP_RE = /\.(webm|mp4|m4v)(\?[^\s]*)?$/i

const IMAGE_HOSTS = new Set([
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
])

const MAX_PICTURES = 4

function looksLikePicture(url: URL): boolean {
  const pathAndQuery = url.pathname + url.search
  return (
    CLIP_RE.test(pathAndQuery) ||
    IMAGE_RE.test(pathAndQuery) ||
    IMAGE_PATH_RE.test(url.pathname) ||
    IMAGE_QUERY_RE.test(url.search.replace(/^\?/, '')) ||
    IMAGE_HOSTS.has(url.hostname.toLowerCase())
  )
}

export function imageLinks(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0]
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' || !looksLikePicture(url)) continue
    if (!out.includes(raw)) out.push(raw)
    if (out.length === MAX_PICTURES) break
  }
  return out
}

function embed(src: string): HTMLElement {
  const media = CLIP_RE.test(src) ? clip(src) : picture(src)
  media.addEventListener('error', () => wrap.remove(), true)
  const wrap = h('a', { class: 'chat-image-wrap' }, [media])
  wrap.href = src
  wrap.target = '_blank'
  wrap.rel = 'noopener noreferrer'
  wrap.title = 'Look closer'
  wrap.addEventListener('click', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return
    ev.preventDefault()
    openLightbox(media)
  })
  return wrap
}

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

function svgSource(text: string): string | null {
  const t = text.trim()
  if (t.length > MAX_TEXT) return null
  if (!/^<svg[\s>]/i.test(t)) return null
  if (!/<\/svg>$/i.test(t)) return null
  return t
}

/** Only ever drawn through an img: in image context an SVG runs no script and loads nothing. */
function svgEmbed(source: string, fallback: () => void): HTMLElement {
  const img = h('img', { class: 'chat-image' })
  img.alt = 'Shared drawing'
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
  // Without a width the browser draws 300 by 150, so size it from the viewBox.
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
  img.addEventListener(
    'error',
    () => {
      wrap.remove()
      fallback()
    },
    true,
  )
  const wrap = h(
    'span',
    {
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
    },
    [img],
  )
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
  // A video element has no referrerPolicy property, so it is set as an attribute.
  video.setAttribute('referrerpolicy', 'no-referrer')
  // Safari needs the attributes as well as the properties before it will autoplay.
  video.setAttribute('muted', '')
  video.setAttribute('playsinline', '')
  void video.play().catch(() => undefined)
  return video
}

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function dayLabel(at: number): string {
  const day = new Date(at).toDateString()
  const today = new Date()
  if (day === today.toDateString()) return 'Today'
  if (day === new Date(today.getTime() - 86_400_000).toDateString()) return 'Yesterday'
  return DAY.format(at)
}
