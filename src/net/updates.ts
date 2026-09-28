import { h } from '../ui/dom'
import { icon } from '../ui/icons'

/** How often an open tab asks whether there is a new version. */
const CHECK_MS = 10 * 60 * 1000

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

  const offer = (worker: ServiceWorker): void => {
    // With no worker in charge, this is the first visit: nothing is old yet.
    if (!navigator.serviceWorker.controller) return
    // Later hid it: the next check shows it again, but not while it is up.
    if (offered === worker && document.querySelector('.update-pop')) return
    offered = worker
    showOffer(() => {
      asked = true
      worker.postMessage({ type: 'nook-update' })
    })
  }

  void navigator.serviceWorker.ready.then((reg) => {
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

/** The popup that offers the new version. Later puts it away until the next check finds it again. */
function showOffer(update: () => void): void {
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
    update()
  })
  document.body.append(pop)
}
