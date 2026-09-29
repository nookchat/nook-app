/**
 * Spaces and text channels you muted, for yourself only: no notification, no toast
 * and no count on the icon from them. Direct messages are never muted by this.
 * Kept with your other settings, so your devices share it.
 */

const KEY = 'nook.muted.v1'
export const MUTED_CHANGED = 'nook:muted'

interface Muted {
  spaces: string[]
  channels: Record<string, string[]>
}

function load(): Muted {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Muted>
    return {
      spaces: Array.isArray(raw.spaces) ? raw.spaces.filter((s) => typeof s === 'string') : [],
      channels: raw.channels && typeof raw.channels === 'object' ? raw.channels : {},
    }
  } catch {
    return { spaces: [], channels: {} }
  }
}

function save(muted: Muted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(muted))
  } catch {
    /* storage blocked: it lasts until the page goes */
  }
  window.dispatchEvent(new Event(MUTED_CHANGED))
}

export function spaceMuted(room: string): boolean {
  return load().spaces.includes(room)
}

export function channelMuted(room: string, channel: string): boolean {
  const muted = load()
  return muted.spaces.includes(room) || (muted.channels[room] ?? []).includes(channel)
}

/** Only the channel's own mute, not the space's. */
export function channelMutedItself(room: string, channel: string): boolean {
  return (load().channels[room] ?? []).includes(channel)
}

export function muteSpace(room: string, on: boolean): void {
  const muted = load()
  muted.spaces = muted.spaces.filter((s) => s !== room)
  if (on) muted.spaces.push(room)
  save(muted)
}

export function muteChannel(room: string, channel: string, on: boolean): void {
  const muted = load()
  const list = (muted.channels[room] ?? []).filter((c) => c !== channel)
  if (on) list.push(channel)
  if (list.length) muted.channels[room] = list
  else delete muted.channels[room]
  save(muted)
}
