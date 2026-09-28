import names from 'virtual:twemoji'

/**
 * Draws every emoji on the page as its Twemoji picture, so it looks the same on
 * every device. The emoji stays in the page as text under the picture: copy,
 * find and textContent still see it, and it shows until the picture arrives.
 */

const ART = new Set(names.split(','))
const BASE = `${import.meta.env.BASE_URL}emoji/`
/** A cheap first look: text without any of these has no emoji. */
const MAYBE = /[\u00a9\u00ae\u203c\u2049\u20e3\u2122-\u2b55\u3030\u303d\u3297\u3299\ud83c-\ud83e]/
/** Drawn as a picture. A symbol such as © or ↔ stays text unless it asks for the emoji look. */
const EMOJI = /^(?:[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)/u
/** Typed text and code keep the device's own emoji. */
const SKIP = 'input, textarea, script, style, code, pre, .twemoji'
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
/** Pictures that have loaded once, so the next copy shows at once. */
const drawn = new Set<string>()

function artFor(ch: string): string | null {
  const points = [...ch].map((c) => c.codePointAt(0)!.toString(16))
  const full = points.join('-')
  if (ART.has(full)) return full
  const bare = points.filter((p) => p !== 'fe0f').join('-')
  return ART.has(bare) ? bare : null
}

function emojiSpan(ch: string, name: string): HTMLElement {
  const span = document.createElement('span')
  span.className = drawn.has(name) ? 'twemoji drawn' : 'twemoji'
  span.textContent = ch
  const art = document.createElement('img')
  art.alt = ''
  art.draggable = false
  art.loading = 'lazy'
  art.decoding = 'async'
  art.setAttribute('aria-hidden', 'true')
  art.addEventListener('load', () => {
    drawn.add(name)
    span.classList.add('drawn')
  })
  art.addEventListener('error', () => art.remove())
  art.src = `${BASE}${name}.svg`
  span.append(art)
  return span
}

function skipped(el: Element | null): boolean {
  return !el || !!el.closest(SKIP) || (el instanceof HTMLElement && el.isContentEditable)
}

function paintText(node: Text): void {
  const text = node.data
  let out: Node[] | null = null
  let plain = ''
  for (const { segment } of GRAPHEMES.segment(text)) {
    const name = EMOJI.test(segment) ? artFor(segment) : null
    if (!name) {
      plain += segment
      continue
    }
    out ??= []
    if (plain) out.push(document.createTextNode(plain))
    plain = ''
    out.push(emojiSpan(segment, name))
  }
  if (!out) return
  if (plain) out.push(document.createTextNode(plain))
  node.replaceWith(...out)
}

function paint(root: Node): void {
  if (root instanceof Text) {
    if (MAYBE.test(root.data) && !skipped(root.parentElement)) paintText(root)
    return
  }
  if (!(root instanceof Element) || skipped(root)) return
  const found: Text[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const text = node as Text
    if (MAYBE.test(text.data) && !skipped(text.parentElement)) found.push(text)
  }
  for (const text of found) paintText(text)
}

let watching = false

export function drawEmojiAsArt(): void {
  if (watching) return
  watching = true
  paint(document.body)
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') paint(record.target)
      else for (const node of record.addedNodes) paint(node)
    }
  }).observe(document.body, { childList: true, characterData: true, subtree: true })
}
