/**
 * While a file is made smaller or sent, the screen stays on and the page asks before it closes: a
 * phone that locks, or a window that shuts, stops the work, and the message waiting for it is lost.
 */
let jobs = 0
let lock: WakeLockSentinel | null = null

async function hold(): Promise<void> {
  if (!jobs || lock || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return
  try {
    const got = await navigator.wakeLock.request('screen')
    got.addEventListener('release', () => {
      if (lock === got) lock = null
    })
    lock = got
    if (!jobs) release()
  } catch {
    /* Not allowed now: low battery, or the page out of view. */
  }
}

function release(): void {
  const was = lock
  lock = null
  void was?.release().catch(() => undefined)
}

// The browser lets go of the lock when the page is put away: back in view, it is taken again.
document.addEventListener('visibilitychange', () => void hold())

/** Keeps the screen on until `work` ends, however it ends. */
export function keepAwakeWhile(work: Promise<unknown>): void {
  jobs++
  void hold()
  const done = (): void => {
    jobs--
    if (!jobs) release()
  }
  void work.then(done, done)
}

/** Whether a file is still being made smaller or sent. */
export function working(): boolean {
  return jobs > 0
}
