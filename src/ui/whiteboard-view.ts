import type { WhiteboardEntry, WhiteboardInfo } from '../store/log'
import { h } from './dom'
import { toast } from './toast'
import type { Canvas } from './whiteboard-canvas'

export interface WhiteboardHooks {
  /** Writes the records that changed. Resolves to how many were too big to send. */
  draw(id: string, records: readonly WhiteboardEntry[]): Promise<number>
  records(id: string): WhiteboardEntry[]
  nameOf(key: string): string
  /** The buttons in the whiteboard's bar, for what may be done to it. */
  tools(board: WhiteboardInfo): HTMLElement[]
}

/**
 * tldraw draws only on localhost without a license key: on a real domain it stops after five
 * seconds. With no key in the build, the whiteboards are not shown at all. Build with
 * VITE_TLDRAW_LICENSE_KEY set and they come back.
 */
export const WHITEBOARDS = !!import.meta.env.VITE_TLDRAW_LICENSE_KEY || /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname)

/** One shared whiteboard, drawn with tldraw. It loads the first time a board opens. */
export class WhiteboardView {
  readonly root: HTMLElement
  /** The board's buttons. The space puts them in its head, in place of search and the pins. */
  readonly tools = h('div', { class: 'note-tools whiteboard-tools row' })
  private readonly hooks: WhiteboardHooks
  private readonly host: HTMLElement
  private readonly status: HTMLElement
  private board: WhiteboardInfo | null = null
  private canvas: Canvas | null = null
  /** Counts each open, so a slow load for a board that was closed again does nothing. */
  private opening = 0
  private sending = 0

  constructor(hooks: WhiteboardHooks) {
    this.hooks = hooks
    this.host = h('div', { class: 'whiteboard-host' })
    this.status = h('span', { class: 'tiny faint note-status' })
    this.root = h('div', { class: 'whiteboard-view hidden', tabIndex: -1 }, [
      h('div', { class: 'note-bar row' }, [this.status]),
      this.host,
    ])
  }

  get openId(): string | null {
    return this.board?.id ?? null
  }

  /** Shows a board. Calling it again for the same board takes in what the others drew. */
  show(board: WhiteboardInfo): void {
    const other = this.board?.id !== board.id
    this.board = board
    this.paintStatus()
    this.tools.replaceChildren(...this.hooks.tools(board))
    if (!other) {
      this.canvas?.take(this.hooks.records(board.id))
      return
    }
    this.close()
    this.root.classList.remove('hidden')
    this.host.replaceChildren(h('p', { class: 'faint whiteboard-loading', text: 'Opening the whiteboard...' }))
    const ticket = ++this.opening
    import('./whiteboard-canvas')
      .then(({ mountCanvas }) => {
        if (ticket !== this.opening || !this.board) return
        this.host.replaceChildren()
        const id = this.board.id
        this.canvas = mountCanvas(this.host, this.hooks.records(id), (records) => this.send(id, records))
      })
      .catch(() => {
        if (ticket !== this.opening) return
        this.host.replaceChildren(h('p', { class: 'faint whiteboard-loading', text: 'The whiteboard did not load. Check the connection, then open it again.' }))
      })
  }

  /** Takes the focus from whatever opened the board, such as a button in a side bar that is shut now. */
  focus(): void {
    this.root.focus()
  }

  hide(): void {
    this.close()
    this.opening += 1
    this.board = null
    this.root.classList.add('hidden')
  }

  private close(): void {
    this.canvas?.unmount()
    this.canvas = null
    this.host.replaceChildren()
  }

  private send(id: string, records: readonly WhiteboardEntry[]): void {
    this.sending += 1
    this.paintStatus()
    void this.hooks
      .draw(id, records)
      .then((tooBig) => {
        if (tooBig > 0) toast(tooBig === 1 ? 'One drawing is too big to share. Draw it in smaller parts.' : `${tooBig} drawings are too big to share. Draw them in smaller parts.`, 'warn')
      })
      .catch(() => toast('The whiteboard did not save. Your last change may be lost.', 'warn'))
      .finally(() => {
        this.sending -= 1
        this.paintStatus()
      })
  }

  private paintStatus(): void {
    const board = this.board
    if (!board) return
    if (this.sending > 0) {
      this.status.textContent = 'Saving...'
      return
    }
    const who = this.hooks.nameOf(board.by) || 'somebody'
    const when = new Date(board.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    this.status.textContent = `Saved · ${who}, ${when}`
  }
}
