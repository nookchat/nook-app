/**
 * Your game recordings, as the desktop app finds them: Steam's own, NVIDIA's, and any folder
 * of videos you point it at. A browser cannot read your folders, so on the web there are none.
 * The desktop app serves each recording at a nook-rec:// address the page can play and read.
 * A Steam recording is a folder of small pieces; the app serves it as one MP4 with its sound.
 */

export type FolderKind = 'steam' | 'nvidia' | 'videos' | 'folder'

export interface RecordingFolder {
  path: string
  label: string
  kind: FolderKind
  /** Found by the app, not added by you. */
  found: boolean
  exists: boolean
}

export type RecordingKind = 'steam-clip' | 'steam-background' | 'file'

export interface Recording {
  id: string
  kind: RecordingKind
  title: string
  game?: string
  appId?: number
  /** Where it came from, in a word: Steam, NVIDIA, OBS, or the folder's name. */
  source: string
  folder: string
  /** When it was made, by this device's clock. */
  at: number
  /** Seconds, when known. */
  duration: number | null
  size: number
  width?: number
  height?: number
  /** Steam is still writing it. */
  live?: boolean
  type: string
  url: string
  thumb?: string
  /** Steam's codec names, video first, as in 'avc1.640020,mp4a.40.2'. */
  codecs?: string
}

/** Where each piece of a Steam recording is, in its one MP4, for playing it a piece at a time. */
export interface RecordingIndex {
  codecs: string
  /** Where nought is, in the file's own time: a background recording starts part way in. */
  base: number
  duration: number
  init: { offset: number; size: number }
  fragments: { t: number; offset: number; size: number; key: boolean; video: boolean }[]
}

interface RecordingsShell {
  folders: () => Promise<RecordingFolder[]>
  addFolder: () => Promise<RecordingFolder[] | null>
  removeFolder: (path: string) => Promise<RecordingFolder[]>
  restoreFolders: () => Promise<RecordingFolder[]>
  list: () => Promise<Recording[]>
  index: (id: string) => Promise<RecordingIndex | null>
  show: (id: string) => void
}

function shell(): RecordingsShell | null {
  const found = (window as Window & { nookDesktop?: { recordings?: RecordingsShell } }).nookDesktop?.recordings
  return found && typeof found.list === 'function' ? found : null
}

/** The desktop app can find your recordings. */
export function seesRecordings(): boolean {
  return shell() !== null
}

export async function recordingFolders(): Promise<RecordingFolder[]> {
  return (await shell()?.folders().catch(() => null)) ?? []
}

/** Asks for a folder with the system's own picker. Null when it is cancelled. */
export async function addRecordingFolder(): Promise<RecordingFolder[] | null> {
  return (await shell()?.addFolder().catch(() => null)) ?? null
}

export async function removeRecordingFolder(path: string): Promise<RecordingFolder[]> {
  return (await shell()?.removeFolder(path).catch(() => null)) ?? []
}

/** Brings back the folders the app found and you took off. */
export async function restoreRecordingFolders(): Promise<RecordingFolder[]> {
  return (await shell()?.restoreFolders().catch(() => null)) ?? []
}

/** The list from the last look, kept on this device, so the dialog opens with it at once. */
const LIST_KEY = 'nook.recordings.v1'

export async function listRecordings(): Promise<Recording[]> {
  const found = await shell()?.list().catch(() => null)
  if (!found) return []
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(found))
  } catch {
    /* too big or blocked: the next look reads the folders again */
  }
  return found
}

/**
 * The list from the last look, or null. A recording keeps its id while it does not change,
 * so these still open; one that changed is replaced when the new look comes in.
 */
export function keptRecordings(): Recording[] | null {
  if (!shell()) return null
  try {
    const kept = JSON.parse(localStorage.getItem(LIST_KEY) ?? 'null') as unknown
    return Array.isArray(kept) ? (kept as Recording[]) : null
  } catch {
    return null
  }
}

export async function recordingIndex(id: string): Promise<RecordingIndex | null> {
  return (await shell()?.index(id).catch(() => null)) ?? null
}

/** Opens the folder that holds it, in Finder or Explorer. */
export function showRecording(id: string): void {
  shell()?.show(id)
}

/** A Steam recording, which plays a piece at a time; anything else plays as a plain video. */
export function isSteam(rec: Recording): boolean {
  return rec.kind !== 'file'
}

/** The name the game goes by, or the recording's own. */
export function recordingName(rec: Recording): string {
  return rec.game || rec.title
}
