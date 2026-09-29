import { showBoot } from '../ui/boot'
import { h } from '../ui/dom'
import { icon } from '../ui/icons'

/** How often an open tab asks whether there is a new version. */
const CHECK_MS = 10 * 60 * 1000

/** How long a swap may take before the page reloads by itself. */
const SWAP_WAIT_MS = 8000
/** How often a wait for the end of a call looks again. */
const CALL_LOOK_MS = 2000

export interface UpdateHooks {
  /** In a voice channel or a call now. */
  inCall: () => boolean
  /** Nothing a reload would lose: no call, no share, nothing half written. */
  idle: () => boolean
  /** Just before the reload: notes the call, so the new version joins it again. `restart` is the desktop app's. */
  beforeReload: (restart?: boolean) => Promise<void>
}

let hooks: UpdateHooks = { inCall: () => false, idle: () => false, beforeReload: async () => undefined }
/** Offers a worker that has its files. Set once the service worker is ready. */
let offerWorker: ((worker: ServiceWorker) => void) | null = null
/**
 * In the desktop app, a newer desktop app goes first: its offer stands in for the web
 * one, and taking it takes the new web version too, so there is one restart, not two.
 */
let desktopFirst: (() => void) | null = null
/** A new web version that has all its files, and the Update that reloads into it. */
let webWaiting: { worker: ServiceWorker; update: () => Promise<void> } | null = null
/** How long a quiet swap waits for the new worker to take charge, before the restart. */
const QUIET_SWAP_MS = 3000

/**
 * A new version downloads in the background, as a new service worker. When it
 * has all of its files, this offers it; Update swaps to it and reloads.
 */
export function watchForUpdates(given: UpdateHooks): void {
  hooks = given
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return
  let asked = false
  let offered: ServiceWorker | null = null
  /** Update when I leave the call was pressed: no more offers, the update is on its way. */
  let waiting = false

  // The first worker also takes over the page, so only a swap that was asked for reloads.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (asked) window.location.reload()
  })

  void navigator.serviceWorker.ready.then((reg) => {
    const offer = (worker: ServiceWorker): void => {
      // With no worker in charge, this is the first visit: nothing is old yet.
      if (!navigator.serviceWorker.controller) return
      // Later hid it: the next check shows it again, but not while it is up.
      if (waiting || (offered === worker && document.querySelector('.update-pop'))) return
      offered = worker
      const update = async (): Promise<void> => {
        asked = true
        // The loading screen from here on, so the reload goes from one to the other with no flash.
        document.querySelector('.update-pop')?.remove()
        showBoot('Updating Nook')
        await swapToNewest(reg)
      }
      webWaiting = { worker, update }
      if (desktopFirst) {
        // Said again, so its words say the new web version comes with it.
        if (!document.querySelector('.update-pop button:disabled')) desktopFirst()
        return
      }
      // Nobody is looking and nothing would be lost: update now, with no question. The same screen comes back.
      if (document.hidden && hooks.idle()) {
        void update()
        return
      }
      const inCall = hooks.inCall()
      showOffer(
        {
          title: 'A new version of Nook is ready',
          about: inCall
            ? 'It has downloaded. Update now, and you are back in your call in a moment. Or update when you leave it.'
            : 'It has downloaded. Update to reload into it, which takes a second.',
          button: 'Update now',
          busy: 'Updating…',
        },
        update,
        inCall
          ? {
              label: 'When I leave the call',
              run: () => {
                waiting = true
                const look = (): void => {
                  if (hooks.inCall()) window.setTimeout(look, CALL_LOOK_MS)
                  else void update()
                }
                look()
              },
            }
          : null,
      )
    }

    offerWorker = offer
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
      if (document.visibilityState === 'visible') {
        check()
        return
      }
      // Put in the background with an update waiting: take it now, if nothing would be lost.
      if (webWaiting && !desktopFirst && !waiting && !asked && hooks.idle()) {
        document.querySelector('.update-pop')?.remove()
        void webWaiting.update()
      }
    })
  })
}

export type WebCheck = 'newest' | 'ready' | 'unsupported' | 'failed'

/** Check for updates, from the About page. A new version is offered as usual. */
export async function checkForUpdate(): Promise<WebCheck> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return 'unsupported'
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return 'unsupported'
  try {
    await reg.update()
  } catch {
    return 'failed'
  }
  if (reg.installing) await settled(reg.installing)
  if (!reg.waiting || !navigator.serviceWorker.controller) return 'newest'
  document.querySelector('.update-pop')?.remove()
  offerWorker?.(reg.waiting)
  return 'ready'
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
  await hooks.beforeReload()
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

