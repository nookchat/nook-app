import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { toBase64 } from '../bytes'

/**
 * The Android app around the page (android/, NookPhonePlugin.java), as the desktop app's preload is
 * for a computer. It says whether you look at the app, shows notifications, keeps a call going with
 * the app put away, saves files to Downloads, and paints the system bars as the page. Null in a
 * browser, and in an app too old to have it.
 */

type Permission = 'granted' | 'denied' | 'prompt'

interface NookPhone {
  state(): Promise<{ looking: boolean; notify: Permission }>
  askNotify(): Promise<{ notify: Permission }>
  show(note: { id: string; title: string; body: string; picture: string; image: string }): Promise<void>
  voice(now: { on: boolean; title?: string; text?: string; muted?: boolean }): Promise<void>
  saveStart(file: { name: string; type: string }): Promise<{ id: string }>
  saveChunk(part: { id: string; data: string }): Promise<void>
  saveEnd(end: { id: string; cancel?: boolean }): Promise<void>
  bars(paint: { color: string }): Promise<void>
  addListener(event: 'looking', fn: (ev: { looking: boolean }) => void): Promise<PluginListenerHandle>
  addListener(event: 'notifyClick', fn: (ev: { id: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'voiceAction', fn: (ev: { action: 'mute' | 'leave' }) => void): Promise<PluginListenerHandle>
}

export interface PhoneShell {
  looking(): boolean
  onLooking(fn: (looking: boolean) => void): () => void
  notify(note: { id: string; title: string; body: string; picture: string; image: string }): void
  onNotifyClick(fn: (id: string) => void): () => void
  /** Whether the app may notify. 'prompt' until it has asked. */
  notifyPermission(): Permission
  askNotify(): Promise<Permission>
  /** Said once the app has told the page what it may do. */
  readonly ready: Promise<void>
  /** In voice, with the words for its notification, or null when out of voice. */
  voice(now: { title: string; text: string; muted: boolean } | null): void
  onVoiceAction(fn: (action: 'mute' | 'leave') => void): () => void
  save(blob: Blob, name: string): Promise<void>
}

/** A part of a file crosses to the app as base64, so a big video never sits in memory twice. */
const SAVE_PART = 1024 * 1024

function listen<T>(plugin: NookPhone, event: 'looking' | 'notifyClick' | 'voiceAction', fn: (ev: T) => void): () => void {
  const handle = (plugin.addListener as (e: string, f: (ev: T) => void) => Promise<PluginListenerHandle>)(event, fn)
  return () => void handle.then((h) => h.remove())
}

/**
 * The status bar and the navigation bar take the colour of the page behind everything, which
 * theme.ts puts in the theme-color meta, with icons that can be read on it.
 */
function paintBars(plugin: NookPhone): void {
  const bar = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!bar) return
  const paint = (): void => {
    const color = bar.content.trim()
    if (/^#[0-9a-f]{6}$/i.test(color)) void plugin.bars({ color }).catch(() => undefined)
  }
  paint()
  new MutationObserver(paint).observe(bar, { attributes: true, attributeFilter: ['content'] })
}

function make(plugin: NookPhone): PhoneShell {
  let looking = true
  let permission: Permission = 'prompt'
  const lookers = new Set<(looking: boolean) => void>()
  listen<{ looking: boolean }>(plugin, 'looking', (ev) => {
    if (ev.looking === looking) return
    looking = ev.looking
    for (const fn of lookers) fn(looking)
  })
  const ready = plugin
    .state()
    .then((now) => {
      permission = now.notify
      if (now.looking !== looking) {
        looking = now.looking
        for (const fn of lookers) fn(looking)
      }
    })
    .catch(() => undefined)
  // Back in the app, the permission may have changed in Android's settings.
  lookers.add((now) => {
    if (now) void plugin.state().then((s) => (permission = s.notify)).catch(() => undefined)
  })
  paintBars(plugin)

  return {
    looking: () => looking,
    onLooking: (fn) => {
      lookers.add(fn)
      return () => lookers.delete(fn)
    },
    notify: (note) => void plugin.show(note).catch(() => undefined),
    onNotifyClick: (fn) => listen<{ id: string }>(plugin, 'notifyClick', (ev) => fn(String(ev.id))),
    notifyPermission: () => permission,
    askNotify: async () => {
      try {
        permission = (await plugin.askNotify()).notify
      } catch {
        /* the app could not ask */
      }
      return permission
    },
    ready,
    voice: (now) => void plugin.voice(now ? { on: true, ...now } : { on: false }).catch(() => undefined),
    onVoiceAction: (fn) => listen<{ action: 'mute' | 'leave' }>(plugin, 'voiceAction', (ev) => fn(ev.action)),
    save: async (blob, name) => {
      const { id } = await plugin.saveStart({ name, type: blob.type || 'application/octet-stream' })
      try {
        for (let at = 0; at < blob.size; at += SAVE_PART) {
          const part = new Uint8Array(await blob.slice(at, at + SAVE_PART).arrayBuffer())
          await plugin.saveChunk({ id, data: toBase64(part) })
        }
      } catch (err) {
        await plugin.saveEnd({ id, cancel: true }).catch(() => undefined)
        throw err
      }
      await plugin.saveEnd({ id })
    },
  }
}

export const phoneShell: PhoneShell | null =
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NookPhone')
    ? make(registerPlugin<NookPhone>('NookPhone'))
    : null
