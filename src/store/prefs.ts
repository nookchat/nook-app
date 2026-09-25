/**
 * Preferences that follow you from device to device.
 *
 * They are kept on the device, where the page reads them, and a copy rides in
 * your record on each of your servers (see server-spaces.ts), sealed with a
 * key only your devices have. Each one carries when it was last changed, and
 * the newer wins, so changing a quick reaction on your phone changes it on
 * your laptop the next time it reads its record.
 *
 * Not everything goes. Your key does not: it is what opens the record. Nor do
 * the microphone and speaker you chose, which are this device's hardware, nor
 * whether this browser may show notifications, which only it can say.
 *
 * The lists of servers are joined rather than replaced: a server added on one
 * device appears on the others, and a server one of them knew is never lost
 * to a newer list from somewhere that did not.
 *
 * Your picture is kept only in the record, and in this page's memory while it
 * is open: it is yours, on your servers, not a file sitting in the browser.
 */

import { VOLUMES_CHANGED } from '../net/volume'
import { ROOMS_CHANGED } from './notes'

const SYNCED = [
  'cathode.name.v1',
  'cathode.avatar.v1',
  'cathode.quick.v1',
  'cathode.emoji.v1',
  'cathode.volume.v1',
  'cathode.sounds.v1',
  'cathode.rail.v1',
  'cathode.settings.v1',
  'cathode.servers.v1',
  'cathode.own.v1',
]
const JOINED = new Set(['cathode.servers.v1', 'cathode.own.v1'])
const STAMPS = 'cathode.prefs.stamps.v1'
/** Kept in memory and in the record, never in the browser's storage. */
const MEMORY = new Set(['cathode.avatar.v1'])
const memory = new Map<string, string | null>()

/** Said when another device's preferences arrive, with which ones changed. */
export const PREFS_CHANGED = 'cathode:prefs'

let told: (() => void) | null = null

/*
 * A picture from before it lived only in the record: moved into memory, once,
 * with the time it moved, so the record takes it on the next save.
 */
function migrate(): void {
  for (const key of MEMORY) {
    try {
      const held = localStorage.getItem(key)
      if (held === null) continue
      memory.set(key, held)
      localStorage.removeItem(key)
      const when = stamps()
      when[key] = Date.now()
      localStorage.setItem(STAMPS, JSON.stringify(when))
    } catch {
      /* nothing kept; nothing to move */
    }
  }
}
migrate()

/** A preference kept in memory: its value, or undefined when it is not known yet. */
export function memoryPref(key: string): string | null | undefined {
  return memory.has(key) ? memory.get(key) : undefined
}

/** Change one, here and, soon, in the record. */
export function setMemoryPref(key: string, value: string | null): void {
  memory.set(key, value)
  const when = stamps()
  when[key] = Date.now()
  try {
    localStorage.setItem(STAMPS, JSON.stringify(when))
  } catch {
    /* the time is lost; the value still goes */
  }
  told?.()
}

export interface Prefs {
  values: Record<string, string | null>
  stamps: Record<string, number>
}

function stamps(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(STAMPS) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** The preferences as this device has them, and when each last changed. */
export function localPrefs(): Prefs {
  const values: Record<string, string | null> = {}
  const when = stamps()
  for (const key of SYNCED) {
    if (MEMORY.has(key)) {
      // Not known yet is not the same as none: a record that has one keeps it.
      if (memory.has(key)) values[key] = memory.get(key) ?? null
      else delete when[key]
      continue
    }
    try {
      values[key] = localStorage.getItem(key)
    } catch {
      values[key] = null
    }
  }
  return { values, stamps: when }
}

let applying = false

function joined(ours: string | null, theirs: string | null): string {
  const list = (raw: string | null): string[] => {
    try {
      const value = JSON.parse(raw ?? '[]') as unknown
      return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  return JSON.stringify([...new Set([...list(ours), ...list(theirs)])])
}

/** Take whatever another device changed more recently than this one. Says whether anything changed. */
export function takePrefs(remote: unknown): boolean {
  if (!remote || typeof remote !== 'object') return false
  const { values, stamps: theirs } = remote as Partial<Prefs>
  if (!values || !theirs) return false
  const ours = stamps()
  let changed = false
  let volumes = false
  let servers = false
  const which: string[] = []
  applying = true
  try {
    for (const key of SYNCED) {
      const when = Number(theirs[key] ?? 0)
      const value = values[key]
      if (value !== null && typeof value !== 'string') continue
      if (MEMORY.has(key)) {
        if (!memory.has(key) || when > (ours[key] ?? 0)) {
          if (memory.get(key) !== value) which.push(key)
          memory.set(key, value)
          if (when > (ours[key] ?? 0)) ours[key] = when
          changed = true
        }
        continue
      }
      if (JOINED.has(key)) {
        // Joined, whichever is newer: nothing known is ever dropped.
        const next = joined(localStorage.getItem(key), value)
        if (next !== (localStorage.getItem(key) ?? '[]')) {
          localStorage.setItem(key, next)
          servers = changed = true
        }
        if (when > (ours[key] ?? 0)) ours[key] = when
        continue
      }
      if (!(when > (ours[key] ?? 0))) continue
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
      ours[key] = when
      changed = true
      which.push(key)
      if (key === 'cathode.volume.v1') volumes = true
    }
    localStorage.setItem(STAMPS, JSON.stringify(ours))
  } catch {
    /* nowhere to keep them; this device carries on as it was */
  } finally {
    applying = false
  }
  if (volumes) window.dispatchEvent(new Event(VOLUMES_CHANGED))
  if (which.length) window.dispatchEvent(new CustomEvent(PREFS_CHANGED, { detail: which }))
  // A server this device had not heard of may hold spaces it should start.
  if (servers) window.dispatchEvent(new Event(ROOMS_CHANGED))
  return changed
}

/**
 * Be told whenever a preference changes on this device, so the record can be
 * saved. Every write goes through localStorage, so that is where it is heard:
 * one place, rather than a call to remember in every file that keeps one.
 */
export function watchPrefs(onChange: () => void): void {
  told = onChange
  if (typeof Storage === 'undefined') return
  const synced = new Set(SYNCED)
  const mark = (key: string): void => {
    if (applying || !synced.has(key)) return
    const when = stamps()
    when[key] = Date.now()
    applying = true
    try {
      localStorage.setItem(STAMPS, JSON.stringify(when))
    } finally {
      applying = false
    }
    onChange()
  }
  const set = Storage.prototype.setItem
  const remove = Storage.prototype.removeItem
  Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
    const was = this.getItem(key)
    set.call(this, key, value)
    if (this === localStorage && was !== value) mark(key)
  }
  Storage.prototype.removeItem = function (this: Storage, key: string) {
    const was = this.getItem(key)
    remove.call(this, key)
    if (this === localStorage && was !== null) mark(key)
  }
}
