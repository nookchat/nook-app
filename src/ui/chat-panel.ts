import { MAX_DM_BYTES, MAX_TEXT, type Attachment, type Embed, type Message } from '../store/log'
import type { SpaceFiles } from '../net/files'
import type { LinkPreview } from '../net/server-api'
import { seesRecordings } from '../net/recordings'
import { cleanName, EVERYONE, findMentions, findSpoilers, mentionsMe, type SpoilerRange } from '../chat'
import { CLIP_RE, hasMedia, imageLinks, isDrawing } from '../pictures'
import { shortKey } from '../store/identity'
import { canRecordVoice, recordVoice, voiceSeconds, type VoiceRecording } from '../media/voice-note'
import { AttachTray, attachmentBlock } from './attachments'
import { clear, copyText, h, roleInk } from './dom'
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
import { ghost, typingWords } from './ghost'
import { familyOf, highlight } from './highlight'
import { icon } from './icons'
import { spinner } from './spinner'
import { quietKeyboard } from './keyboard'
import { closeMenu, onContextMenu, type MenuEntry } from './menu'
import { playWhileSeen } from './clips'
import { asSheet, phone } from './gestures'
import { fitInView, fitNear, fitOver } from './place'
import { spoilerReveal } from './spoiler-reveal'
import { toast } from './toast'
import { emojiField, type FieldMark, REDRAW_FIELD } from './twemoji'

const FALLBACK_REACTIONS = ['👍', '😂', '🔥', '❤️', '👀']
const QUICK_ROW_LENGTH = 5
const GROUP_GAP = 5 * 60_000


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

/** 0 for black to 1 for white, or 0 for anything that is not a plain colour. */
function brightness(colour: string): number {
  let rgb: number[] = []
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim())
  if (hex) {
    const full = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  } else {
    const fn = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(colour.trim())
    if (fn) rgb = fn.slice(1, 4).map(Number)
  }
  if (rgb.length !== 3) return 0
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
}

/** A reaction chip swells, bursts into a few bits and is gone, then the change goes out. */
function popChip(chip: HTMLElement, then: () => void): void {
  if (chip.classList.contains('popping')) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    then()
    return
  }
  chip.classList.add('popping')
  const burst = h('span', { class: 'react-burst' })
  for (let i = 0; i < 8; i++) {
    const bit = h('i')
    bit.style.setProperty('--turn', `${i * 45 + 22}deg`)
    burst.append(bit)
  }
  chip.after(burst)
  burst.style.left = `${chip.offsetLeft + chip.offsetWidth / 2}px`
  burst.style.top = `${chip.offsetTop + chip.offsetHeight / 2}px`
  window.setTimeout(() => {
    burst.remove()
    then()
  }, 320)
}

