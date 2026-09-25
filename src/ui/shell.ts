import type { RoomNote } from '../store/notes'
import { h } from './dom'

export interface Navigation {
  home(): void
  add(): void
  open(room: RoomNote): void
}

export interface WindowChrome {
  readonly root: HTMLElement
  readonly body: HTMLElement
  readonly nav: Navigation
  readonly status: HTMLElement
  setTitle(text: string): void
  setStatus(panels: (HTMLElement | string)[]): void
}

export function createWindow(title: string, nav: Navigation): WindowChrome {
  document.title = title

  const body = h('div', { class: 'app-body' })
  const status = h('div', { class: 'status-bar' })
  const root = h('div', { class: 'app-shell' }, [body])

  const setStatus = (panels: (HTMLElement | string)[]): void => {
    status.replaceChildren(
      ...panels.map((panel, i) => h('div', { class: `status-cell${i === 0 ? ' grow' : ''}` }, [panel])),
    )
  }

  setStatus(['Ready'])

  return {
    root,
    body,
    nav,
    status,
    setTitle: (text) => {
      document.title = text
    },
    setStatus,
  }
}