const RELEASES = 'https://github.com/nookchat/nook-app/releases/latest'
/** When an old desktop app was last offered the download: once a day is enough. */
const OLD_SHELL_KEY = 'nook.desktop-offer.v1'
const OLD_SHELL_EVERY_MS = 24 * 60 * 60 * 1000

function offeredLately(): boolean {
  try {
    const at = Number(localStorage.getItem(OLD_SHELL_KEY))
    if (Date.now() - at < OLD_SHELL_EVERY_MS) return true
    localStorage.setItem(OLD_SHELL_KEY, String(Date.now()))
  } catch {
    /* storage blocked: offer it */
  }
  return false
}

interface DesktopShell {
  onUpdate?: (fn: (offer: { version: string; ready: boolean }) => void) => () => void
  installUpdate?: () => void
}

/**
 * The desktop app updates itself from the GitHub releases, apart from the page.
 * On Windows and Linux it downloads the new version, and this offers a restart
 * into it. On macOS it can only say there is one, so this offers the download.
 * A desktop app from before it could update itself is offered the download.
 */
export function watchForDesktopUpdates(): void {
  const shell = (window as Window & { nookDesktop?: DesktopShell }).nookDesktop
  if (!shell) return
  if (!shell.onUpdate || !shell.installUpdate) {
    if (offeredLately()) return
    showOffer(
      {
        title: 'A new Nook desktop app is out',
        about: 'This one cannot update itself. The new one can, so this is the last time you download it.',
        button: 'Download',
        busy: 'Opening…',
      },
      async () => {
        window.open(RELEASES, '_blank', 'noopener')
        document.querySelector('.update-pop')?.remove()
      },
    )
    return
  }
  const install = shell.installUpdate
  shell.onUpdate(({ version, ready }) => {
    desktopFirst = () => {
      const alsoWeb = webWaiting ? ' The newest web version comes with it.' : ''
      showOffer(
        ready
          ? {
              title: `Nook ${version} for the desktop is ready`,
              about: `It has downloaded. Restart to use it, and you are back on this screen, and in your call.${alsoWeb}`,
              button: 'Restart',
              busy: 'Restarting…',
            }
          : {
              title: `Nook ${version} for the desktop is out`,
              about: `Download it and open it in place of this one. Your spaces stay as they are.${alsoWeb}`,
              button: 'Download',
              busy: 'Opening…',
            },
        async () => {
          if (ready) {
            // The call is noted, to join again after, and the new worker takes charge first,
            // so the restarted app opens on the new web version, on the same screen.
            showBoot(`Restarting into Nook ${version}`, true)
            await hooks.beforeReload(true)
            await takeWebQuietly()
            install()
            return
          }
          install()
          document.querySelector('.update-pop')?.remove()
          // The app keeps running while the download does, so the page reloads into the new web version now.
          await webWaiting?.update()
        },
      )
    }
    desktopFirst()
  })
}

/** Puts the waiting web version in charge with no reload: the restart that follows loads it. */
async function takeWebQuietly(): Promise<void> {
  const worker = webWaiting?.worker
  if (!worker || !('serviceWorker' in navigator)) return
  const inCharge = new Promise<void>((done) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => done(), { once: true })
    window.setTimeout(done, QUIET_SWAP_MS)
  })
  worker.postMessage({ type: 'nook-update' })
  await inCharge
}

interface OfferWords {
  title: string
  about: string
  button: string
  /** On the button once it is pressed. */
  busy: string
}

/**
 * The popup that offers the new version. Later puts it away until the next
 * check finds it again. `other` is a second choice, beside the first.
 */
function showOffer(
  words: OfferWords,
  update: () => Promise<void>,
  other: { label: string; run: () => void } | null = null,
): void {
  document.querySelector('.update-pop')?.remove()
  const now = h('button', { class: 'primary', text: words.button })
  const pop = h('div', { class: 'update-pop', role: 'alertdialog', ariaLabel: words.title }, [
    h('span', { class: 'update-icon' }, [icon('download', 20)]),
    h('div', { class: 'update-words' }, [
      h('strong', { text: words.title }),
      h('span', { class: 'tiny faint', text: words.about }),
      h('div', { class: 'row wrap update-actions' }, [
        now,
        other
          ? h('button', {
              text: other.label,
              on: {
                click: () => {
                  pop.remove()
                  other.run()
                },
              },
            })
          : null,
        h('button', { class: 'ghost', text: 'Later', on: { click: () => pop.remove() } }),
      ]),
    ]),
  ])
  now.addEventListener('click', () => {
    now.disabled = true
    now.textContent = words.busy
    void update()
  })
  document.body.append(pop)
}
