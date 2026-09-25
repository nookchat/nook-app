const KEY = 'cathode.volume.v1'
export const VOLUMES_CHANGED = 'cathode:volumes'

interface Saved {
  level: Record<string, number>
  muted: Record<string, boolean>
}

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>
    return { level: raw.level ?? {}, muted: raw.muted ?? {} }
  } catch {
    return { level: {}, muted: {} }
  }
}

function save(next: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* for this visit only */
  }
  window.dispatchEvent(new Event(VOLUMES_CHANGED))
}

function levelIn(saved: Saved, key: string): number {
  const level = saved.level[key]
  return typeof level === 'number' && level >= 0 && level <= 1 ? level : 1
}

export function volumeFor(key: string): number {
  return levelIn(load(), key)
}

export function mutedFor(key: string): boolean {
  return load().muted[key] === true
}

export function heardAt(key: string): number {
  const saved = load()
  return saved.muted[key] === true ? 0 : levelIn(saved, key)
}

export function setVolumeFor(key: string, level: number): void {
  const saved = load()
  saved.level[key] = Math.min(1, Math.max(0, level))
  save(saved)
}

export function setMutedFor(key: string, muted: boolean): void {
  const saved = load()
  if (muted) saved.muted[key] = true
  else delete saved.muted[key]
  save(saved)
}
