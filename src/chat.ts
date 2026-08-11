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
