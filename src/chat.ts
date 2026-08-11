/**
 * The chat room.
 *
 * Chat rides the same peer connection as the picture, on a data channel, so it
 * is as direct and as private as the video: encrypted by DTLS, and never seen by
 * a server. The host is the hub. Viewers connect only to the host, so the host
 * repeats each line to everybody else.
 *
 * A message is stamped with the clock of whoever displays it, never the clock of
 * whoever sent it. Two machines rarely agree on the time, and a chat log that
 * jumps backwards because someone's laptop is fast is a poor way to learn that.
 */

const NAME_KEY = 'cathode.name.v1'

export type ChatKind = 'said' | 'joined' | 'left'

/** What travels over the data channel. */
export interface ChatWire {
  v: 1
  id: string
  kind: ChatKind
  name: string
  text?: string
}

/** What the panel draws. */
export interface ChatLine {
  id: string
  kind: ChatKind
  name: string
  text: string
  at: number
  mine: boolean
}

const MAX_NAME = 24
const MAX_TEXT = 500

export function newMessageId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

/** Trim a name to something that fits a chat line and holds no surprises. */
export function cleanName(raw: string): string {
  return raw.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
}

export function cleanText(raw: string): string {
  return raw.replace(/[\r\n]/g, ' ').trim().slice(0, MAX_TEXT)
}

/**
 * Read a wire message without trusting a single byte of it. Anyone on the room
 * can put anything on the channel, so shape, type and length are all checked
 * here rather than at the point where it gets drawn.
 */
export function parseWire(raw: unknown): ChatWire | null {
  if (typeof raw !== 'string' || raw.length > 4000) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const m = value as Partial<ChatWire>
  if (!m || m.v !== 1) return null
  if (typeof m.id !== 'string' || m.id.length > 32) return null
  if (m.kind !== 'said' && m.kind !== 'joined' && m.kind !== 'left') return null
  if (typeof m.name !== 'string') return null
  const name = cleanName(m.name)
  if (!name) return null
  const text = m.kind === 'said' ? cleanText(typeof m.text === 'string' ? m.text : '') : ''
  if (m.kind === 'said' && !text) return null
  return { v: 1, id: m.id, kind: m.kind, name, text }
}

export function toLine(wire: ChatWire, mine: boolean): ChatLine {
  return {
    id: wire.id,
    kind: wire.kind,
    name: wire.name,
    text: wire.text ?? '',
    at: Date.now(),
    mine,
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Names for anybody who cannot be bothered to pick one, drawn from the era the
 * interface is dressed in.
 */
const ADJECTIVES = [
  'Anonymous', 'Beige', 'Caffeinated', 'Chunky', 'Curious', 'Dial-up', 'Dusty',
  'Restless', 'Rogue', 'Sleepy', 'Static', 'Suspicious', 'Turbo', 'Unplugged',
  'Wireless', 'Analogue', 'Crispy', 'Humble', 'Nocturnal', 'Spare', 'Loud',
  'Silent', 'Overclocked', 'Defragmented', 'Buffering',
]

const NOUNS = [
  'Modem', 'Monitor', 'Floppy', 'Pixel', 'Cursor', 'Toaster', 'Trackball',
  'Screensaver', 'Mousepad', 'Zip Disk', 'Minesweeper', 'Solitaire', 'Dial Tone',
  'Scanline', 'Phosphor', 'Lurker', 'Gremlin', 'Visitor', 'Tube', 'Sysadmin',
  'Paperclip', 'Hourglass', 'Taskbar', 'Cartridge', 'Joystick',
]

export function sillyName(): string {
  const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)]
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`
}

/** The name this browser last used, or a fresh silly one that is then kept. */
export function loadName(): string {
  try {
    const saved = cleanName(localStorage.getItem(NAME_KEY) ?? '')
    if (saved) return saved
  } catch {
    // Private mode. A generated name still works, it just will not be kept.
  }
  const fresh = sillyName()
  saveName(fresh)
  return fresh
}

export function saveName(name: string): void {
  const clean = cleanName(name)
  if (!clean) return
  try {
    localStorage.setItem(NAME_KEY, clean)
  } catch {
    // Nothing to do. The name lasts for this session only.
  }
}
