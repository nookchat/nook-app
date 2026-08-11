/**
 * The chat panel.
 *
 * A sunken list of lines, a name you can change, and a box to type in. It knows
 * nothing about peers or data channels: it draws what it is given and calls back
 * when somebody types. Whoever owns the connections decides where a line goes.
 */

import { cleanName, loadName, saveName, type ChatLine } from '../chat'
import { clear, h } from './dom'

const MAX_LINES = 300

export class ChatPanel {
  readonly root: HTMLElement
  /** Called when this person types a line. */
  onSay: ((text: string) => void) | null = null
  /** Called when this person renames themselves. */
  onRename: ((name: string) => void) | null = null

  private readonly log: HTMLDivElement
  private readonly nameInput: HTMLInputElement
  private readonly textInput: HTMLInputElement
  private readonly sendButton: HTMLButtonElement
  private readonly count: HTMLSpanElement
  private name: string

  constructor(title = 'Chat') {
    this.name = loadName()

    this.log = h('div', { class: 'chat-log' })
    this.count = h('span', { class: 'pill', text: '1 here' })

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
          if ((ev as KeyboardEvent).key === 'Enter') this.say()
        },
      },
    })

    this.sendButton = h('button', { text: 'Send', on: { click: () => this.say() } })

    this.root = h('div', { class: 'card chat-panel' }, [
      h('div', { class: 'row spread chat-head' }, [
        h('span', { class: 'eyebrow', text: title }),
        this.count,
      ]),
      this.log,
      h('div', { class: 'chat-compose stack tight' }, [
        h('div', { class: 'row' }, [
          h('span', { class: 'tiny faint', text: 'You', style: { width: '26px' } }),
          this.nameInput,
        ]),
        h('div', { class: 'row' }, [this.textInput, this.sendButton]),
      ]),
    ])
  }

  get currentName(): string {
    return this.name
  }

  /** Say how many people are in the room, the host included. */
  setPresence(people: number): void {
    this.count.textContent = `${people} here`
  }

  /** Turn the box on only once a line can actually reach somebody. */
  setEnabled(enabled: boolean, why = ''): void {
    this.textInput.disabled = !enabled
    this.sendButton.disabled = !enabled
    this.textInput.placeholder = enabled ? 'Say something' : why || 'Connecting...'
  }

  append(line: ChatLine): void {
    const stuck = this.isAtBottom()

    if (line.kind === 'said') {
      this.log.append(
        h('div', { class: `chat-line${line.mine ? ' mine' : ''}` }, [
          h('span', { class: 'chat-name', text: `${line.name}: ` }),
          h('span', { class: 'chat-text', text: line.text }),
        ]),
      )
    } else {
      this.log.append(
        h('div', { class: 'chat-line system' }, [
          h('span', {
            text: `${line.name} ${line.kind === 'joined' ? 'joined' : 'left'}`,
          }),
        ]),
      )
    }

    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild?.remove()
    // Follow the conversation, unless the reader has scrolled up to look back.
    if (stuck) this.log.scrollTop = this.log.scrollHeight
  }

  clearLog(): void {
    clear(this.log)
  }

  focus(): void {
    this.textInput.focus()
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
    saveName(next)
    this.onRename?.(next)
  }

  private say(): void {
    const text = this.textInput.value.trim()
    if (!text) return
    this.textInput.value = ''
    this.onSay?.(text)
  }
}
