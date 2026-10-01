// tldraw, and React under it, for the whiteboards. Only this file brings them in, and only the
// first time a board opens: the rest of the app does without.
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createTLStore, defaultBindingUtils, defaultShapeUtils, Tldraw, type Editor, type TLRecord, type TLUiOverrides } from 'tldraw'
import 'tldraw/tldraw.css'
import { cleanWhiteboardEntry, type WhiteboardEntry } from '../store/log'

/** A pause in the drawing this long sends what changed. */
const SEND_AFTER_MS = 300

/** tldraw's fonts, icons and words, copied next to the app, so a board loads nothing from elsewhere. */
const ASSETS = getAssetUrls({ baseUrl: new URL('tldraw/', document.baseURI).href })

/** Tools and menu items that bring in a picture, a video, a bookmark or a web page. */
const OFF_TOOLS = ['asset', 'embed']
const OFF_ACTIONS = ['insert-media', 'insert-embed', 'replace-media']

const overrides: TLUiOverrides = {
  tools(_, tools) {
    for (const id of OFF_TOOLS) delete tools[id]
    return tools
  },
  actions(_, actions) {
    for (const id of OFF_ACTIONS) delete actions[id]
    return actions
  },
}

export interface Canvas {
  /** What the log has now: whatever differs from the copy on screen goes in. */
  take(entries: readonly WhiteboardEntry[]): void
  unmount(): void
}

function colourScheme(): 'dark' | 'light' {
  const chosen = document.documentElement.dataset.theme
  if (chosen === 'dark' || chosen === 'light') return chosen
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const sameAs = (entry: WhiteboardEntry): string => JSON.stringify(entry)

export function mountCanvas(host: HTMLElement, entries: readonly WhiteboardEntry[], send: (changed: WhiteboardEntry[]) => void): Canvas {
  const store = createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils })
  let editor: Editor | null = null
  /** Each record as the log has it, or as we sent it. */
  const known = new Map<string, string>()
  /** Records changed here and not sent yet. They win over what comes in meanwhile. */
  const pending = new Set<string>()

  /** Puts what the log has in the store, one record at a time, so a record tldraw rejects stops nothing else. */
  const apply = (list: readonly WhiteboardEntry[]): void => {
    store.mergeRemoteChanges(() => {
      for (const entry of list) {
        known.set(entry.id, sameAs(entry))
        try {
          if ('gone' in entry) {
            if (store.has(entry.id as TLRecord['id'])) store.remove([entry.id as TLRecord['id']])
          } else {
            store.put([entry as unknown as TLRecord])
          }
        } catch {
          /* from another version of tldraw, or not a record it knows: left out */
        }
      }
    })
  }
  apply(entries)

  let timer: number | null = null
  const sendSoon = (): void => {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(sendNow, SEND_AFTER_MS)
  }
  // A shape goes once it is let go, not at every step of a drag.
  const sendNow = (): void => {
    timer = null
    if (editor?.inputs.getIsDragging()) return sendSoon()
    const changed: WhiteboardEntry[] = []
    for (const id of pending) {
      const now = store.get(id as TLRecord['id'])
      const entry = now ? cleanWhiteboardEntry(now) : { id, gone: true as const }
      if (!entry) continue
      const text = sameAs(entry)
      if (known.get(id) === text) continue
      known.set(id, text)
      changed.push(entry)
    }
    pending.clear()
    if (changed.length) send(changed)
  }
  const stopListening = store.listen(
    ({ changes }) => {
      for (const id of Object.keys(changes.added)) pending.add(id)
      for (const id of Object.keys(changes.updated)) pending.add(id)
      for (const id of Object.keys(changes.removed)) pending.add(id)
      sendSoon()
    },
    { source: 'user', scope: 'document' },
  )

  const root = createRoot(host)
  const draw = (): void =>
    root.render(
      createElement(Tldraw, {
        store,
        licenseKey: import.meta.env.VITE_TLDRAW_LICENSE_KEY,
        assetUrls: ASSETS,
        overrides,
        colorScheme: colourScheme(),
        acceptedImageMimeTypes: [],
        acceptedVideoMimeTypes: [],
        onMount: (ready: Editor) => {
          editor = ready
          // A link pasted in goes on the board as words, not as a bookmark that fetches the page.
          ready.registerExternalContentHandler('url', ({ url, point }) => ready.putExternalContent({ type: 'text', text: url, point }))
          // Everything in view, but no closer than its own size.
          const drawn = ready.getCurrentPageBounds()
          if (drawn) ready.zoomToBounds(drawn, { targetZoom: 1, animation: { duration: 0 } })
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
      apply(list.filter((entry) => !pending.has(entry.id) && known.get(entry.id) !== sameAs(entry)))
    },
    unmount() {
      if (timer !== null) window.clearTimeout(timer)
      sendNow()
      stopListening()
      watch.disconnect()
      device.removeEventListener('change', draw)
      editor = null
      root.unmount()
    },
  }
}
