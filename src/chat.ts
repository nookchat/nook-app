/**
 * Names, and the silly ones people get before they pick their own.
 *
 * The log itself lives in src/store. This file is only about what people are
 * called.
 */

const MAX_NAME = 24

/** Trim a name to something that fits a chat line and holds no surprises. */
export function cleanName(raw: string): string {
  return raw.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/** The key a mention of the whole room carries, which belongs to nobody. */
export const EVERYONE = '*'

export interface Mention {
  /** Where the @ is. */
  at: number
  /** How much of the text the mention takes up, @ included. */
  length: number
  /** Whose key it names, or EVERYONE. */
  key: string
  /** What it says, without the @. */
  label: string
}

/**
 * Find the mentions in a line.
 *
 * A name is a label rather than a handle here, so it can hold spaces, and
 * "@Crispy Toaster" has to match while "@Crispy" alone does not become a
 * different person. The longest name that fits wins, which is the only rule
 * that gets "@Sam" and "@Sam Two" both right when both are in the room.
 *
 * An @ followed by nothing anybody is called stays plain text. Discord does the
 * same, and the alternative is every email address in the room lighting up.
 */
export function findMentions(text: string, names: Map<string, string>): Mention[] {
  // Longest first, so "@Sam Two" is never read as "@Sam" plus the word "Two".
  const known = [...names]
    .filter(([, name]) => name)
    .sort((a, b) => b[1].length - a[1].length)
  const lower = text.toLowerCase()
  const out: Mention[] = []

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue
    // An @ in the middle of a word is an email address, not a mention.
    if (i > 0 && /[\w@.]/.test(text[i - 1])) continue

    let hit: Mention | null = null
    for (const word of ['everyone', 'here', 'all']) {
      if (lower.startsWith(word, i + 1)) {
        hit = { at: i, length: word.length + 1, key: EVERYONE, label: word }
        break
      }
    }
    if (!hit) {
      for (const [key, name] of known) {
        if (!lower.startsWith(name.toLowerCase(), i + 1)) continue
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

/** Whose attention a line is asking for. */
export function mentionedKeys(text: string, names: Map<string, string>): Set<string> {
  return new Set(findMentions(text, names).map((m) => m.key))
}

/** True when this line is addressed to this person, by name or by the lot of them. */
export function mentionsMe(text: string, names: Map<string, string>, me: string): boolean {
  const keys = mentionedKeys(text, names)
  return keys.has(me) || keys.has(EVERYONE)
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
