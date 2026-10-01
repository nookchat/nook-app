// Excalidraw, and React under it, for the whiteboards. Only this file brings them in, and only the
// first time a board opens: the rest of the app does without.
import { CaptureUpdateAction, Excalidraw, reconcileElements, restoreElements } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { WhiteboardShape } from '../store/log'

/** A pause in the drawing this long sends what changed. */
const SEND_AFTER_MS = 300

export interface Canvas {
  /** What the log has now: whatever is newer than the copy on screen goes in. */
  take(shapes: readonly WhiteboardShape[]): void
  unmount(): void
}

type Element = ReturnType<ExcalidrawImperativeAPI['getSceneElementsIncludingDeleted']>[number]
type AppState = ReturnType<ExcalidrawImperativeAPI['getAppState']>

function isDark(): boolean {
  const chosen = document.documentElement.dataset.theme
  if (chosen === 'dark' || chosen === 'light') return chosen === 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** True while a shape is still being drawn, moved, turned or sized: it goes once it is let go. */
function busy(state: AppState): boolean {
  return !!(state.newElement || state.multiElement || state.resizingElement || state.isResizing || state.isRotating || state.selectedElementsAreBeingDragged)
}

const stamp = (e: { version: number; versionNonce: number }): string => `${e.version}:${e.versionNonce}`

export function mountCanvas(host: HTMLElement, shapes: readonly WhiteboardShape[], send: (changed: WhiteboardShape[]) => void): Canvas {
  let api: ExcalidrawImperativeAPI | null = null
  /** Each shape's version as the log has it, or as we sent it: anything else is a change of ours. */
  const known = new Map<string, string>()
  const learn = (list: readonly { id: string; version: number; versionNonce: number }[]): void => {
    for (const e of list) known.set(e.id, stamp(e))
  }
  const restore = (list: readonly WhiteboardShape[]): Element[] =>
    restoreElements(list as never, null, { refreshDimensions: false, repairBindings: true }) as Element[]

  const first = restore(shapes)
  learn(first)

  let timer: number | null = null
  const sendSoon = (): void => {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(sendNow, SEND_AFTER_MS)
  }
  const sendNow = (): void => {
    timer = null
    if (!api) return
    if (busy(api.getAppState())) return sendSoon()
    const changed = api.getSceneElementsIncludingDeleted().filter((e) => known.get(e.id) !== stamp(e) && e.type !== 'image' && e.type !== 'embeddable' && e.type !== 'iframe')
    if (!changed.length) return
    learn(changed)
    send(changed.map((e) => ({ ...e }) as unknown as WhiteboardShape))
  }

  const root = createRoot(host)
  const draw = (): void =>
    root.render(
      createElement(Excalidraw, {
        initialData: { elements: first, appState: { viewBackgroundColor: 'transparent' }, scrollToContent: true },
        excalidrawAPI: (ready: ExcalidrawImperativeAPI) => (api = ready),
        onChange: () => sendSoon(),
        theme: isDark() ? 'dark' : 'light',
        aiEnabled: false,
        validateEmbeddable: false,
        UIOptions: {
          canvasActions: { loadScene: false, saveToActiveFile: false, clearCanvas: false, toggleTheme: null, export: false },
          tools: { image: false },
        },
      }),
    )
  draw()

  // The app's theme, as it changes.
  const watch = new MutationObserver(draw)
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const device = window.matchMedia('(prefers-color-scheme: dark)')
  device.addEventListener('change', draw)

  return {
    take(list) {
      if (!api) return
      const fresh = list.filter((s) => known.get(s.id) !== stamp(s))
      if (!fresh.length) return
      const remote = restore(fresh)
      learn(remote)
      const local = api.getSceneElementsIncludingDeleted()
      const merged = reconcileElements(local, remote as never, api.getAppState())
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER })
    },
    unmount() {
      if (timer !== null) sendNow()
      watch.disconnect()
      device.removeEventListener('change', draw)
      api = null
      root.unmount()
    },
  }
}
