import { PREFS_CHANGED } from '../store/prefs'

/**
 * The song Spotify plays on this computer, as the desktop shell sees it: the way Discord shows
 * what you listen to, with no Spotify account. A browser cannot see other programs, so on the
 * web there is never one.
 */

const KEY = 'nook.listening.v1'
/** Sent when the song changes, or when showing it is turned on or off. */
export const LISTENING_CHANGED = 'nook:listening'

export interface Listening {
  title: string
  artist: string
  album?: string
  /** Spotify's id of the track, for its link. Windows does not give it. */
  track?: string
  /** The cover, on Spotify's own address. */
  art?: string
  /** Milliseconds. */
  duration?: number
  /** When the song would have started, by this device's clock, had it played straight through. */
  startedAt?: number
}

/** What goes out with your presence. `pos` is how far in, now, since clocks differ. */
export interface ListeningWire {
  t: string
  a: string
  al?: string
  id?: string
  art?: string
  dur?: number
  pos?: number
}

interface DesktopShell {
  watchSpotify?: (on: boolean) => void
  onListening?: (fn: (now: Record<string, unknown> | null) => void) => () => void
}

function shell(): DesktopShell | null {
  const found = (window as Window & { nookDesktop?: DesktopShell }).nookDesktop
  return found?.watchSpotify && found.onListening ? found : null
}

let now: Listening | null = null
let started = false

const text = (value: unknown, most: number): string =>
  typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, most) : ''
const ms = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 24 * 60 * 60 * 1000 ? Math.round(value) : undefined

/** A song somebody sent, made safe to show, or null. */
export function cleanListening(raw: unknown, receivedAt = Date.now()): Listening | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const title = text(w.t, 200)
  if (!title) return null
  const out: Listening = { title, artist: text(w.a, 200) }
  const album = text(w.al, 200)
  if (album) out.album = album
  if (typeof w.id === 'string' && /^[A-Za-z0-9]{22}$/.test(w.id)) out.track = w.id
  if (typeof w.art === 'string' && /^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/.test(w.art)) out.art = w.art
  const duration = ms(w.dur)
  if (duration) out.duration = duration
  const pos = ms(w.pos)
  if (pos !== undefined) out.startedAt = receivedAt - pos
  return out
}

export function listeningWire(song: Listening): ListeningWire {
  const out: ListeningWire = { t: song.title, a: song.artist }
  if (song.album) out.al = song.album
  if (song.track) out.id = song.track
  if (song.art) out.art = song.art
  if (song.duration) out.dur = song.duration
  if (song.startedAt !== undefined) out.pos = Math.max(0, Date.now() - song.startedAt)
  return out
}

/** Where the song is on Spotify: the track, or a search for it when there is no id. */
export function songLink(song: Listening): string {
  if (song.track) return `https://open.spotify.com/track/${song.track}`
  return `https://open.spotify.com/search/${encodeURIComponent(`${song.artist} ${song.title}`.trim())}`
}

/** How far in, and how long, when both are known. */
export function songProgress(song: Listening, at = Date.now()): { played: number; duration: number } | null {
  if (song.startedAt === undefined || !song.duration) return null
  return { played: Math.min(song.duration, Math.max(0, at - song.startedAt)), duration: song.duration }
}

/** The desktop app can see Spotify. */
export function seesSpotify(): boolean {
  return shell() !== null
}

export function showsListening(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function setShowsListening(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* for this visit only */
  }
  apply()
}

/** What others are told you listen to. Null when nothing plays, or you keep it to yourself. */
export function listeningNow(): Listening | null {
  return showsListening() ? now : null
}

function apply(): void {
  const on = showsListening()
  shell()?.watchSpotify?.(on)
  if (!on) now = null
  window.dispatchEvent(new Event(LISTENING_CHANGED))
}

export function watchListening(): void {
  const desktop = shell()
  if (started || !desktop) return
  started = true
  desktop.onListening?.((next) => {
    const at = typeof next?.at === 'number' ? next.at : Date.now()
    const song = next
      ? cleanListening({ t: next.title, a: next.artist, al: next.album, id: next.track, art: next.art, dur: next.duration, pos: next.position }, at)
      : null
    now = song && showsListening() ? song : null
    window.dispatchEvent(new Event(LISTENING_CHANGED))
  })
  window.addEventListener(PREFS_CHANGED, (ev) => {
    if (((ev as CustomEvent<string[]>).detail ?? []).includes(KEY)) apply()
  })
  apply()
}
