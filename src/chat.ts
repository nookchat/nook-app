const MAX_NAME_LENGTH = 24

export function cleanName(raw: string): string {
  return raw.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH)
}

export const EVERYONE = '*'

const EVERYONE_WORDS = ['everyone', 'here', 'all']
const PART_OF_ADDRESS = /[\w@.]/

export interface Mention {
  at: number
  /** Includes the @. */
  length: number
  key: string
  label: string
}

type KnownName = { key: string; name: string; lower: string }

const knownByNames = new WeakMap<Map<string, string>, KnownName[]>()

function knownNames(names: Map<string, string>): KnownName[] {
  let known = knownByNames.get(names)
  if (!known) {
    // Longest first, so "@Sam Two" is never read as "@Sam" plus the word "Two".
    known = [...names]
      .filter(([, name]) => name)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([key, name]) => ({ key, name, lower: name.toLowerCase() }))
    knownByNames.set(names, known)
  }
  return known
}

export function findMentions(text: string, names: Map<string, string>): Mention[] {
  if (!text.includes('@')) return []
  const known = knownNames(names)
  const lower = text.toLowerCase()
  const out: Mention[] = []

  for (let i = text.indexOf('@'); i !== -1; i = text.indexOf('@', i + 1)) {
    if (i > 0 && PART_OF_ADDRESS.test(text[i - 1])) continue

    let hit: Mention | null = null
    for (const word of EVERYONE_WORDS) {
      if (lower.startsWith(word, i + 1)) {
        hit = { at: i, length: word.length + 1, key: EVERYONE, label: word }
        break
      }
    }
    if (!hit) {
      for (const { key, name, lower: nameLower } of known) {
        if (!lower.startsWith(nameLower, i + 1)) continue
        hit = { at: i, length: name.length + 1, key, label: name }
        break
      }
    }
    if (!hit) continue
    out.push(hit)
    i += hit.length - 1
  }
  return out
}

export function mentionsMe(text: string, names: Map<string, string>, me: string): boolean {
  return findMentions(text, names).some((m) => m.key === me || m.key === EVERYONE)
}

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

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

export function sillyName(): string {
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`
}
