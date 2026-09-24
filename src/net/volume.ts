/**
 * How loud each person is, for you.
 *
 * One number and one mute per person, by their key, kept on this device: how
 * you hear somebody is yours to choose and nobody else's business, so it is
 * never said to anybody. Nothing here changes what they send; it is how
 * loudly their voice plays on this screen, the way every voice app does it.
 *
 * From silent to as loud as they arrive. Louder than that would mean playing
 * voices through the page's own audio, where the browser's echo cancelling
 * cannot hear them, and everybody else would hear themselves come back.
 */

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

/** From 0 to 1. Everybody starts at 1. */
export function volumeFor(key: string): number {
  const level = load().level[key]
  return typeof level === 'number' && level >= 0 && level <= 1 ? level : 1
}

export function mutedFor(key: string): boolean {
  return load().muted[key] === true
}

/** What their voice plays at here, mute and all. */
export function heardAt(key: string): number {
  return mutedFor(key) ? 0 : volumeFor(key)
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
