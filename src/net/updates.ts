import { h } from '../ui/dom'
import { icon } from '../ui/icons'

/** How often an open tab asks whether there is a new version. */
const CHECK_MS = 10 * 60 * 1000

/** How long a swap may take before the page reloads by itself. */
const SWAP_WAIT_MS = 8000

/**
 * A new version downloads in the background, as a new service worker. When it
 * has all of its files, this offers it; Update swaps to it and reloads.
 */
export function watchForUpdates(): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return
  let asked = false
  let offered: ServiceWorker | null = null

  // The first worker also takes over the page, so only a swap that was asked for reloads.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (asked) window.location.reload()
  })

  void navigator.serviceWorker.ready.then((reg) => {
    const offer = (worker: ServiceWorker): void => {
      // With no worker in charge, this is the first visit: nothing is old yet.
      if (!navigator.serviceWorker.controller) return
      // Later hid it: the next check shows it again, but not while it is up.
      if (offered === worker && document.querySelector('.update-pop')) return
      offered = worker
      showOffer(async () => {
        asked = true
        await swapToNewest(reg)
      })
    }

    if (reg.waiting) offer(reg.waiting)
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') offer(worker)
      })
    })
    const check = (): void => {
      if (reg.waiting) offer(reg.waiting)
      void reg.update().catch(() => undefined)
    }
    window.setInterval(check, CHECK_MS)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check()
    })
  })
}

/**
 * Update goes to the newest version there is, not the one that was ready when the offer came up:
 * it asks the server again, waits for anything newer to download, and swaps to that.
 */
async function swapToNewest(reg: ServiceWorkerRegistration): Promise<void> {
  await reg.update().catch(() => undefined)
  const coming = reg.installing
  if (coming) await settled(coming)
  const newest = reg.waiting
  // If nothing waits, another tab swapped already, and a reload picks the new version up.
  if (!newest) {
    window.location.reload()
    return
  }
  newest.postMessage({ type: 'nook-update' })
  // The swap reloads the page. Should the browser never say it swapped, reload anyway.
  window.setTimeout(() => window.location.reload(), SWAP_WAIT_MS)
}

/** Waits until a worker has its files, or has given up. */
function settled(worker: ServiceWorker): Promise<void> {
  return new Promise((done) => {
    const look = (): void => {
      if (worker.state !== 'installing') {
        worker.removeEventListener('statechange', look)
        done()
      }
    }
    worker.addEventListener('statechange', look)
    look()
  })
}

/** The popup that offers the new version. Later puts it away until the next check finds it again. */
function showOffer(update: () => Promise<void>): void {
  document.querySelector('.update-pop')?.remove()
  const now = h('button', { class: 'primary', text: 'Update now' })
  const pop = h('div', { class: 'update-pop', role: 'alertdialog', ariaLabel: 'A new version of Nook' }, [
    h('span', { class: 'update-icon' }, [icon('download', 20)]),
    h('div', { class: 'update-words' }, [
      h('strong', { text: 'A new version of Nook is ready' }),
      h('span', { class: 'tiny faint', text: 'It has downloaded. Update to reload into it, which takes a second.' }),
      h('div', { class: 'row update-actions' }, [
        now,
        h('button', { class: 'ghost', text: 'Later', on: { click: () => pop.remove() } }),
      ]),
    ]),
  ])
  now.addEventListener('click', () => {
    now.disabled = true
    now.textContent = 'Updating…'
    void update()
  })
  document.body.append(pop)
}
