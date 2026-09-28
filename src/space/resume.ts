/**
 * Keeps you in your voice channel across the reload of a web update. Before the
 * reload the page notes where you were, for this tab only. After it, the space
 * joins that channel again, muted or deafened as you were, with no sound, and
 * the others are told you are updating, so they wait for you.
 */

const VOICE_KEY = 'nook.resume.voice.v1'
const SHARE_KEY = 'nook.resume.share.v1'
/** A note older than this is from some other visit, not a reload. */
const FRESH_MS = 60_000
/** How long the others wait for somebody who said they are updating. */
export const BACK_WITHIN_MS = 30_000

export interface VoiceNote {
  room: string
  channel: string
  muted: boolean
  deafened: boolean
}

let updating = false

/** This page is about to reload into a new version. */
export function updatingNow(): boolean {
  return updating
}

/** Called just before the reload. `sharingIn` is the room whose screen this page shares, if any. */
export function noteForUpdate(voice: VoiceNote | null, sharingIn: string | null): void {
  updating = true
  const at = Date.now()
  try {
    if (voice) sessionStorage.setItem(VOICE_KEY, JSON.stringify({ ...voice, at }))
    if (sharingIn) sessionStorage.setItem(SHARE_KEY, JSON.stringify({ room: sharingIn, at }))
  } catch {
    /* storage blocked: the reload leaves the channel, as before */
  }
}

/** The note for this room, once: it is gone after it is read. */
function take(key: string, room: string): Record<string, unknown> | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const note = JSON.parse(raw) as Record<string, unknown>
    if (note.room !== room) return null
    sessionStorage.removeItem(key)
    return typeof note.at === 'number' && Date.now() - note.at < FRESH_MS ? note : null
  } catch {
    return null
  }
}

export function takeVoiceNote(room: string): VoiceNote | null {
  const note = take(VOICE_KEY, room)
  if (!note || typeof note.channel !== 'string' || !note.channel) return null
  return { room, channel: note.channel, muted: note.muted === true, deafened: note.deafened === true }
}

/** This page shared its screen in this room before the update. */
export function takeShareNote(room: string): boolean {
  return take(SHARE_KEY, room) !== null
}
