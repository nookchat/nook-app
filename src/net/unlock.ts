/**
 * A browser plays sound only after the page has had a click or a key. Voice
 * joined again after the reload of an update has had neither, so the browser
 * can hold its sound back: what you hear, and the chain your microphone goes
 * through. Everything held waits here, and the first click or key anywhere
 * starts it all.
 */

/** Sent once when something is held back, so the page can ask for a click. */
export const SOUND_HELD = 'nook:sound-held'

const held = new Set<AudioContext | HTMLMediaElement>()
let listening = false

function release(): void {
  for (const thing of held) {
    if (thing instanceof HTMLMediaElement) void thing.play().catch(() => undefined)
    else void thing.resume().catch(() => undefined)
  }
  held.clear()
  window.removeEventListener('pointerdown', release, true)
  window.removeEventListener('keydown', release, true)
  listening = false
}

function hold(thing: AudioContext | HTMLMediaElement): void {
  held.add(thing)
  if (listening) return
  listening = true
  window.addEventListener('pointerdown', release, true)
  window.addEventListener('keydown', release, true)
  window.dispatchEvent(new Event(SOUND_HELD))
}

/** An audio context that may have started suspended. */
export function watchContext(ctx: AudioContext): AudioContext {
  // Safari says interrupted, not suspended.
  const stopped = (): boolean => (ctx.state as string) !== 'running' && ctx.state !== 'closed'
  if (stopped()) {
    void ctx.resume().catch(() => undefined)
    // A resume the browser allows is quick. One still waiting needs a click.
    window.setTimeout(() => {
      if (stopped()) hold(ctx)
    }, 300)
  }
  return ctx
}

/** Plays it, or waits for the click the browser wants first. */
export function playOrHold(el: HTMLMediaElement): void {
  void el.play().catch((err: unknown) => {
    if (err instanceof Error && err.name === 'NotAllowedError') hold(el)
  })
}