export function avatarOf(key: string, name: string, picture: string, size = 20): HTMLElement {
  const box = h('span', { class: 'avatar', title: name || shortKey(key) })
  box.style.width = `${size}px`
  box.style.height = `${size}px`
  if (picture) {
    box.classList.add('has-picture')
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
  box.style.fontSize = `${Math.round(size * 0.44)}px`
  box.append(h('span', { text: letters || '?' }))
  return box
}

/** What a right click on a picture or a link adds over the message's own menu. */
function mediaMenu(hit: Element): MenuEntry[] {
  const lead = (name: Parameters<typeof icon>[0]): HTMLElement => h('span', { class: 'menu-icon' }, [icon(name, 16)])
  const out: MenuEntry[] = []
  const picture = hit.closest<HTMLElement>('.chat-image-wrap, .att-tile:not(.att-video)')
  if (picture) out.push({ label: 'Open picture', lead: lead('expand'), run: () => picture.click() })
  const link = hit.closest<HTMLAnchorElement>('a[href]')
  const href = link && /^https?:/i.test(link.href) ? link.href : ''
  if (href) {
    out.push(
      { label: 'Open link', lead: lead('link'), run: () => void window.open(href, '_blank', 'noopener,noreferrer') },
      {
        label: 'Copy link',
        lead: lead('copy'),
        run: () => void copyText(href).then((ok) => toast(ok ? 'Link copied.' : 'Could not copy it.', ok ? 'info' : 'warn')),
      },
    )
  }
  if (out.length) out.push('line')
  return out
}

/** A new message fades in and rises, once. */
function arrive(el: HTMLElement): void {
  el.classList.add('arriving')
  el.addEventListener('animationend', function done(ev) {
    if (ev.target !== el) return
    el.classList.remove('arriving')
    el.removeEventListener('animationend', done)
  })
}

/** A deleted message drifts up and fades, then leaves the log. */
function vanish(el: HTMLElement): void {
  el.classList.add('nook-vanish')
  el.setAttribute('aria-hidden', 'true')
  const gone = (): void => el.remove()
  el.addEventListener('animationend', (ev) => {
    if (ev.target === el) gone()
  })
  // With reduced motion there is no animation to end.
  window.setTimeout(gone, 700)
}

/** What came with a pinned message, in words: "a video", "2 pictures", "report.pdf". */
function pinnedFiles(m: Message): string {
  const files = m.files ?? []
  if (files.length === 1 && !/^(image|video|audio)\//.test(files[0].type)) return files[0].name
  const kinds = new Map<string, number>()
  for (const f of files) {
    const kind = f.type.startsWith('image/') ? 'picture' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'sound' : 'file'
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  }
  return [...kinds].map(([kind, n]) => (n === 1 ? `a ${kind}` : `${n} ${kind}s`)).join(', ')
}

/** Sets delete apart from the actions before it in a message's bar. */
function actionDivider(): HTMLElement {
  return h('span', { class: 'chat-actions-divider' })
}

/** Whether Tab has been pressed on this page, and the panels to tell when it is. */
let keysMoved = false
const waitingForKeys = new Set<WeakRef<ChatPanel>>()

/**
 * Makes every row's actions once Tab is pressed. The key is seen before the focus moves, so the
 * buttons are there for it. A panel never told is let go: the set holds it weakly.
 */
function whenKeysMove(panel: ChatPanel): void {
  if (keysMoved) {
    panel.everyRowActionsNow()
    return
  }
  if (waitingForKeys.size === 0) {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Tab') return
      keysMoved = true
      document.removeEventListener('keydown', onKey, true)
      for (const ref of waitingForKeys) ref.deref()?.everyRowActionsNow()
      waitingForKeys.clear()
    }
    document.addEventListener('keydown', onKey, true)
  }
  waitingForKeys.add(new WeakRef(panel))
}

/** Names a message action in the tip over its button (src/ui/tip.ts). */
function withTip(button: HTMLElement, label: string): HTMLElement {
  button.dataset.tip = label
  return button
}

function pinMark(): HTMLElement {
  return h('span', { class: 'chat-pinned-mark', title: 'Pinned in this channel' }, [icon('pin', 13), 'Pinned'])
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
  /** Puts a message, and its thread, in another channel. */
  relocate?(id: string, channel: string): void
  vote(id: string, choice: number): void
}

type Join = { at: number; text: string }
type Row = { key: string; sig: string; make: () => HTMLElement }
type SuggestKind = 'mention' | 'command' | 'name' | 'emoji'
type ColourOf = (key: string) => string

/** A channel opens with its newest few screens, and a scroll up draws more, a bigger step at a time. */
const WINDOW_FIRST = 60
const WINDOW_STEP = 120
/** What a channel marked NSFW blurs: pictures, videos, GIFs, drawings, and the pictures in link cards and embeds. */
const VEILED = '.att-tile, .chat-image-wrap, .link-card-frame, .link-card-side, .embed-image'
/** What gives a message room under it. A link's card shows later, and marks its row then. */
const ROOMY = '.chat-reacts, .att-block, .poll, .chat-thread, .embed-card'
const WINDOW_MAX = 600
/** The message box grows with its words by itself (field-sizing in styles.css), from Chrome 123. */
const SIZES_ITSELF = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content') === true

/** A card of who reacted names this many, then how many more. */
const REACTED_NAMES_MAX = 12

/** The top of a channel. While its history is still coming, it says so in place of the start. */
interface Intro {
  title: string
  text: string
  loading?: boolean
}

export class ChatPanel {
  readonly root: HTMLElement
  actions: ChatActions | null = null
  canPin = false
  canDelete = false
  canRelocate = false
  /** The channels a message may go to: not its own, and only ones its writer may enter. */
  relocateTargets: ((m: Message) => { name: string; label: string }[]) | null = null
  /** A picture a webhook names, through the space's server. '' when there is no way to show it. */
  pictureFor: ((url: string) => string) | null = null
  /** Who is here now, and the dot each shows, for the list that @ opens. Whoever is missing is offline. */
  presences: (() => Map<string, { dot: string; words: string }>) | null = null
  /** A click on a name or a picture in the chat: their profile, beside it. */
  onProfile: ((key: string, anchor: HTMLElement) => void) | null = null
  /** What a right click on a name or a picture in the chat offers. */
  personMenu: ((key: string) => MenuEntry[]) | null = null
  colourOf: ColourOf = () => ''
  onTyping: (() => void) | null = null
  onThread: ((rootId: string | null) => void) | null = null
  onDirect: ((key: string | null) => void) | null = null
  onGif: (() => void) | null = null
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
  private readonly replyBar: HTMLDivElement
  private readonly nameRow: HTMLDivElement
  private readonly typingLine: HTMLDivElement
  private readonly roomLeft: HTMLSpanElement
  private readonly mediaNote: HTMLDivElement
  private readonly mediaNoteText: HTMLSpanElement
  private readonly tray: AttachTray
  private readonly attachButton: HTMLButtonElement
  private readonly voiceButton: HTMLButtonElement
  private readonly voiceBar: HTMLDivElement
  private voice: VoiceRecording | null = null
  private readonly clipButton: HTMLButtonElement
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
  /** When a person last moved the log themselves: only that lets it go from the newest message. */
  private handScrolledAt = 0
  /** Until then the keyboard is coming or going, and the log keeps to the newest message if it was there. */
  private keyboardUntil = 0
  private lastTop = 0
  private suggestions: HTMLDivElement | null = null
  private suggestAt = -1
  private suggestKind: SuggestKind | null = null
  /** The "Create spoiler" / "Remove spoiler" bubble above the selection or caret, while writing. */
  private spoilerBar: HTMLElement | null = null
  private readonly drafts = new Map<string, string>()
  private draftKey = ''
  private olderQueued = false
  private windowSize = WINDOW_FIRST
  private windowKey: string | null = null
  private lastFeed: { messages: Message[]; joins: Join[] } | null = null
  /** Work that waits until its row comes near the screen, and what watches for that. */
  private nearWork = new WeakMap<Element, () => void>()
  /**
   * Each row's actions, made the first time the pointer or the focus comes to it: a bar of
   * buttons in every row was most of the elements in the log. Once Tab is pressed, every row
   * has them, so the keys still reach each one, from either end.
   */
  private actionsFor = new WeakMap<Element, () => void>()
  private everyRowActions = false

  /** Tab was pressed: every row gets its actions now, and every row drawn after. */
  everyRowActionsNow(): void {
    this.everyRowActions = true
    for (const row of this.log.children) this.actionsFor.get(row)?.()
  }
  private nearWatch: IntersectionObserver | null = null
  private hiddenAbove = 0
  private intro: Intro | null = null
  private readonly rows = new Map<string, { el: HTMLElement; sig: string }>()
  private quickFor: HTMLElement | null = null
  private found: { id: string; at: number } | null = null
  /** The messages whose pictures somebody clicked to see, in a channel marked NSFW. */
  private readonly shown = new Set<string>()
  /** Spoilers already scratched or clicked open, keyed by `${message id}:${its order in the text}`. */
  private readonly spoilersOpen = new Set<string>()
  private readonly spoilerHooks: SpoilerHooks = {
    isOpen: (key) => this.spoilersOpen.has(key),
    open: (key) => this.spoilersOpen.add(key),
  }
  private mediaOnly = false
  /** Somebody who keeps the channels is warned, but may still write words. */
  private mediaExempt = false

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
          this.checkSpoilerBar()
          this.onTyping?.()
        },
        pointerdown: () => this.followKeyboard(),
        pointerup: () => this.checkSpoilerBar(),
        keyup: () => this.checkSpoilerBar(),
        focus: () => this.followKeyboard(),
        blur: () => {
          this.closeSuggestions()
          this.closeSpoilerBar()
          this.followKeyboard()
        },
      },
    })
    quietKeyboard(this.textInput)

    this.sendButton = h(
      'button',
      { class: 'send-button', title: 'Send (Enter)', ariaLabel: 'Send', on: { click: () => this.submit() } },
      [icon('send', 19)],
    )

    this.tray = new AttachTray(() => this.files)
    this.tray.onChange = () => {
      this.sendButton.classList.toggle('waiting', this.sendWaiting && this.tray.busy)
      this.showSend()
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
      [icon('paperclip', 20)],
    )
    this.voiceButton = h(
      'button',
      {
        class: 'ghost icon-only note-button hidden',
        title: 'Record a voice message',
        ariaLabel: 'Record a voice message',
        on: { click: () => void this.startVoice() },
      },
      [icon('mic', 20)],
    )
    this.voiceBar = h('div', { class: 'row note-bar hidden' })
    // In the desktop app: a clip from your Steam, NVIDIA or other recordings, as an attached file.
    this.clipButton = h(
      'button',
      {
        class: 'ghost icon-only clip-button hidden',
        title: 'Share a clip from your recordings',
        ariaLabel: 'Share a clip from your recordings',
        on: {
          click: () => {
            const files = this.files
            if (!files) return
            void import('./recordings').then(({ openRecordings }) =>
              openRecordings({
                max: files.max,
                onClip: (file) => {
                  this.tray.add([file])
                  this.textInput.focus()
                },
              }),
            )
          },
        },
      },
      [icon('clapper', 20)],
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
      [icon('smile', 21)],
    )
    this.gifButton = h('button', {
      class: 'ghost gif-button',
      text: 'GIF',
      title: 'Find a GIF',
      ariaLabel: 'Find a GIF',
      on: { click: () => this.onGif?.() },
    })

    this.nameRow = h('div', { class: 'row' }, [
      h('span', { class: 'tiny faint', text: 'You', style: { width: '26px' } }),
      this.nameInput,
    ])

    this.typingLine = h('div', { class: 'chat-typing nook-typing hidden', role: 'status' })
    this.typingLine.setAttribute('aria-live', 'polite')
    // Slides out above the box while words are typed where only media goes.
    this.mediaNote = h('div', { class: 'chat-media-note', role: 'status' }, [
      h('div', { class: 'chat-media-note-inner' }, [
        icon('image', 15),
        (this.mediaNoteText = h('span', { text: 'Media only. Words go in a thread.' })),
      ]),
    ])
    this.mediaNote.setAttribute('aria-live', 'polite')
    this.roomLeft = h('span', { class: 'chat-room-left tiny hidden', ariaLabel: 'Room left in this message' })
    this.toBottom = h(
      'button',
      {
        class: 'to-bottom icon-only hidden',
        ariaLabel: 'Jump to the newest',
        title: 'Jump to the newest',
      },
      [icon('arrow-down', 20)],
    )
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
    // A wheel, a finger, the keys, or the scroll bar: a person moving the log.
    const byHand = (): void => {
      this.handScrolledAt = Date.now()
    }
    for (const name of ['wheel', 'touchmove', 'keydown'] as const) this.log.addEventListener(name, byHand, { passive: true })
    this.log.addEventListener('pointerdown', (ev) => ev.target === this.log && byHand())
    this.log.addEventListener('pointermove', (ev) => ev.buttons && ev.target === this.log && byHand())
    this.log.addEventListener('scroll', () => {
      // Only a person lets go of the newest message: a hand on it, or the log going up, which a
      // picture or a card that grows never does. Growing, it must not: after a reload that would
      // leave you somewhere in the middle.
      const top = this.log.scrollTop
      const up = top < this.lastTop - 1
      this.lastTop = top
      // The keyboard moving the page is not a person moving the log.
      const keyboard = Date.now() < this.keyboardUntil && Date.now() - this.handScrolledAt > 1000
      if (keyboard) {
        if (this.pinned && !this.isAtBottom()) this.toNewest()
      } else if (!this.pinned || up || Date.now() - this.handScrolledAt < 1000) this.pinned = this.isAtBottom()
      else if (!this.isAtBottom()) this.toNewest()
      this.showJump()
      if (this.log.scrollTop < 400 && this.hiddenAbove > 0) this.drawOlder()
    })
    // Media events do not bubble, hence the capture.
    this.log.addEventListener('load', () => this.followMedia(), true)
    // In a channel marked NSFW the first click or key on a blurred picture shows it, and does nothing else.
    const reveal = (ev: Event): void => {
      if (!this.log.classList.contains('nsfw') || !(ev.target instanceof Element)) return
      if (ev instanceof KeyboardEvent && ev.key !== 'Enter' && ev.key !== ' ') return
      const line = ev.target.closest<HTMLElement>('.chat-line[data-id]:not(.shown)')
      if (!line || !ev.target.closest(VEILED)) return
      ev.preventDefault()
      ev.stopPropagation()
      this.shown.add(line.dataset.id!)
      line.classList.add('shown')
    }
    this.log.addEventListener('click', reveal, true)
    whenKeysMove(this)
    this.log.addEventListener('keydown', reveal, true)
    this.log.addEventListener('loadedmetadata', () => this.followMedia(), true)
    // The log, and every row in it: a row that grows (a picture, a link card, an embed) keeps
    // the newest message in view while the log follows it.
    const grows = new ResizeObserver(() => {
      if (this.pinned && !this.isAtBottom()) this.toNewest()
      this.showJump()
    })
    grows.observe(this.log)
    // The keyboard makes the page shorter: the newest message comes up with the message box.
    window.visualViewport?.addEventListener('resize', () => {
      if (Date.now() > this.keyboardUntil || !this.pinned || !this.root?.isConnected) return
      this.toNewest()
      requestAnimationFrame(() => this.pinned && this.toNewest())
    })
    new MutationObserver((changes) => {
      for (const change of changes) {
        for (const node of change.addedNodes) if (node instanceof Element) grows.observe(node)
        for (const node of change.removedNodes) if (node instanceof Element) grows.unobserve(node)
      }
    }).observe(this.log, { childList: true })
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
        this.mediaNote,
        this.typingLine,
        this.replyBar,
        this.nameRow,
        this.tray.root,
        this.voiceBar,
        h('div', { class: 'row compose-box' }, [
          this.attachButton,
          this.clipButton,
          this.fileInput,
          // A mention looks as it will in the message; a spoiler gets a plain yellow highlight.
          emojiField(this.textInput, (text) => this.fieldMarks(text)),
          this.roomLeft,
          this.gifButton,
          this.emojiButton,
          this.voiceButton,
          this.sendButton,
        ]),
      ]),
      this.dropCover,
    ])
    this.watchDrops()
    const openMention = (target: EventTarget | null): boolean => {
      const tag = target instanceof Element ? target.closest<HTMLElement>('.mention[data-who]') : null
      if (!tag?.dataset.who || !this.log.contains(tag)) return false
      this.onProfile?.(tag.dataset.who, tag)
      return true
    }
    this.log.addEventListener('click', (ev) => void (openMention(ev.target) && ev.stopPropagation()))
    this.log.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Enter' || ev.key === ' ') && openMention(ev.target)) ev.preventDefault()
    })
  }

  setFiles(files: SpaceFiles | null): void {
    this.files = files
    this.attachButton.classList.toggle('hidden', !files)
    this.attachButton.parentElement?.classList.toggle('can-attach', !!files)
    this.voiceButton.classList.toggle('hidden', !files || !canRecordVoice())
    this.showSend()
    this.clipButton.classList.toggle('hidden', !files || !seesRecordings())
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
    // A name that came, or a level that changed colour, changes how a mention in the box looks.
    if (this.textInput.value.includes('@')) this.textInput.dispatchEvent(new Event(REDRAW_FIELD))
  }

  setTitle(text: string): void {
    if (this.title.textContent !== text) this.title.textContent = text
  }

  /** Blurs the pictures and videos until each message's are clicked. */
  setNsfw(on: boolean): void {
    this.log.classList.toggle('nsfw', on)
  }

  /** Sends nothing to the channel without a picture, a video or a file. Threads still take words. */
  setMediaOnly(on: boolean, exempt = false): void {
    this.mediaExempt = exempt
    if (this.mediaOnly === on) return this.showMediaNote()
    this.mediaOnly = on
    if (this.enabled) this.textInput.placeholder = this.modePlaceholder()
    this.showMediaNote()
  }

  /** Warns, once words are typed, that this channel takes only pictures, videos and files. */
  private showMediaNote(): void {
    const toChannel = !this.directWith && !this.threadRoot && !this.editing
    const words = this.textInput.value.trim()
    const on = this.mediaOnly && toChannel && words !== '' && !hasMedia(words, this.tray.count > 0 ? [0] : [])
    this.mediaNoteText.textContent = this.mediaExempt ? 'Media only. Words go in a thread, but you may post them.' : 'Media only. Words go in a thread.'
    this.mediaNote.classList.toggle('on', on)
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
    this.showMediaNote()
  }

  private modePlaceholder(): string {
    if (this.directWith) return `Message ${this.directName || 'them'}`
    if (this.threadRoot) return 'Reply in this thread'
    return this.mediaOnly && !this.mediaExempt ? 'Share a picture, a video or a file' : 'Say something'
  }

  setTyping(who: string[]): void {
    const names = who.filter(Boolean)
    const was = !this.typingLine.classList.contains('hidden')
    this.typingLine.classList.toggle('hidden', names.length === 0)
    if (names.length === 0) {
      this.typingLine.replaceChildren()
      return
    }
    const words = typingWords(names)
    // The ghost peeks in once, then keeps typing while the names change.
    if (!was || !this.typingLine.firstChild) {
      this.typingLine.replaceChildren(ghost({ mood: 'typing', entrance: 'peek', size: 32 }), h('span', { text: words }))
    } else if (this.typingLine.lastChild) {
      this.typingLine.lastChild.textContent = words
    }
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

  /** Every mark the composer's mirror should draw: a mention tag, plus a spoiler's yellow mark. */
  private fieldMarks(text: string): FieldMark[] {
    const marks: FieldMark[] = []
    if (this.names.size && text.includes('@')) {
      for (const hit of findMentions(text, this.names)) {
        marks.push({ at: hit.at, length: hit.length, colour: hit.key === EVERYONE ? '' : this.colourOf(hit.key) })
      }
    }
    for (const range of findSpoilers(text)) {
      marks.push({
        at: range.at,
        length: range.length,
        colour: '',
        kind: 'spoiler',
        hidden: [
          { at: range.at, length: 2 },
          { at: range.at + range.length - 2, length: 2 },
        ],
      })
    }
    return marks.sort((a, b) => a.at - b.at)
  }

  /** Wraps the given stretch of the composer's text in `||`, marking it as a spoiler. */
  private wrapSpoiler(start: number, end: number): void {
    const input = this.textInput
    const text = input.value
    input.value = `${text.slice(0, start)}||${text.slice(start, end)}||${text.slice(end)}`
    input.setSelectionRange(start + 2, end + 2)
    input.focus()
    this.grow()
    this.closeSpoilerBar()
  }

  /** Strips a spoiler's `||` markers, leaving its text in place and otherwise untouched. */
  private unwrapSpoiler(range: SpoilerRange): void {
    const input = this.textInput
    const text = input.value
    input.value = text.slice(0, range.at) + range.text + text.slice(range.at + range.length)
    const at = range.at + range.text.length
    input.setSelectionRange(at, at)
    input.focus()
    this.grow()
    this.closeSpoilerBar()
  }

  /** Where the caret at `index` sits on screen, in viewport coordinates. */
  private caretPoint(index: number): { x: number; y: number } {
    const input = this.textInput
    const cs = getComputedStyle(input)
    const mirror = document.createElement('div')
    const copy = [
      'box-sizing', 'width', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height', 'tab-size',
    ]
    for (const prop of copy) mirror.style.setProperty(prop, cs.getPropertyValue(prop))
    mirror.style.position = 'fixed'
    mirror.style.visibility = 'hidden'
    mirror.style.whiteSpace = 'pre-wrap'
    mirror.style.wordWrap = 'break-word'
    mirror.style.top = '0'
    mirror.style.left = '-9999px'
    document.body.append(mirror)
    const marker = document.createElement('span')
    marker.textContent = '​'
    mirror.append(document.createTextNode(input.value.slice(0, index)), marker, document.createTextNode(input.value.slice(index) || '.'))
    const mirrorBox = mirror.getBoundingClientRect()
    const markBox = marker.getBoundingClientRect()
    const fieldBox = input.getBoundingClientRect()
    const x = fieldBox.left + (markBox.left - mirrorBox.left) - input.scrollLeft
    const y = fieldBox.top + (markBox.top - mirrorBox.top) - input.scrollTop
    mirror.remove()
    return { x, y }
  }

  private closeSpoilerBar(): void {
    this.spoilerBar?.remove()
    this.spoilerBar = null
  }

  private showSpoilerBar(label: string, run: () => void): void {
    this.closeSpoilerBar()
    const start = this.textInput.selectionStart ?? 0
    const end = this.textInput.selectionEnd ?? start
    const a = this.caretPoint(start)
    const b = this.caretPoint(end)
    const x = (a.x + b.x) / 2
    const y = Math.min(a.y, b.y)
    const bar = h('div', { class: 'spoiler-bar' }, [
      h('button', { class: 'spoiler-bar-action', text: label, on: pickOnPress(run) }),
    ])
    document.body.append(bar)
    const box = bar.getBoundingClientRect()
    fitInView(bar, x - box.width / 2, y - box.height - 8)
    this.spoilerBar = bar
  }

  /** Shows "Create spoiler" over a selection, or "Remove spoiler" with the caret inside one. */
  private checkSpoilerBar(): void {
    if (document.activeElement !== this.textInput) {
      this.closeSpoilerBar()
      return
    }
    const input = this.textInput
    const start = input.selectionStart ?? 0
    const end = input.selectionEnd ?? start
    const text = input.value
    const ranges = findSpoilers(text)
    if (start !== end) {
      // Wrapping a stretch that already overlaps a spoiler would corrupt its `||` markers.
      if (ranges.some((r) => start < r.at + r.length && end > r.at)) {
        this.closeSpoilerBar()
        return
      }
      this.showSpoilerBar('Create spoiler', () => this.wrapSpoiler(start, end))
      return
    }
    const inside = ranges.find((r) => start > r.at && start < r.at + r.length)
    if (inside) {
      this.showSpoilerBar('Remove spoiler', () => this.unwrapSpoiler(inside))
      return
    }
    this.closeSpoilerBar()
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
      if (this.spoilerBar) {
        this.closeSpoilerBar()
        return
      }
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
      this.growWindow(WINDOW_STEP)
    })
  }

  /** Draws more above, where the log already is. */
  private growWindow(by: number): void {
    if (!this.lastFeed || this.hiddenAbove === 0) return
    const fromBottom = this.log.scrollHeight - this.log.scrollTop
    this.windowSize += by
    this.render(this.lastFeed.messages, this.lastFeed.joins)
    this.log.scrollTop = this.log.scrollHeight - fromBottom
  }

  /** A view opens with a few screens; once it is on screen and nothing is to do, it has a full step. */
  private growWhenIdle(view: string): void {
    const grow = (): void => {
      if (this.windowKey === view && this.windowSize < WINDOW_STEP) this.growWindow(WINDOW_STEP - this.windowSize)
    }
    if ('requestIdleCallback' in window) requestIdleCallback(grow, { timeout: 1500 })
    else setTimeout(grow, 300)
  }

  private showJump(): void {
    const gap = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight
    const shown = !this.toBottom.classList.contains('hidden')
    const want = shown ? gap > 60 || this.toBottom.matches(':hover') : gap > 300
    this.toBottom.classList.toggle('hidden', !want)
  }

  private jumpToNewest(): void {
    this.pinned = true
    this.toNewest()
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
    // Where the box grows with its words by itself, nothing here sets its height. Set at each
    // key, even to the height it had, it laid out the page twice a key.
    if (!SIZES_ITSELF) {
      const input = this.textInput
      input.style.height = 'auto'
      input.style.height = `${Math.min(input.scrollHeight, 116)}px`
    }
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
    this.showSend()
  }

  /** The send button shows only when there is something to send. */
  private showSend(): void {
    const empty = !this.textInput.value.trim() && this.tray.count === 0
    this.sendButton.classList.toggle('empty', empty)
    // The microphone shows while there is nothing to send, and gives way to the send button after.
    this.voiceButton.classList.toggle('empty', !empty)
    this.showMediaNote()
  }

  /**
   * The row in place of the box while a voice message is made. First it records, with the time and
   * the level, and Stop ends it. Then you can play it back, and send it or throw it away.
   */
  private async startVoice(): Promise<void> {
    if (this.voice || !this.files || !this.enabled || this.editing) return
    let recording: VoiceRecording
    try {
      recording = await recordVoice(() => void stop())
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Nook could not record.', 'warn', 6000)
      return
    }
    this.voice = recording
    const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, '0')}`
    const bin = h('button', { class: 'ghost icon-only', title: 'Throw it away', ariaLabel: 'Throw the voice message away' }, [
      icon('trash', 18),
    ])
    const time = h('span', { class: 'note-time', text: '0:00' })
    const meter = h('i')
    const stopButton = h('button', { class: 'note-stop', title: 'Stop recording', ariaLabel: 'Stop recording' }, [icon('stop', 16)])
    this.voiceBar.replaceChildren(bin, h('span', { class: 'note-dot' }), time, h('span', { class: 'note-meter' }, [meter]), stopButton)
    this.voiceBar.classList.remove('hidden')
    this.root.classList.add('recording')

    let listen: HTMLAudioElement | null = null
    let ended = false
    const leave = (): void => {
      ended = true
      window.clearInterval(tick)
      if (listen) {
        listen.pause()
        URL.revokeObjectURL(listen.src)
        listen = null
      }
      this.voice = null
      this.voiceBar.classList.add('hidden')
      this.root.classList.remove('recording')
    }
    const tick = window.setInterval(() => {
      time.textContent = clock(recording.seconds())
      meter.style.transform = `scaleX(${Math.max(0.04, recording.level())})`
    }, 80)

    const stop = async (): Promise<void> => {
      if (ended || this.voice !== recording) return
      window.clearInterval(tick)
      stopButton.disabled = true
      const file = await recording.finish()
      if (ended) return
      if (!file) {
        leave()
        toast('That was too short. Hold on a little longer.', 'warn')
        return
      }
      review(file)
    }

    /** The finished recording: play it back, then send it or throw it away. */
    const review = (file: File): void => {
      const total = voiceSeconds(file) ?? 0
      const audio = new Audio(URL.createObjectURL(file))
      listen = audio
      const play = h('button', { class: 'note-play', title: 'Play', ariaLabel: 'Play the voice message' }, [icon('play', 17)])
      const fill = h('i')
      const track = h('span', { class: 'note-track', role: 'progressbar', ariaLabel: 'Voice message' }, [fill])
      const left = h('span', { class: 'note-time', text: clock(total) })
      const send = h('button', { class: 'send-button', title: 'Send the voice message', ariaLabel: 'Send the voice message' }, [
        icon('send', 19),
      ])
      const face = (playing: boolean): void => {
        play.replaceChildren(icon(playing ? 'pause' : 'play', 17))
        play.title = playing ? 'Pause' : 'Play'
        play.setAttribute('aria-label', playing ? 'Pause the voice message' : 'Play the voice message')
      }
      play.addEventListener('click', () => {
        if (audio.paused) void audio.play().catch(() => undefined)
        else audio.pause()
      })
      audio.addEventListener('play', () => face(true))
      audio.addEventListener('pause', () => face(false))
      audio.addEventListener('ended', () => {
        face(false)
        fill.style.transform = 'scaleX(0)'
        left.textContent = clock(total)
      })
      audio.addEventListener('timeupdate', () => {
        if (!total) return
        const at = Math.min(total, audio.currentTime)
        fill.style.transform = `scaleX(${at / total})`
        left.textContent = clock(at)
      })
      bin.addEventListener('click', leave)
      send.addEventListener('click', () => {
        leave()
        this.tray.add([file])
        this.submit()
      })
      this.voiceBar.replaceChildren(bin, play, track, left, send)
      play.focus()
    }

    bin.addEventListener('click', () => {
      if (listen) return
      leave()
      recording.cancel()
    })
    stopButton.addEventListener('click', () => void stop())
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
    // Over the box, as Discord does: below it, a phone's keyboard would cover the names.
    fitOver(list, this.textInput)
  }

  private nameHits(fragment: string): { key: string; name: string }[] {
    const wanted = fragment.toLowerCase()
    const hits: { key: string; name: string }[] = []
    for (const [key, name] of this.names) {
      if (hits.length === 6) break
      if (name && key !== this.me && name.toLowerCase().startsWith(wanted)) hits.push({ key, name })
    }
    return hits
  }

  /** A name to pick, with their picture and the dot that says whether they are here, as Discord shows it. */
  private nameOption(
    key: string,
    name: string,
    take: () => void,
    here?: Map<string, { dot: string; words: string }>,
  ): HTMLButtonElement {
    const label = h('span', { class: 'truncate', text: name })
    const colour = key === EVERYONE ? '' : this.colourOf(key)
    if (colour) label.style.color = roleInk(colour)
    let face: HTMLElement
    if (key === EVERYONE) {
      face = h('span', { class: 'mention-face everyone' }, [icon('people', 14)])
    } else {
      const look = here?.get(key) ?? { dot: 'idle', words: 'Offline' }
      face = h('span', { class: 'mention-face' }, [
        avatarOf(key, name, this.avatars.get(key) ?? '', 24),
        here ? h('i', { class: `dot ${look.dot}`, title: look.words }) : null,
      ])
    }
    return h('button', { class: 'mention-option has-face', data: { name }, on: pickOnPress(take) }, [face, label])
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
    if (fragment === '' || 'everyone'.startsWith(fragment.toLowerCase())) hits.unshift({ key: EVERYONE, name: 'everyone' })
    if (hits.length === 0) {
      this.closeSuggestions()
      return
    }
    const here = this.presences?.()
    this.showSuggestions(
      'mention',
      at,
      hits.map(({ key, name }) => this.nameOption(key, name, () => this.takeSuggestion(name), here)),
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
    const here = this.presences?.()
    this.showSuggestions(
      'name',
      start,
      hits.map(({ key, name }) => this.nameOption(key, name, () => this.takeName(name), here)),
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
      // A person's option keeps their name apart from their picture.
      const label =
        (chosen as HTMLElement | undefined)?.dataset.name ?? chosen?.querySelector('span')?.textContent ?? chosen?.textContent ?? ''
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

  setIntro(intro: Intro | null): void {
    this.intro = intro
  }

  render(messages: Message[], joins: Join[] = []): void {
    this.lastFeed = { messages, joins }
    let stuck = this.pinned || this.isAtBottom()

    const all = messages
    let byId: Map<string, Message> | null = null
    const parentOf = (m: Message): Message | undefined =>
      m.replyTo ? (byId ??= new Map(all.map((x) => [x.id, x]))).get(m.replyTo) : undefined

    const sameView = this.windowKey === this.draftKey
    if (!sameView) this.growWhenIdle(this.draftKey)
    if (this.windowKey !== this.draftKey) {
      this.windowKey = this.draftKey
      this.windowSize = WINDOW_FIRST
      // Another channel or conversation opens at its newest message.
      stuck = true
      this.pinned = true
      if (this.readMark > 0) {
        const first = messages.findIndex((m) => m.lamport > this.readMark && m.author !== this.me)
        if (first >= 0) {
          this.windowSize = Math.min(WINDOW_MAX, Math.max(WINDOW_FIRST, messages.length - first + 20))
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
        sig: `${intro.title}|${intro.text}|${intro.loading === true}`,
        make: () =>
          intro.loading
            ? h('div', { class: 'chat-intro' }, [spinner('Loading messages', 'big')])
            : h('div', { class: 'chat-intro' }, [
                h('div', { class: 'chat-intro-title', text: intro.title }),
                h('div', { class: 'chat-intro-text', text: intro.text }),
              ]),
      })
    }
    let lastDay = ''
    let lastAuthor = ''
    let lastAt = 0
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

      // A new person, or five quiet minutes, starts a new group under a face and a name.
      // A webhook posts under any name it likes, so each name is a person of its own here.
      const writer = m.hook ? `${m.author}:${m.name ?? ''}:${m.hook.avatar}` : m.author
      const first = writer !== lastAuthor || m.at - lastAt > GROUP_GAP
      lastAuthor = m.replyTo ? '' : writer
      lastAt = m.at
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

    this.reconcile(items, sameView)
    if (stuck) {
      this.toNewest()
      this.pinned = true
    }
    this.showJump()
  }

  /** Must hold every value messageRow reads, or that value stops updating. */
  private signature(m: Message, first: boolean, parent: Message | undefined, callsMe: boolean, live: boolean): string {
    const reactions = [...m.reactions]
      .map(([emoji, who]) => `${emoji}${[...who].map((key) => this.names.get(key) ?? key).sort().join('+')}${who.has(this.me) ? '*' : ''}`)
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
      m.hook ? `hook:${m.hook.avatar}` : '',
      m.embeds ? JSON.stringify(m.embeds) : '',
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
      m.text.includes('@') ? findMentions(m.text, this.names).map((hit) => this.colourOf(hit.key)).join(',') : '',
      callsMe ? 'c' : '',
      this.threadRoot === m.id ? 'root' : '',
      parent ? `${parent.name ?? ''}:${parent.text.slice(0, 60)}` : m.replyTo ? 'gone' : '',
      reactions,
      poll,
    ].join('\u0001')
  }

  private reconcile(items: Row[], sameView: boolean): void {
    const wanted = new Set(items.map((i) => i.key))
    // A message that goes from the middle of the same view was deleted: it drifts away. Rows that
    // leave from the top as the window moves, or when the view changes, just go.
    let kept = false
    for (const child of [...this.log.children] as HTMLElement[]) {
      const key = child.dataset.key ?? ''
      if (wanted.has(key)) {
        // Only a message kept above it shows this one went from the middle; a day line stays at the top.
        if (key.startsWith('m:')) kept = true
        continue
      }
      if (child.classList.contains('nook-vanish')) continue
      this.rows.delete(key)
      if (sameView && kept && key.startsWith('m:')) vanish(child)
      else child.remove()
    }

    // Rows made after the last one already here are new messages, and they arrive.
    let lastOld = -1
    items.forEach((item, i) => {
      if (this.rows.has(item.key)) lastOld = i
    })

    let cursor = this.log.firstChild
    const pass = (): void => {
      while (cursor instanceof HTMLElement && cursor.classList.contains('nook-vanish')) cursor = cursor.nextSibling
    }
    items.forEach((item, i) => {
      pass()
      let held = this.rows.get(item.key)
      if (!held || held.sig !== item.sig) {
        const el = item.make()
        el.dataset.key = item.key
        if (!held && sameView && i > lastOld && lastOld >= 0) arrive(el)
        if (held) {
          // The new one goes where the old one was.
          if (cursor === held.el) cursor = held.el.nextSibling
          held.el.remove()
        }
        held = { el, sig: item.sig }
        this.rows.set(item.key, held)
      }
      pass()
      if (cursor === held.el) cursor = cursor.nextSibling
      else this.log.insertBefore(held.el, cursor)
    })
    while (cursor) {
      const next: ChildNode | null = cursor.nextSibling
      if (!(cursor instanceof HTMLElement && cursor.classList.contains('nook-vanish'))) cursor.remove()
      cursor = next
    }
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
    if (this.shown.has(m.id)) line.classList.add('shown')
    const pending = this.replyTo?.id === m.id || this.editing?.id === m.id
    if (pending) line.classList.add('pending')
    // Drawn again while lit: the light carries on from where it had got to.
    const since = this.found?.id === m.id ? Date.now() - this.found.at : Infinity
    if (since < 5000) {
      line.classList.add('found')
      line.style.animationDelay = `-${since}ms`
    }
    const row = h('div', { class: `chat-row${mine ? ' mine' : ''}${callsMe ? ' calls-me' : ''}` }, [line])
    onContextMenu(line, (ev) => {
      const person = (ev.target as Element).closest('.chat-name, .avatar')
      const about = person && this.personMenu ? this.personMenu(m.author) : []
      if (about.length) return about
      return [...mediaMenu(ev.target as Element), ...this.messageMenu(m, mine, line)]
    })

    if (m.replyTo && m.replyTo !== this.threadRoot) {
      let quoted: HTMLElement | null = null
      if (parent) {
        quoted = h('span', { class: 'chat-reply-name', text: parent.name || shortKey(parent.author) })
        const colour = this.colourOf(parent.author)
        if (colour) quoted.style.color = roleInk(colour)
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
      if (colour) name.style.color = roleInk(colour)
      row.classList.add('first')
      const face = this.faceOf(m)
      if (!m.hook) {
        for (const el of [name, face]) {
          el.classList.add('opens-profile')
          el.addEventListener('click', (ev) => {
            ev.stopPropagation()
            this.onProfile?.(m.author, name)
          })
        }
      }
      line.append(
        h('div', { class: 'chat-who' }, [
          face,
          name,
          m.hook ? h('span', { class: 'chat-hook-mark', text: 'Webhook', title: 'Posted by an app, through a webhook' }) : null,
          at,
          m.pinned ? pinMark() : null,
        ]),
      )
    } else {
      at.classList.add('on-hover')
      if (m.pinned) line.append(h('div', { class: 'chat-who' }, [pinMark()]))
      line.classList.add('runs-on')
    }

    this.drawBody(m, line, who, true)
    if (m.embeds) for (const [ei, embed] of m.embeds.entries()) line.append(this.embedCard(embed, `${m.id}:embed:${ei}`))

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
        const chip = h(
          'button',
          {
            class: `chat-react${on ? ' on' : ''}`,
            ariaLabel: `${this.whoReacted(people)} reacted with ${emoji}. ${on ? 'Take yours back' : 'React with this too'}`,
            on: {
              click: () => {
                const mine = people.has(this.me)
                // The last one of it, and it is yours: it pops like a balloon before it goes.
                if (mine && people.size === 1) popChip(chip, () => this.actions?.react(m.id, emoji, false))
                else this.actions?.react(m.id, emoji, !mine)
              },
            },
          },
          [h('span', { class: 'chat-react-face', text: emoji }), ' ', h('span', { text: String(people.size) })],
        )
        this.showWhoReacted(chip, emoji, people)
        reacts.append(chip)
      }
      const more = h(
        'button',
        {
          class: 'chat-react add',
          title: 'React with something else',
          ariaLabel: 'React with something else',
          on: { click: () => this.reactWith(m, more) },
        },
        [icon('plus', 18)],
      )
      reacts.append(more)
      line.append(reacts)
    }

    const actions = (): void => {
      if (this.actionsFor.get(row) !== actions) return
      this.actionsFor.delete(row)
      line.append(this.rowActions(m, mine))
    }
    this.actionsFor.set(row, actions)
    row.addEventListener('pointerenter', actions, { once: true })
    row.addEventListener('focusin', actions, { once: true })
    if (this.everyRowActions) actions()
    if (pending) row.classList.add('pending')
    if (line.querySelector(ROOMY)) row.classList.add('roomy')
    return row
  }

  /** The face next to a name: a webhook's comes from the address it gave, through the server. */
  private faceOf(m: Message): HTMLElement {
    const picture = m.hook?.avatar ? this.pictureFor?.(m.hook.avatar) ?? '' : ''
    const face = avatarOf(m.author, m.name ?? '', picture || this.avatars.get(m.author) || '', 40)
    face.querySelector('img')?.addEventListener('error', () => face.replaceWith(avatarOf(m.author, m.name ?? '', '', 40)), { once: true })
    return face
  }

  /** A Discord embed, drawn as a link card is: a bar in its colour, its words, and its pictures. */
  private embedCard(embed: Embed, keyBase: string): HTMLElement {
    const box = h('div', { class: 'link-card embed-card' })
    if (embed.colour) box.style.setProperty('--site', embed.colour)
    const picture = (url: string | undefined, cls: string): HTMLImageElement | null => {
      const src = url ? this.pictureFor?.(url) ?? '' : ''
      if (!src) return null
      const img = h('img', { class: cls })
      img.alt = ''
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      img.src = src
      img.addEventListener('error', () => img.remove())
      return img
    }
    const out = (url: string | undefined, child: HTMLElement): HTMLElement => {
      if (!url) return child
      const a = h('a', {}, [child])
      a.href = url
      a.target = '_blank'
      a.rel = 'noreferrer noopener'
      return a
    }
    const body = h('div', { class: 'link-card-body' })
    if (embed.author) {
      body.append(
        h('div', { class: 'link-card-site' }, [
          picture(embed.author.icon, 'link-card-icon'),
          out(embed.author.url, h('span', { class: 'truncate', text: embed.author.name })),
        ]),
      )
    }
    if (embed.title) body.append(out(embed.url, h('span', { class: 'link-card-title', text: embed.title })))
    if (embed.description) {
      const words = h('div', { class: 'link-card-desc embed-desc' })
      words.append(...formatText(embed.description, this.names, this.me, this.colourOf, `${keyBase}:desc`, this.spoilerHooks))
      body.append(words)
    }
    if (embed.fields?.length) {
      const fields = h('div', { class: 'embed-fields' })
      for (const [fi, f] of embed.fields.entries()) {
        const value = h('div', { class: 'embed-field-value' })
        value.append(...formatText(f.value, this.names, this.me, this.colourOf, `${keyBase}:field:${fi}`, this.spoilerHooks))
        fields.append(h('div', { class: `embed-field${f.inline ? ' inline' : ''}` }, [h('div', { class: 'embed-field-name', text: f.name }), value]))
      }
      body.append(fields)
    }
    const hero = picture(embed.image, 'link-card-hero embed-image')
    if (hero) body.append(hero)
    const foot = [embed.footer, embed.at ? CLOCK.format(embed.at) : ''].filter(Boolean).join(' · ')
    if (foot) body.append(h('div', { class: 'embed-footer tiny faint', text: foot }))
    box.append(body)
    const thumb = picture(embed.thumbnail, 'link-card-thumb')
    if (thumb) box.append(h('div', { class: 'link-card-side' }, [thumb]))
    return box
  }

  /** The words, the pictures and the files of a message, as the log and the pinned list show them. */
  private drawBody(m: Message, line: HTMLElement, who: string, withCard: boolean): void {
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
            for (const node of formatText(m.text, this.names, this.me, this.colourOf, m.id, this.spoilerHooks)) text.append(node)
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
        for (const node of formatText(m.text, this.names, this.me, this.colourOf, m.id, this.spoilerHooks)) text.append(node)
        line.append(text)
      }
      for (const src of pictures) line.append(embed(src))
      if (m.files?.length) line.append(attachmentBlock(m.files, this.files))
      if (withCard) this.attachPreview(line, m.text, links)
    }
  }

  /** A pinned message as it was said, for the list behind the pin button. */
  pinnedCard(m: Message, open: () => void): HTMLElement {
    const who = m.name || shortKey(m.author)
    const name = h('span', { class: 'chat-name', text: who })
    const colour = this.colourOf(m.author)
    if (colour) name.style.color = roleInk(colour)
    // Only what was said, and what came with it: nothing plays here, and a click goes to the message.
    const line = h('div', { class: 'chat-line pin-card-body' })
    const words = m.poll ? m.poll.question : m.text.trim()
    if (words) line.append(h('div', { class: 'chat-text pin-card-text', text: words }))
    const came = pinnedFiles(m)
    if (came) line.append(h('div', { class: 'pin-card-files' }, [icon('paperclip', 14), came]))
    const card = h('div', { class: 'pin-card', role: 'button', tabIndex: 0, title: 'Go to this message' }, [
      h('div', { class: 'chat-who' }, [
        avatarOf(m.author, m.name ?? '', this.avatars.get(m.author) ?? '', 32),
        name,
        h('span', { class: 'chat-at', text: `${DAY.format(m.at)} ${CLOCK.format(m.at)}` }),
      ]),
      line,
    ])
    card.addEventListener('click', open)
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') open()
    })
    return card
  }

  private attachPreview(line: HTMLElement, text: string, pictures: string[]): void {
    if (!this.previewFor) return
    const link = text.match(/https?:\/\/[^\s<>"')\]]+/)?.[0]
    if (!link || pictures.includes(link)) return
    const box = h('div', { class: 'link-card hidden' })
    line.append(box)
    // Asked for only near the screen: a long channel of links asks for none it does not show.
    this.whenNear(line.parentElement ?? line, () => this.fillPreview(line, box, link))
  }

  /** Runs the work once the row is within a few screens of the log's view. */
  private whenNear(el: Element, work: () => void): void {
    this.nearWatch ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting && entry.target.isConnected) continue
          this.nearWatch?.unobserve(entry.target)
          const run = this.nearWork.get(entry.target)
          this.nearWork.delete(entry.target)
          // A row taken out of the log before it came near does nothing.
          if (entry.target.isConnected) run?.()
        }
      },
      { root: this.log, rootMargin: '1200px 0px' },
    )
    this.nearWork.set(el, work)
    this.nearWatch.observe(el)
  }

  private fillPreview(line: HTMLElement, box: HTMLElement, link: string): void {
    if (!this.previewFor) return
    void this.previewFor(link)
      .then((p) => {
        if (!p || (!p.title && !p.description && !p.image)) return
        const web = (url: string | undefined): string => (url && /^https?:\/\//.test(url) ? url : '')
        const picture = (url: string, cls: string): HTMLImageElement => {
          const img = h('img', { class: cls })
          img.alt = ''
          img.loading = 'lazy'
          img.referrerPolicy = 'no-referrer'
          img.src = url
          return img
        }
        const out = (child: HTMLElement): HTMLAnchorElement => {
          const a = h('a', {}, [child])
          a.href = link
          a.target = '_blank'
          a.rel = 'noreferrer noopener'
          return a
        }
        let host = ''
        try {
          host = new URL(link).hostname.replace(/^www\./, '')
        } catch {
          /* leave the host empty */
        }

        // The bar down the side takes the site's own colour, as Discord does.
        // A near black one would vanish into the card, so those keep the plain line.
        if (p.colour && brightness(p.colour) > 0.12) box.style.setProperty('--site', p.colour)

        const site = h('div', { class: 'link-card-site' })
        const favicon = web(p.icon)
        if (favicon) {
          const img = picture(favicon, 'link-card-icon')
          img.addEventListener('error', () => img.remove())
          site.append(img)
        }
        site.append(h('span', { class: 'truncate', text: p.site || host }))

        const body = h('div', { class: 'link-card-body' }, [site])
        if (p.title) body.append(out(h('span', { class: 'link-card-title', text: p.title })))
        if (p.description) body.append(h('div', { class: 'link-card-desc', text: p.description }))
        box.append(body)

        const image = web(p.image)
        if (image && p.large) {
          const hero = picture(image, 'link-card-hero')
          if (p.width && p.height) hero.style.aspectRatio = `${p.width} / ${p.height}`
          const frame = out(hero)
          frame.className = 'link-card-frame'
          if (p.video) frame.append(h('span', { class: 'link-card-play' }, [icon('play', 22)]))
          hero.addEventListener('error', () => frame.remove())
          box.append(frame)
          box.classList.add('large')
        } else if (image) {
          const thumb = picture(image, 'link-card-thumb')
          const frame = out(thumb)
          frame.className = 'link-card-side'
          thumb.addEventListener('error', () => frame.remove())
          box.append(frame)
        }
        box.classList.remove('hidden')
        line.parentElement?.classList.add('roomy')
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
    // Off to an older message: the log stops following the newest.
    this.pinned = false
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    this.found = { id, at: Date.now() }
    row.classList.remove('found')
    // Restart the highlight even when the same one is clicked twice.
    void row.offsetWidth
    row.classList.add('found')
  }

  private rowActions(m: Message, mine: boolean): HTMLElement {
    const bar = h('div', { class: 'chat-actions' })
    if (this.canPin) {
      bar.append(
        withTip(
          h(
            'button',
            {
              class: m.pinned ? 'on' : '',
              ariaLabel: m.pinned ? 'Unpin' : 'Pin',
              on: { click: () => this.actions?.pin(m.id, !m.pinned) },
            },
            [icon('pin', 19)],
          ),
          m.pinned ? 'Unpin' : 'Pin',
        ),
      )
    }
    const react = h(
      'button',
      {
        ariaLabel: 'Add reaction',
        on: { click: () => this.reactWith(m, react) },
      },
      [icon('smile', 19)],
    )
    bar.append(
      withTip(react, 'Add reaction'),
      withTip(
        h('button', { ariaLabel: 'Reply', on: { click: () => this.startReply(m) } }, [icon('reply', 19)]),
        'Reply',
      ),
    )
    if (!this.threadRoot) {
      bar.append(
        withTip(
          h('button', { ariaLabel: 'Reply in thread', on: { click: () => this.onThread?.(m.id) } }, [
            icon('thread', 19),
          ]),
          'Reply in thread',
        ),
      )
    }
    if (mine) {
      bar.append(
        withTip(
          h('button', { ariaLabel: 'Edit', on: { click: () => this.startEdit(m) } }, [icon('edit', 18)]),
          'Edit',
        ),
        actionDivider(),
        withTip(
          h(
            'button',
            {
              class: 'danger',
              ariaLabel: 'Delete',
              on: { click: () => this.askDelete(m.id) },
            },
            [icon('trash', 19)],
          ),
          'Delete',
        ),
      )
    } else if (this.canDelete) {
      bar.append(
        actionDivider(),
        withTip(
          h(
            'button',
            {
              class: 'danger',
              ariaLabel: 'Delete this message',
              on: {
                click: () => this.askDelete(m.id),
              },
            },
            [icon('trash', 19)],
          ),
          'Delete',
        ),
      )
    }
    return bar
  }

  /** Asks in the message's own row, not in a window, before a message goes. */
  private askDelete(id: string): void {
    const row = this.log.querySelector(`[data-id="${id}"]`)
    if (!(row instanceof HTMLElement)) return
    this.log.querySelector('.chat-delete-ask')?.remove()
    const close = (): void => {
      ask.remove()
      document.removeEventListener('keydown', onKey, true)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      close()
    }
    const yes = h('button', {
      class: 'small danger-fill',
      text: 'Delete',
      on: {
        click: () => {
          close()
          this.actions?.retract(id)
        },
      },
    })
    const ask = h('div', { class: 'chat-delete-ask', role: 'alertdialog', ariaLabel: 'Delete this message?' }, [
      h('span', { text: 'Delete this message?' }),
      h('button', { class: 'ghost small', text: 'Cancel', on: { click: close } }),
      yes,
    ])
    row.append(ask)
    document.addEventListener('keydown', onKey, true)
    yes.focus()
  }

  private messageMenu(m: Message, mine: boolean, line: HTMLElement): MenuEntry[] {
    const lead = (name: Parameters<typeof icon>[0]): HTMLElement => h('span', { class: 'menu-icon' }, [icon(name, 16)])
    const reacted = (emoji: string): boolean => m.reactions.get(emoji)?.has(this.me) === true
    const quick = h('div', { class: 'menu-reacts' })
    for (const emoji of quickRow()) {
      quick.append(
        h('button', {
          class: `chat-react${reacted(emoji) ? ' on' : ''}`,
          text: emoji,
          title: `React with ${emoji}`,
          on: {
            click: () => {
              closeMenu()
              this.actions?.react(m.id, emoji, !reacted(emoji))
            },
          },
        }),
      )
    }

    const items: MenuEntry[] = [
      { custom: quick },
      {
        label: 'Add a reaction',
        lead: lead('smile'),
        run: () =>
          openEmojiPicker({
            anchor: line,
            title: 'React to this message',
            sticky: true,
            onPick: (emoji) => this.actions?.react(m.id, emoji, !reacted(emoji)),
          }),
      },
      'line',
      { label: 'Reply', lead: lead('reply'), run: () => this.startReply(m) },
    ]
    if (!this.threadRoot) {
      items.push({ label: 'Reply in a thread', lead: lead('thread'), run: () => this.onThread?.(m.id) })
    }
    if (this.canPin) {
      items.push({
        label: m.pinned ? 'Unpin' : 'Pin',
        lead: lead('pin'),
        run: () => this.actions?.pin(m.id, !m.pinned),
      })
    }
    if (this.shown.has(m.id) && this.log.classList.contains('nsfw')) {
      items.push({
        label: 'Blur again',
        lead: lead('eye-off'),
        run: () => {
          this.shown.delete(m.id)
          line.classList.remove('shown')
        },
      })
    }
    if (mine && !m.poll) items.push({ label: 'Edit', lead: lead('edit'), run: () => this.startEdit(m) })
    if (m.text) {
      items.push({
        label: 'Copy text',
        lead: lead('copy'),
        run: () => {
          navigator.clipboard.writeText(m.text).then(
            () => toast('Copied.'),
            () => toast('Could not copy that.', 'warn'),
          )
        },
      })
    }
    const targets =
      (mine || this.canRelocate) && !m.inThread && this.actions?.relocate ? this.relocateTargets?.(m) ?? [] : []
    if (targets.length) {
      items.push('line', { heading: 'Move to' })
      for (const c of targets) {
        items.push({ label: c.label, lead: lead('hash'), run: () => this.actions?.relocate?.(m.id, c.name) })
      }
    }
    if (mine || this.canDelete) {
      items.push('line', {
        label: 'Delete',
        lead: lead('trash'),
        danger: true,
        run: () => this.askDelete(m.id),
      })
    }
    return items
  }

  /** The names of who reacted, you first, as "You, Ada and Grace". */
  private whoReacted(people: Set<string>): string {
    const names = [...people]
      .sort((a, b) => (a === this.me ? -1 : b === this.me ? 1 : 0))
      .map((key) => (key === this.me ? 'You' : this.names.get(key) || shortKey(key)))
    const shown = names.length > REACTED_NAMES_MAX ? [...names.slice(0, REACTED_NAMES_MAX), `${names.length - REACTED_NAMES_MAX} more`] : names
    return new Intl.ListFormat('en', { type: 'conjunction' }).format(shown)
  }

  /** Who reacted with this emoji, in a card over the chip, while the pointer or the keyboard is on it. */
  private showWhoReacted(chip: HTMLElement, emoji: string, people: Set<string>): void {
    let card: HTMLElement | null = null
    let watch = 0
    const hide = (): void => {
      window.clearInterval(watch)
      card?.remove()
      card = null
    }
    const show = (): void => {
      if (card) return
      document.querySelector('.react-who')?.remove()
      card = h('div', { class: 'react-who', role: 'tooltip' }, [
        h('span', { class: 'react-who-face', text: emoji }),
        h('span', { class: 'react-who-names', text: `${this.whoReacted(people)} reacted` }),
      ])
      document.body.append(card)
      fitNear(card, chip)
      // A chip drawn again under the pointer never says the pointer left: its card goes with it.
      watch = window.setInterval(() => chip.isConnected || hide(), 300)
    }
    chip.addEventListener('pointerenter', show)
    chip.addEventListener('pointerleave', hide)
    chip.addEventListener('focus', show)
    chip.addEventListener('blur', hide)
    chip.addEventListener('click', hide)
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
    if (phone()) asSheet(pop, () => pop.remove())
    else placeNear(pop, anchor)

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
    const name = h('strong', { class: 'chat-reply-name', text: m.name || shortKey(m.author) })
    const colour = this.colourOf(m.author)
    if (colour) name.style.color = roleInk(colour)
    this.showPending('reply', ['Replying to ', name], m)
    this.textInput.focus()
  }

  private startEdit(m: Message): void {
    this.replyTo = null
    this.editing = m
    this.textInput.value = m.text
    this.showPending('edit', ['Editing your message'], m)
    this.textInput.focus()
  }

  /**
   * The bar over the message box while you reply or edit, as Discord's: what you do, to whom, a
   * line of the message, and the message itself lit in the chat, so it is hard to forget.
   */
  private showPending(kind: 'reply' | 'edit', label: (string | Node)[], m: Message): void {
    clear(this.replyBar)
    this.replyBar.classList.remove('hidden')
    this.replyBar.dataset.kind = kind
    const quote = m.text.replace(/\s+/g, ' ').trim() || (m.files?.length ? 'A file' : '')
    this.replyBar.append(
      h('span', { class: 'chat-replying-icon' }, [icon(kind === 'reply' ? 'reply' : 'edit', 16)]),
      h('span', { class: 'chat-replying-words grow' }, [
        h('span', { class: 'chat-replying-what truncate' }, label),
        quote && kind === 'reply' ? h('span', { class: 'chat-replying-quote truncate', text: quote }) : null,
      ]),
      h('span', { class: 'chat-replying-key tiny faint', text: 'Esc to cancel' }),
      h(
        'button',
        { class: 'ghost icon-only pop-close', title: 'Cancel', ariaLabel: 'Cancel', on: { click: () => this.cancelPending() } },
        [icon('close', 16)],
      ),
    )
    this.markPending(m.id)
  }

  /** Lights the message you reply to, or edit, in the chat. */
  private markPending(id: string | null): void {
    for (const lit of this.log.querySelectorAll('.pending')) lit.classList.remove('pending')
    if (!id) return
    const line = this.log.querySelector(`.chat-line[data-id="${CSS.escape(id)}"]`)
    line?.classList.add('pending')
    line?.parentElement?.classList.add('pending')
  }

  private cancelPending(): void {
    this.replyTo = null
    if (this.editing) this.textInput.value = ''
    this.editing = null
    this.replyBar.classList.add('hidden')
    delete this.replyBar.dataset.kind
    clear(this.replyBar)
    this.markPending(null)
  }

  /** Waits a frame, because a loaded picture resizes its row only after the next layout. */
  private followMedia(): void {
    if (!this.pinned) return
    requestAnimationFrame(() => {
      if (!this.pinned) return
      this.toNewest()
      this.showJump()
    })
  }

  /** The log at its newest message, and where that is noted, so a move up from it is seen. */
  /** The keyboard is about to come or go: a log at its newest message stays there through it. */
  private followKeyboard(): void {
    // Only a touch screen has a keyboard that comes up over the page.
    if (!window.matchMedia('(pointer: coarse)').matches) return
    if (!this.pinned && !this.isAtBottom()) return
    this.pinned = true
    this.keyboardUntil = Date.now() + 1500
  }

  private toNewest(): void {
    this.log.scrollTop = this.log.scrollHeight
    this.lastTop = this.log.scrollTop
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
    const toChannel = !this.directWith && (this.editing ? !this.editing.inThread : !this.threadRoot)
    if (this.mediaOnly && !this.mediaExempt && toChannel && !hasMedia(text, this.editing ? this.editing.files : files)) {
      toast('Only pictures, videos and files go in this channel. Words go in a thread.', 'warn')
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

/** Whether a sent message's spoiler, by its order within it, has already been opened. */
interface SpoilerHooks {
  isOpen(key: string): boolean
  open(key: string): void
}

const NO_SPOILER_HOOKS: SpoilerHooks = { isOpen: () => false, open: () => undefined }

/** Builds DOM nodes, never HTML, so nothing a person types can become markup. */
function formatText(
  text: string,
  names: Map<string, string>,
  me: string,
  colourOf: ColourOf,
  spoilerKeyBase = '',
  spoilers: SpoilerHooks = NO_SPOILER_HOOKS,
): Node[] {
  const out: Node[] = []
  const lines = text.split('\n')
  let i = 0
  // Counts every spoiler in the message in reading order, so each gets its own, stable key.
  const spoilerAt = { n: 0 }

  const fence = (): void => {
    const language = lines[i].slice(3).trim().slice(0, 20)
    const body: string[] = []
    i += 1
    while (i < lines.length && !lines[i].startsWith('```')) {
      body.push(lines[i])
      i += 1
    }
    i += 1
    const code = body.join('\n')
    const block = h('pre', { class: 'chat-code' }, [h('code', {}, highlight(code, familyOf(language, code)))])
    if (language) block.dataset.language = language
    out.push(block)
  }

  const quote = (): void => {
    const block = h('blockquote', { class: 'chat-quote' })
    let n = 0
    while (i < lines.length && /^>\s?/.test(lines[i])) {
      if (n > 0) block.append(h('br'))
      for (const node of formatLine(lines[i].replace(/^>\s?/, ''), names, me, colourOf, spoilerKeyBase, spoilers, spoilerAt)) block.append(node)
      n += 1
      i += 1
    }
    out.push(block)
  }

  const list = (ordered: boolean): void => {
    const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/
    const block = h(ordered ? 'ol' : 'ul', { class: 'chat-list' })
    while (i < lines.length && pattern.test(lines[i])) {
      block.append(h('li', {}, formatLine(lines[i].replace(pattern, ''), names, me, colourOf, spoilerKeyBase, spoilers, spoilerAt)))
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
    for (const node of formatLine(line, names, me, colourOf, spoilerKeyBase, spoilers, spoilerAt)) out.push(node)
    plain += 1
    i += 1
  }
  return out
}

