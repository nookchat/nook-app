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

import type { Message } from '../store/log'
import { cleanName } from '../chat'
import { shortKey } from '../store/identity'
import { clear, h } from './dom'

const QUICK = ['👍', '😂', '🔥', '❤️', '👀']

export interface ChatActions {
  say(text: string, replyTo: string | null): void
  edit(id: string, text: string): void
  react(id: string, emoji: string, on: boolean): void
  retract(id: string): void
  rename(name: string): void
}

export class ChatPanel {
  readonly root: HTMLElement
  actions: ChatActions | null = null

  private readonly log: HTMLDivElement
  private readonly nameInput: HTMLInputElement
  private readonly textInput: HTMLInputElement
  private readonly sendButton: HTMLButtonElement
  private readonly count: HTMLSpanElement
  private readonly replyBar: HTMLDivElement
  private readonly nameRow: HTMLDivElement
  private name: string
  private me = ''
  private replyTo: Message | null = null
  private editing: Message | null = null

  constructor(initialName: string, title = 'Chat') {
    this.name = initialName

    this.log = h('div', { class: 'chat-log' })
    this.count = h('span', { class: 'pill', text: '1 here' })
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

    this.textInput = h('input', {
      type: 'text',
      ariaLabel: 'Write a message',
      placeholder: 'Say something',
      on: {
        keydown: (ev) => {
          const key = (ev as KeyboardEvent).key
          if (key === 'Enter') this.submit()
          if (key === 'Escape') this.cancelPending()
        },
      },
    })

    this.sendButton = h('button', { text: 'Send', on: { click: () => this.submit() } })

    this.nameRow = h('div', { class: 'row' }, [
      h('span', { class: 'tiny faint', text: 'You', style: { width: '26px' } }),
      this.nameInput,
    ])

    this.root = h('div', { class: 'card chat-panel' }, [
      h('div', { class: 'row spread chat-head' }, [
        h('span', { class: 'eyebrow', text: title }),
        this.count,
      ]),
      this.log,
      h('div', { class: 'chat-compose stack tight' }, [
        this.replyBar,
        this.nameRow,
        h('div', { class: 'row' }, [this.textInput, this.sendButton]),
      ]),
    ])
  }

