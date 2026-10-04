import type { RoomNote } from '../store/notes'
import { h, keyed } from './dom'

export interface Navigation {
  home(): void
  add(): void
  open(room: RoomNote): void
}

/** The picture before the title in the desktop app's title bar, and what it shows, to draw it once. */
export interface TitleFace {
  key: string
  make: () => HTMLElement
}

export interface WindowChrome {
  readonly root: HTMLElement
  readonly body: HTMLElement
  readonly nav: Navigation
  readonly status: HTMLElement
  /** The window's title, and the picture before it in the desktop app: a space's face, or somebody's. */
  setTitle(text: string, face?: TitleFace): void
  setStatus(panels: string[]): void
}

/**
 * The desktop app's title bar has a place for a picture before the title (#nook-title-face), as
 * Discord puts the server's icon before the channel. A browser has no title bar, and no place.
 */
export function setTitleFace(face: TitleFace | null): void {
  const put = (): boolean => {
    const slot = document.getElementById('nook-title-face')
    if (!slot) return false
    const key = face?.key ?? ''
    if (slot.dataset.key === key) return true
    slot.dataset.key = key
    slot.replaceChildren(...(face ? [face.make()] : []))
    return true
  }
  // The shell draws its bar once the page has loaded: before that, the picture waits for it.
  if (!put() && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void put(), { once: true })
}

export function createWindow(title: string, nav: Navigation): WindowChrome {
  document.title = title
  setTitleFace(null)

  const body = h('div', { class: 'app-body' })
  const status = h('div', { class: 'status-bar' })
  const root = h('div', { class: 'app-shell' }, [body])

  const setStatus = (panels: string[]): void => {
    keyed(
      status,
      panels.map((panel, i) => ({ key: String(i), el: h('div', { class: `status-cell${i === 0 ? ' grow' : ''}` }, [panel]) })),
    )
  }

  setStatus(['Ready'])

  return {
    root,
    body,
    nav,
    status,
    setTitle: (text, face) => {
      document.title = text
      setTitleFace(face ?? null)
    },
    setStatus,
  }
}