function formatLine(
  line: string,
  names: Map<string, string>,
  me: string,
  colourOf: ColourOf,
  spoilerKeyBase: string,
  spoilers: SpoilerHooks,
  spoilerAt: { n: number },
): Node[] {
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
      const tag = h('span', { class: `mention${mine ? ' me' : ''}`, text: `@${hit.label}` })
      // A person's mention opens their profile, as their name does. @everyone is nobody's.
      if (hit.key !== EVERYONE) {
        tag.dataset.who = hit.key
        tag.tabIndex = 0
        tag.setAttribute('role', 'button')
      }
      const colour = hit.key === EVERYONE ? '' : colourOf(hit.key)
      if (colour) tag.style.setProperty('--who', colour)
      out.push(tag)
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
          else if ((match = /^\|\|([\s\S]+?)\|\|/.exec(rest))) {
            const key = `${spoilerKeyBase}:${spoilerAt.n++}`
            node = spoilerReveal(match[1], spoilers.isOpen(key), () => spoilers.open(key))
          } else if ((match = /^~~([\s\S]+?)~~/.exec(rest))) node = h('s', { text: match[1] })
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


/** A size after a #, as a GIF from the picker carries it: "#480x270". */
const SIZE_TAG_RE = /#(\d{1,4})x(\d{1,4})$/
const EMBED_MAX_W = 320
const EMBED_MAX_H = 240
const SIZES_KEY = 'nook.media-sizes.v1'
const SIZES_MAX = 400

let sizes: Record<string, [number, number]> | null = null

function sizeBook(): Record<string, [number, number]> {
  if (sizes) return sizes
  try {
    sizes = JSON.parse(localStorage.getItem(SIZES_KEY) ?? '{}') as Record<string, [number, number]>
  } catch {
    sizes = {}
  }
  return sizes
}

/** Keeps the size of a picture once it loads, so the next time it holds its place from the start. */
function rememberSize(src: string, w: number, h: number): void {
  if (!w || !h) return
  const book = sizeBook()
  if (book[src]?.[0] === w && book[src]?.[1] === h) return
  book[src] = [w, h]
  const keys = Object.keys(book)
  for (const old of keys.slice(0, Math.max(0, keys.length - SIZES_MAX))) delete book[old]
  try {
    localStorage.setItem(SIZES_KEY, JSON.stringify(book))
  } catch {}
}

function knownSize(src: string): [number, number] | null {
  const tag = SIZE_TAG_RE.exec(src)
  if (tag) return [Number(tag[1]), Number(tag[2])]
  return sizeBook()[src] ?? null
}

function fitted([w, h]: [number, number]): [number, number] {
  const scale = Math.min(1, EMBED_MAX_W / w, EMBED_MAX_H / h)
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))]
}

