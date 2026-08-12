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
  /** Asking a question is a different shape from saying something. */
  onPoll: (() => void) | null = null
  /** Somebody is writing. Throttled by the caller, which owns the wire. */
  onTyping: (() => void) | null = null
  /** Open the thread hanging off a message, or close the one that is open. */
  onThread: ((rootId: string | null) => void) | null = null

  private readonly log: HTMLDivElement
  private readonly pins: HTMLDivElement
  private readonly nameInput: HTMLInputElement
  private readonly textInput: HTMLTextAreaElement
  private readonly sendButton: HTMLButtonElement
  private readonly pollButton: HTMLButtonElement
  private readonly emojiButton: HTMLButtonElement
  private readonly count: HTMLSpanElement
  private readonly replyBar: HTMLDivElement
  private readonly nameRow: HTMLDivElement
  private readonly typingLine: HTMLDivElement
  private readonly title: HTMLSpanElement
  private readonly backButton: HTMLButtonElement
  private name: string
  private me = ''
  private replyTo: Message | null = null
  private editing: Message | null = null
  /** Who is in the room, so a mention can be spelled and lit up. */
  private names = new Map<string, string>()
  /** The thread being read, if one is. Its root is drawn above the replies. */
  private threadRoot: string | null = null
  /**
   * Everything above this clock value has been read here.
   *
   * Held for the drawing of one line across the log rather than for the badge,
   * which the rail works out for itself. It survives a redraw, so the line does
   * not jump away the moment the next message lands.
   */
  private readMark = 0
  private suggestions: HTMLDivElement | null = null
  private suggestAt = -1

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
    this.pollButton = h('button', {
      class: 'ghost',
      text: '\u2261',
      title: 'Ask a question',
      ariaLabel: 'Ask a question',
      on: { click: () => this.onPoll?.() },
    })
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

    this.nameRow = h('div', { class: 'row' }, [
      h('span', { class: 'tiny faint', text: 'You', style: { width: '26px' } }),
      this.nameInput,
    ])

    this.pins = h('div', { class: 'chat-pins hidden' })
    this.typingLine = h('div', { class: 'chat-typing hidden' })
    this.title = h('span', { class: 'eyebrow', text: title })
    this.backButton = h('button', {
      class: 'ghost tiny-btn hidden',
      text: '← Back',
      title: 'Back to the channel',
      on: { click: () => this.onThread?.(null) },
    })

    this.root = h('div', { class: 'card chat-panel' }, [
      h('div', { class: 'row spread chat-head' }, [
        h('div', { class: 'row' }, [this.backButton, this.title]),
        this.count,
      ]),
      this.pins,
      this.log,
      h('div', { class: 'chat-compose stack tight' }, [
        this.typingLine,
        this.replyBar,
        this.nameRow,
        h('div', { class: 'row' }, [
          this.textInput,
          this.emojiButton,
          this.pollButton,
          this.sendButton,
        ]),
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

  /** Who is in the room, by key, so a mention can be spelled and recognised. */
  setNames(names: Map<string, string>): void {
    this.names = names
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
    this.backButton.classList.toggle('hidden', rootId === null)
    this.textInput.placeholder = rootId ? 'Reply in this thread' : 'Say something'
    this.cancelPending()
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
    this.textInput.disabled = !enabled
    this.sendButton.disabled = !enabled
    this.textInput.placeholder = enabled ? 'Say something' : why || 'Connecting...'
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
    if (ev.key === 'Escape') {
      this.cancelPending()
      if (this.threadRoot) this.onThread?.(null)
    }
  }

  /** As tall as what is in it, up to a point. */
  private grow(): void {
    const input = this.textInput
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 116)}px`
  }

  // ---- mentions ----

  /**
   * Offer the names that fit what has been typed after an @.
   *
   * Nothing is inserted until it is chosen: a mention that completes itself
   * while you are still typing is a mention of the wrong person half the time.
   */
  private suggest(): void {
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
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      const chosen = options[at === -1 ? 0 : at]
      if (chosen?.textContent) this.takeSuggestion(chosen.textContent)
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

  private closeSuggestions(): void {
    this.suggestions?.remove()
    this.suggestions = null
    this.suggestAt = -1
  }

  /** Draw the whole conversation. Cheap enough at chat sizes, and always right. */
  render(messages: Message[], joins: { at: number; text: string }[] = []): void {
    const stuck = this.isAtBottom()
    clear(this.log)
    this.renderPins(messages)

    const byId = new Map(messages.map((m) => [m.id, m]))
    const feed: ({ kind: 'msg'; m: Message } | { kind: 'note'; at: number; text: string })[] = [
      ...messages.map((m) => ({ kind: 'msg' as const, m })),
      ...joins.map((j) => ({ kind: 'note' as const, at: j.at, text: j.text })),
    ].sort((a, b) => (a.kind === 'msg' ? a.m.at : a.at) - (b.kind === 'msg' ? b.m.at : b.at))

    let lastDay = ''
    let lastAuthor = ''
    let drawnUnread = false

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
        this.log.append(
          h('div', { class: 'chat-new' }, [h('span', { text: 'New' })]),
        )
      }

      const mine = m.author === this.me
      const at = h('span', { class: 'chat-at', text: clockLabel(m.at) })
      const line = h('div', {
        class:
          `chat-line${mine ? ' mine' : ''}${m.pinned ? ' pinned' : ''}` +
          `${mentionsMe(m.text, this.names, this.me) ? ' calls-me' : ''}`,
      })
      line.dataset.id = m.id

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

      // A run from one person shows the name once, and the clock once. The rest
      // of the run shows its time when the pointer is on it.
      if (m.author !== lastAuthor) {
        line.append(
          h('span', { class: 'chat-name', text: `${m.name || shortKey(m.author)}: ` }),
        )
      } else {
        at.classList.add('on-hover')
      }
      lastAuthor = m.replyTo ? '' : m.author

      const text = h('span', { class: 'chat-text' })
      if (m.poll) {
        text.append(h('strong', { text: m.poll.question }))
        line.append(text)
        line.append(this.pollBox(m))
      } else {
        for (const node of formatText(m.text, this.names, this.me)) text.append(node)
        line.append(text)
        for (const src of imageLinks(m.text)) line.append(embed(src))
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
        const row = h('div', { class: 'chat-reacts' })
        for (const [emoji, who] of m.reactions) {
          row.append(
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
        row.append(more)
        line.append(row)
      }

      line.append(this.rowActions(m, mine))
      this.log.append(line)

      // In a thread, a rule under the question it hangs off. What follows is
      // the answers, and they read as answers rather than as more questions.
      if (this.threadRoot && m.id === this.threadRoot) {
        const count = messages.length - 1
        this.log.append(
          h('div', { class: 'chat-new thread' }, [
            h('span', {
              text: count === 0 ? 'No replies yet' : `${count} ${count === 1 ? 'reply' : 'replies'}`,
            }),
          ]),
        )
        lastAuthor = ''
      }
    }

    if (stuck) this.log.scrollTop = this.log.scrollHeight
  }

  // ---- internals ----

  /**
   * The messages held up at the top.
   *
   * A line each, not the whole message: this is a way back to something, not a
   * second copy of the conversation. Clicking one scrolls to it and lights it
   * up, because a pinned message is only useful if you can get to what was
   * said around it.
   */
  private renderPins(messages: Message[]): void {
    clear(this.pins)
    const pinned = messages.filter((m) => m.pinned)
    this.pins.classList.toggle('hidden', pinned.length === 0)
    if (pinned.length === 0) return

    this.pins.append(
      h('span', { class: 'eyebrow', text: pinned.length === 1 ? 'Pinned' : `Pinned (${pinned.length})` }),
    )
    for (const m of pinned) {
      this.pins.append(
        h('button', {
          class: 'chat-pin truncate',
          title: 'Go to this message',
          text: `${m.name || shortKey(m.author)}: ${m.text}`,
          on: { click: () => this.jumpTo(m.id) },
        }),
      )
    }
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
    this.grow()
    this.closeSuggestions()
    if (this.editing) {
      this.actions?.edit(this.editing.id, text)
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
  lines.forEach((line, i) => {
    if (i > 0) out.push(h('br'))
    for (const node of formatLine(line, names, me)) out.push(node)
  })
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
