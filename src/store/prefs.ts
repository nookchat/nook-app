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
const MERGED_LISTS = new Set(['cathode.servers.v1', 'cathode.own.v1'])
const STAMPS = 'cathode.prefs.stamps.v1'
const MEMORY_ONLY = new Set(['cathode.avatar.v1'])
const memory = new Map<string, string | null>()
const memoryStamps = new Map<string, number>()

export const PREFS_CHANGED = 'cathode:prefs'

let told: (() => void) | null = null
let applying = false

function moveMemoryOnlyOutOfStorage(): void {
  for (const key of MEMORY_ONLY) {
    try {
      const held = localStorage.getItem(key)
      if (held === null) continue
      memory.set(key, held)
      localStorage.removeItem(key)
      const when = stamps()
      when[key] = Date.now()
      memoryStamps.set(key, when[key])
      localStorage.setItem(STAMPS, JSON.stringify(when))
    } catch {}
  }
}
moveMemoryOnlyOutOfStorage()

/** Undefined when not known yet. */
export function memoryPref(key: string): string | null | undefined {
  return memory.has(key) ? memory.get(key) : undefined
}

export function memoryPrefStamp(key: string): number {
  return memoryStamps.get(key) ?? 0
}

export function setMemoryPref(key: string, value: string | null, at = Date.now()): void {
  memory.set(key, value)
  memoryStamps.set(key, at)
  const when = stamps()
  when[key] = at
  try {
    localStorage.setItem(STAMPS, JSON.stringify(when))
  } catch {}
  told?.()
}

export function adoptMemoryPref(key: string, value: string | null, at: number): void {
  if (at <= memoryPrefStamp(key)) return
  const changed = memory.get(key) !== value
  setMemoryPref(key, value, at)
  if (changed) window.dispatchEvent(new CustomEvent(PREFS_CHANGED, { detail: [key] }))
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

export function localPrefs(): Prefs {
  const values: Record<string, string | null> = {}
  const when = stamps()
  for (const key of SYNCED) {
    if (MEMORY_ONLY.has(key)) {
      if (memory.has(key)) {
        values[key] = memory.get(key) ?? null
        when[key] = memoryStamps.get(key) ?? when[key]
      } else delete when[key]
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

function mergedList(ours: string | null, theirs: string | null): string {
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
      if (MEMORY_ONLY.has(key)) {
        if (!memory.has(key) || when > (memoryStamps.get(key) ?? 0)) {
          if (memory.get(key) !== value) which.push(key)
          memory.set(key, value)
          memoryStamps.set(key, when)
          if (when > (ours[key] ?? 0)) ours[key] = when
          changed = true
        }
        continue
      }
      if (MERGED_LISTS.has(key)) {
        const held = localStorage.getItem(key)
        const next = mergedList(held, value)
        if (next !== (held ?? '[]')) {
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
  } catch {} finally {
    applying = false
  }
  if (volumes) window.dispatchEvent(new Event(VOLUMES_CHANGED))
  if (which.length) window.dispatchEvent(new CustomEvent(PREFS_CHANGED, { detail: which }))
  if (servers) window.dispatchEvent(new Event(ROOMS_CHANGED))
  return changed
}

export function watchPrefs(onChange: () => void): void {
  told = onChange
  if (typeof Storage === 'undefined') return
  const synced = new Set(SYNCED)
  const watched = (store: Storage, key: string): boolean => store === localStorage && !applying && synced.has(key)
  const mark = (key: string): void => {
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
    if (!watched(this, key)) return set.call(this, key, value)
    const was = this.getItem(key)
    set.call(this, key, value)
    if (was !== value) mark(key)
  }
  Storage.prototype.removeItem = function (this: Storage, key: string) {
    if (!watched(this, key)) return remove.call(this, key)
    const was = this.getItem(key)
    remove.call(this, key)
    if (was !== null) mark(key)
  }
}