function embed(src: string): HTMLElement {
  const address = src.replace(/#.*$/, '')
  const media = CLIP_RE.test(address) ? clip(src) : picture(src)
  media.addEventListener('error', () => wrap.remove(), true)
  const wrap = h('a', { class: 'chat-image-wrap media-loading' }, [media])
  // The box has its size before a byte arrives, so nothing below it moves when it does.
  const size = knownSize(src)
  const [w, hgt] = fitted(size ?? [EMBED_MAX_W, 180])
  wrap.style.width = `${w}px`
  wrap.style.aspectRatio = `${w} / ${hgt}`
  if (!size) wrap.classList.add('unsized')
  const loaded = (): void => {
    wrap.classList.remove('media-loading')
    if (media instanceof HTMLImageElement) rememberSize(src, media.naturalWidth, media.naturalHeight)
    else if (media instanceof HTMLVideoElement) rememberSize(src, media.videoWidth, media.videoHeight)
  }
  media.addEventListener(media instanceof HTMLVideoElement ? 'loadeddata' : 'load', loaded, { once: true })
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
  return t.length <= MAX_TEXT && isDrawing(t) ? t : null
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
  video.loop = true
  video.muted = true
  video.playsInline = true
  video.controls = false
  // Enough for its size. The rest loads when it comes near the screen and plays.
  video.preload = 'metadata'
  // A video element has no referrerPolicy property, so it is set as an attribute.
  video.setAttribute('referrerpolicy', 'no-referrer')
  // Safari needs the attributes as well as the properties before it will play muted.
  video.setAttribute('muted', '')
  video.setAttribute('playsinline', '')
  playWhileSeen(video)
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
