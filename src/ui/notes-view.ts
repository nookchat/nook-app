import type { NoteInfo } from '../store/log'
import { clear, h } from './dom'
import { renderMarkdown } from './markdown'

type Mode = 'write' | 'split' | 'read'

const MODE_KEY = 'nook:note-mode'
const SAVE_AFTER_MS = 1200
const PREVIEW_AFTER_MS = 120

function savedMode(): Mode {
  try {
    const mode = localStorage.getItem(MODE_KEY)
    if (mode === 'write' || mode === 'split' || mode === 'read') return mode
  } catch {
    /* storage can be blocked */
  }
  return 'split'
}

function keepMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* storage can be blocked */
  }
}

export interface NoteHooks {
  save(id: string, title: string | undefined, text: string | undefined): Promise<void>
  nameOf(key: string): string
}

/** One shared note: the markdown on the left, how it reads on the right. */
export class NoteEditor {
  readonly root: HTMLElement
  private readonly hooks: NoteHooks
  private readonly title: HTMLInputElement
  private readonly source: HTMLTextAreaElement
  private readonly reader: HTMLElement
  private readonly status: HTMLElement
  private readonly modeButtons = new Map<Mode, HTMLButtonElement>()
  private mode = savedMode()
  private note: NoteInfo | null = null
  /** What we last sent or took in, to tell our own changes from theirs. */
  private shownText = ''
  private shownTitle = ''
  private saveTimer: number | null = null
  private previewTimer: number | null = null
  private saving = false

  constructor(hooks: NoteHooks) {
    this.hooks = hooks
    this.title = h('input', {
      type: 'text',
      class: 'note-title',
      placeholder: 'Untitled',
      ariaLabel: 'Note title',
      on: {
        input: () => this.later(),
        blur: () => this.saveNow(),
        keydown: (ev) => {
          if ((ev as KeyboardEvent).key === 'Enter') {
            ev.preventDefault()
            this.source.focus()
          }
        },
      },
    })
    this.title.maxLength = 80
    this.source = h('textarea', {
      class: 'note-source',
      placeholder: '# A heading\n\nWrite in markdown. Everybody in this space can read and change it.',
      ariaLabel: 'Note in markdown',
      on: {
        input: () => {
          this.later()
          this.previewSoon()
        },
        blur: () => this.saveNow(),
        keydown: (ev) => this.onKey(ev as KeyboardEvent),
      },
    })
    this.source.spellcheck = true
    this.reader = h('div', { class: 'note-reader md' })
    this.status = h('span', { class: 'tiny faint note-status' })

    const modes = h('div', { class: 'note-modes', role: 'group', ariaLabel: 'How to show the note' })
    const labels: [Mode, string][] = [
      ['write', 'Write'],
      ['split', 'Both'],
      ['read', 'Read'],
    ]
    for (const [mode, label] of labels) {
      const button = h('button', { class: 'ghost', text: label, on: { click: () => this.setMode(mode) } })
      this.modeButtons.set(mode, button)
      modes.append(button)
    }

    this.root = h('div', { class: 'note-view hidden' }, [
      h('div', { class: 'note-bar row' }, [this.title, this.status, modes]),
      h('div', { class: 'note-panes' }, [this.source, this.reader]),
    ])
    this.setMode(this.mode)
  }

  get openId(): string | null {
    return this.note?.id ?? null
  }

  /** Shows a note. Calling it again with a newer version takes in the changes that are not ours. */
  show(note: NoteInfo): void {
    const other = this.note?.id !== note.id
    if (other) {
      this.saveNow()
      this.note = note
      this.shownText = note.text
      this.shownTitle = note.title
      this.title.value = note.title
      this.source.value = note.text
      this.drawReader()
      this.root.classList.remove('hidden')
      this.paintStatus()
      return
    }
    this.note = note
    // Somebody else changed it: take it, unless we have changes of our own waiting.
    if (note.text !== this.shownText && this.source.value === this.shownText) {
      this.shownText = note.text
      const at = this.source.selectionStart
      this.source.value = note.text
      if (document.activeElement === this.source) this.source.setSelectionRange(at, at)
      this.drawReader()
    }
    if (note.title !== this.shownTitle && this.title.value === this.shownTitle) {
      this.shownTitle = note.title
      this.title.value = note.title
    }
    this.paintStatus()
  }

  hide(): void {
    this.saveNow()
    this.note = null
    this.root.classList.add('hidden')
  }

  focus(): void {
    if (this.mode === 'read') this.setMode('split')
    if (!this.source.value) this.source.focus()
    else this.title.focus()
  }

  private setMode(mode: Mode): void {
    this.mode = mode
    keepMode(mode)
    this.root.dataset.mode = mode
    for (const [m, button] of this.modeButtons) {
      button.classList.toggle('on', m === mode)
      button.setAttribute('aria-pressed', String(m === mode))
    }
    if (mode !== 'write') this.drawReader()
  }

  private drawReader(): void {
    if (this.mode === 'write') return
    clear(this.reader)
    const text = this.source.value
    if (text.trim()) this.reader.append(renderMarkdown(text))
    else this.reader.append(h('p', { class: 'faint', text: 'Nothing here yet.' }))
  }

  private previewSoon(): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer)
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null
      this.drawReader()
    }, PREVIEW_AFTER_MS)
  }

  private later(): void {
    this.paintStatus()
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.saveNow(), SAVE_AFTER_MS)
  }

  private saveNow(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = null
    const note = this.note
    if (!note) return
    const text = this.source.value
    const title = this.title.value.trim() || 'Untitled'
    const newText = text !== this.shownText ? text : undefined
    const newTitle = title !== this.shownTitle ? title : undefined
    if (newText === undefined && newTitle === undefined) return
    this.shownText = text
    this.shownTitle = title
    this.saving = true
    this.paintStatus()
    void this.hooks
      .save(note.id, newTitle, newText)
      .catch(() => {
        // Put it back as unsaved so the next edit, or leaving, tries again.
        if (newText !== undefined) this.shownText = ''
        if (newTitle !== undefined) this.shownTitle = ''
      })
      .finally(() => {
        this.saving = false
        this.paintStatus()
      })
  }

  private paintStatus(): void {
    const note = this.note
    if (!note) return
    const dirty = this.source.value !== this.shownText || (this.title.value.trim() || 'Untitled') !== this.shownTitle
    if (this.saving) this.status.textContent = 'Saving...'
    else if (dirty) this.status.textContent = 'Not saved yet'
    else {
      const who = this.hooks.nameOf(note.by) || 'somebody'
      const when = new Date(note.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      this.status.textContent = `Saved · ${who}, ${when}`
    }
  }

  private onKey(ev: KeyboardEvent): void {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      this.saveNow()
      return
    }
    if (ev.key === 'Tab' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault()
      const { selectionStart: start, selectionEnd: end, value } = this.source
      if (ev.shiftKey) {
        const lineStart = value.lastIndexOf('\n', start - 1) + 1
        if (value.startsWith('  ', lineStart)) {
          this.source.setRangeText('', lineStart, lineStart + 2, 'preserve')
        }
      } else {
        this.source.setRangeText('  ', start, end, 'end')
      }
      this.source.dispatchEvent(new Event('input'))
    }
  }
}
