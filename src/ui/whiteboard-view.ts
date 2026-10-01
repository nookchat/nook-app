import type { WhiteboardInfo, WhiteboardShape } from '../store/log'
import { h } from './dom'
import { toast } from './toast'
import type { Canvas } from './whiteboard-canvas'

export interface WhiteboardHooks {
  /** Writes the shapes that changed. Resolves to how many were too big to send. */
  draw(id: string, shapes: readonly WhiteboardShape[]): Promise<number>
  shapes(id: string): WhiteboardShape[]
  nameOf(key: string): string
  /** The buttons in the whiteboard's bar, for what may be done to it. */
  tools(board: WhiteboardInfo): HTMLElement[]
}

/** Where Excalidraw finds its fonts: copied next to the app, so a board loads nothing from elsewhere. */
function useOwnFonts(): void {
  const own = window as unknown as { EXCALIDRAW_ASSET_PATH?: string }
  own.EXCALIDRAW_ASSET_PATH = new URL('excalidraw/', document.baseURI).href
}

/** One shared whiteboard, drawn with Excalidraw. It loads the first time a board opens. */
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
    this.root = h('div', { class: 'whiteboard-view hidden' }, [
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
      this.canvas?.take(this.hooks.shapes(board.id))
      return
    }
    this.close()
    this.root.classList.remove('hidden')
    this.host.replaceChildren(h('p', { class: 'faint whiteboard-loading', text: 'Opening the whiteboard...' }))
    const ticket = ++this.opening
    useOwnFonts()
    import('./whiteboard-canvas')
      .then(({ mountCanvas }) => {
        if (ticket !== this.opening || !this.board) return
        this.host.replaceChildren()
        const id = this.board.id
        this.canvas = mountCanvas(this.host, this.hooks.shapes(id), (shapes) => this.send(id, shapes))
      })
      .catch(() => {
        if (ticket !== this.opening) return
        this.host.replaceChildren(h('p', { class: 'faint whiteboard-loading', text: 'The whiteboard did not load. Check the connection, then open it again.' }))
      })
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

  private send(id: string, shapes: readonly WhiteboardShape[]): void {
    this.sending += 1
    this.paintStatus()
    void this.hooks
      .draw(id, shapes)
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
