/**
 * The loading screen in index.html: the ghost, the wordmark, a bar and a line of words.
 * The start moves the bar through its real steps and takes the screen away when the first
 * screen has what it needs. An update brings the same screen back before its reload, so the
 * reload goes from one loading screen to the other with no flash.
 */

const UPDATING_KEY = 'nook.updating.v1'
/** However the start goes, the screen is gone by then. */
const MOST_MS = 12_000
const FADE_MS = 280
/** A start quicker than this still lets the ghost finish coming in, so it never flickers. */
const LEAST_MS = 700

const first = document.getElementById('boot')
/** A copy, for an update to show again once the first one has gone. */
const template = first?.cloneNode(true) as HTMLElement | undefined
let screen: HTMLElement | null = first
let reached = 0
let saying = ''

function readUpdating(): boolean {
  try {
    const at = Number(sessionStorage.getItem(UPDATING_KEY) || localStorage.getItem(UPDATING_KEY))
    return !!at && Date.now() - at < 120_000
  } catch {
    return false
  }
}

/** A reload into an update keeps saying so, whatever the steps are. */
const updating = readUpdating()

function say(words: string): void {
  const line = screen?.querySelector<HTMLElement>('.boot-say')
  if (!line || words === saying) return
  saying = words
  line.classList.add('swap')
  window.setTimeout(() => {
    line.textContent = words
    line.classList.remove('swap')
  }, 180)
}

/** The bar to `percent`, never back, and what is happening now. */
export function bootStep(percent: number, words?: string): void {
  if (!screen) return
  reached = Math.max(reached, Math.min(100, percent))
  const fill = screen.querySelector<HTMLElement>('.boot-fill')
  if (fill) {
    fill.classList.remove('creep')
    fill.style.width = `${reached}%`
  }
  if (words && !updating) say(words)
}

/** Full, then gone. */
export function bootDone(): void {
  const going = screen
  if (!going) return
  screen = null
  try {
    sessionStorage.removeItem(UPDATING_KEY)
    localStorage.removeItem(UPDATING_KEY)
  } catch {
    /* storage blocked */
  }
  const fill = going.querySelector<HTMLElement>('.boot-fill')
  if (fill) {
    fill.classList.remove('creep')
    fill.style.width = '100%'
  }
  window.setTimeout(() => {
    going.classList.add('gone')
    window.setTimeout(() => going.remove(), FADE_MS)
  }, Math.max(220, LEAST_MS - performance.now()))
}

/**
 * The loading screen again, for an update about to reload or restart. The bar creeps on
 * while it waits; the reload lands on the same screen in the new version.
 */
export function showBoot(words: string, restart = false): void {
  try {
    ;(restart ? localStorage : sessionStorage).setItem(UPDATING_KEY, String(Date.now()))
  } catch {
    /* storage blocked: the new version says Loading */
  }
  if (!template || document.getElementById('boot')) return
  const again = template.cloneNode(true) as HTMLElement
  again.querySelector('.boot-say')!.textContent = words
  document.body.append(again)
  screen = again
  saying = words
  reached = 0
  for (const [at, percent] of [[60, 35], [700, 60], [2000, 80]]) window.setTimeout(() => bootStep(percent), at)
}

if (first) window.setTimeout(bootDone, MOST_MS)