  get currentName(): string {
    return this.name
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

  setPresence(people: number): void {
    this.count.textContent = `${people} here`
  }

  setEnabled(enabled: boolean, why = ''): void {
    this.textInput.disabled = !enabled
    this.sendButton.disabled = !enabled
    this.textInput.placeholder = enabled ? 'Say something' : why || 'Connecting...'
  }

  focus(): void {
    this.textInput.focus()
  }

  /** Draw the whole conversation. Cheap enough at chat sizes, and always right. */
  render(messages: Message[], joins: { at: number; text: string }[] = []): void {
    const stuck = this.isAtBottom()
    clear(this.log)

    const byId = new Map(messages.map((m) => [m.id, m]))
    const feed: ({ kind: 'msg'; m: Message } | { kind: 'note'; at: number; text: string })[] = [
      ...messages.map((m) => ({ kind: 'msg' as const, m })),
      ...joins.map((j) => ({ kind: 'note' as const, at: j.at, text: j.text })),
    ].sort((a, b) => (a.kind === 'msg' ? a.m.at : a.at) - (b.kind === 'msg' ? b.m.at : b.at))

    let lastDay = ''
    let lastAuthor = ''

    for (const item of feed) {
      if (item.kind === 'note') {
        this.log.append(h('div', { class: 'chat-line system', text: item.text }))
        lastAuthor = ''
        continue
      }
      const m = item.m
      const day = new Date(m.at).toDateString()
      if (day !== lastDay) {
        lastDay = day
        lastAuthor = ''
        this.log.append(h('div', { class: 'chat-day', text: dayLabel(m.at) }))
      }

      const mine = m.author === this.me
      const line = h('div', { class: `chat-line${mine ? ' mine' : ''}` })

      if (m.replyTo) {
        const parent = byId.get(m.replyTo)
        line.append(
          h('span', {
            class: 'chat-reply',
            text: parent
              ? `${parent.name || shortKey(parent.author)}: ${parent.text.slice(0, 60)}`
              : 'a message that is gone',
          }),
        )
      }

      // A run from one person shows the name once.
      if (m.author !== lastAuthor) {
        line.append(
          h('span', { class: 'chat-name', text: `${m.name || shortKey(m.author)}: ` }),
        )
      }
      lastAuthor = m.replyTo ? '' : m.author

      const text = h('span', { class: 'chat-text' })
      for (const node of formatText(m.text)) text.append(node)
      line.append(text)

      for (const src of imageLinks(m.text)) line.append(embed(src))

      if (m.edited) line.append(h('span', { class: 'chat-edited', text: '(edited)' }))
      line.append(h('span', { class: 'chat-at', text: clockLabel(m.at) }))

      if (m.reactions.size) {
        const row = h('div', { class: 'chat-reacts' })
        for (const [emoji, who] of m.reactions) {
          row.append(
            h('button', {
              class: `chat-react${who.has(this.me) ? ' on' : ''}`,
              text: `${emoji} ${who.size}`,
              title: 'Add or take back this reaction',
              on: { click: () => this.actions?.react(m.id, emoji, !who.has(this.me)) },
            }),
          )
        }
        line.append(row)
      }

      line.append(this.rowActions(m, mine))
      this.log.append(line)
    }

    if (stuck) this.log.scrollTop = this.log.scrollHeight
  }

  // ---- internals ----

  private rowActions(m: Message, mine: boolean): HTMLElement {
    const bar = h('div', { class: 'chat-actions' })
    bar.append(
      h('button', {
        text: '☺',
        title: 'React',
        on: { click: () => this.showReactions(m) },
      }),
      h('button', {
        text: '↩',
        title: 'Reply',
        on: { click: () => this.startReply(m) },
      }),
    )
    if (mine) {
      bar.append(
        h('button', { text: '✎', title: 'Edit', on: { click: () => this.startEdit(m) } }),
        h('button', {
          text: '✕',
          title: 'Delete for everybody who has not already read it',
          on: { click: () => this.actions?.retract(m.id) },
        }),
      )
    }
    return bar
  }

  private showReactions(m: Message): void {
    const row = h('div', { class: 'chat-reacts' })
    for (const emoji of QUICK) {
      row.append(
        h('button', {
          class: 'chat-react',
          text: emoji,
          on: {
            click: () => {
              this.actions?.react(m.id, emoji, true)
              row.remove()
            },
          },
        }),
      )
    }
    this.log.querySelector('.chat-line:hover')?.append(row)
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
    this.textInput.value = ''
    if (this.editing) {
      this.actions?.edit(this.editing.id, text)
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
 * Bold, italic, inline code and links, built as elements rather than parsed as
 * markup, so nothing a person types can become a tag. Links open in a new tab
 * with no referrer, because a room code lives in this page's fragment and has no
 * business travelling to somebody else's site.
 */
export function formatText(text: string): Node[] {
  const out: Node[] = []
  let rest = text

  const pushInline = (chunk: string): void => {
    // The order matters: code first, so markers inside it stay literal.
    const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/
    let cursor = chunk
    for (;;) {
      const match = pattern.exec(cursor)
      if (!match) break
      if (match.index > 0) out.push(document.createTextNode(cursor.slice(0, match.index)))
      if (match[1] !== undefined) out.push(h('code', { text: match[1] }))
      else if (match[2] !== undefined) out.push(h('strong', { text: match[2] }))
      else if (match[3] !== undefined) out.push(h('em', { text: match[3] }))
      else if (match[4] !== undefined) out.push(h('em', { text: match[4] }))
      cursor = cursor.slice(match.index + match[0].length)
    }
    if (cursor) out.push(document.createTextNode(cursor))
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
 * Only https, and only paths that end in a picture. A link is still a request
 * to somebody else's server, which tells them you are here, so this never
 * follows one that is not obviously a picture.
 */
const IMAGE_RE = /\.(gif|png|jpe?g|webp|avif)(\?[^\s]*)?$/i

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
    if (!IMAGE_RE.test(url.pathname + url.search)) continue
    if (!out.includes(raw)) out.push(raw)
    if (out.length === 4) break // a wall of pictures is somebody else's problem
  }
  return out
}

function embed(src: string): HTMLElement {
  const img = h('img', { class: 'chat-image' })
  img.alt = 'Shared image'
  img.loading = 'lazy'
  img.referrerPolicy = 'no-referrer'
  img.src = src
  // A link that turns out not to be a picture leaves nothing behind.
  img.addEventListener('error', () => wrap.remove())
  const wrap = h('a', { class: 'chat-image-wrap' }, [img])
  wrap.href = src
  wrap.target = '_blank'
  wrap.rel = 'noopener noreferrer'
  return wrap
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
