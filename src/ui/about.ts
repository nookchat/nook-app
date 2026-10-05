import { CHANGELOG } from '../changelog'
import { checkForUpdate } from '../net/updates'
import { h } from './dom'
import { icon } from './icons'
import { actionRow, card, note, toggle } from './settings-shell'

const RELEASES = 'https://github.com/nookchat/nook-app/releases'
const HOW_IT_WORKS = './how-it-works.html'
const CHECK_WAIT_MS = 15_000

type DesktopCheck = { state: 'newest' | 'available' | 'downloading' | 'ready' | 'failed' | 'dev'; version?: string }

interface DesktopShell {
  version?: () => Promise<string>
  checkUpdate?: () => Promise<DesktopCheck>
  installUpdate?: () => void
  closesToTray?: () => boolean
  setCloseToTray?: (on: boolean) => void
}

const desktop = (): DesktopShell | null => (window as Window & { nookDesktop?: DesktopShell }).nookDesktop ?? null

/** A check that has not answered by now counts as failed. */
function late<T>(value: T): Promise<T> {
  return new Promise((done) => window.setTimeout(() => done(value), CHECK_WAIT_MS))
}

function versionLine(version: string, commit: string): string {
  return commit ? `${version} (${commit})` : version
}

/** The About tab in your settings: which version this is, and a look for a newer one. */
export function aboutSettings(): HTMLElement {
  const webSaid = note('')
  const webCheck = h('button', { text: 'Check for updates' })
  webCheck.addEventListener('click', async () => {
    webCheck.disabled = true
    webSaid.textContent = 'Checking…'
    const found = await Promise.race([checkForUpdate(), late<'failed'>('failed')])
    webCheck.disabled = false
    webSaid.textContent =
      found === 'ready'
        ? 'A new version is ready. Update from the box in the corner.'
        : found === 'newest'
          ? 'This is the newest version.'
          : found === 'unsupported'
            ? 'This page cannot update itself here. A reload gets the newest version.'
            : 'The check did not get through. Try again in a moment.'
  })

  const cards: HTMLElement[] = [
    card(
      'Nook',
      actionRow('Version', versionLine(__NOOK_VERSION__, __NOOK_COMMIT__), webCheck),
      webSaid,
    ),
  ]

  const shell = desktop()
  if (shell) {
    const shellVersion = h('span', { text: '…' })
    void shell.version?.().then((v) => (shellVersion.textContent = v))
    const shellSaid = note('')
    const restart = h('button', { class: 'primary hidden', text: 'Restart to update' })
    restart.addEventListener('click', () => shell.installUpdate?.())
    const download = h('button', { class: 'hidden', text: 'Download' })
    download.addEventListener('click', () => shell.installUpdate?.())
    const shellCheck = h('button', { text: 'Check for updates' })
    if (!shell.checkUpdate) {
      shellCheck.disabled = true
      shellSaid.textContent = 'This desktop app cannot look from here. Get the newest one from the releases page.'
    }
    shellCheck.addEventListener('click', async () => {
      if (!shell.checkUpdate) return
      shellCheck.disabled = true
      shellSaid.textContent = 'Checking…'
      const found = await Promise.race([shell.checkUpdate(), late<DesktopCheck>({ state: 'failed' })])
      shellCheck.disabled = false
      restart.classList.toggle('hidden', found.state !== 'ready')
      download.classList.toggle('hidden', found.state !== 'available')
      shellSaid.textContent =
        found.state === 'newest'
          ? 'This is the newest desktop app.'
          : found.state === 'ready'
            ? `Nook ${found.version} has downloaded. Restart to use it.`
            : found.state === 'downloading'
              ? `Nook ${found.version} is downloading. You are asked to restart when it is ready.`
              : found.state === 'available'
                ? `Nook ${found.version} is out. Download it and open it in place of this one.`
                : found.state === 'dev'
                  ? 'This is a development build, which does not update.'
                  : 'The check did not get through. Try again in a moment.'
    })
    const row = h('div', { class: 'action-row' }, [
      h('span', { class: 'switch-words' }, [
        h('span', { class: 'switch-label', text: 'Version' }),
        h('span', { class: 'tiny faint switch-about' }, [shellVersion]),
      ]),
      h('span', { class: 'row' }, [restart, download, shellCheck]),
    ])
    const { closesToTray, setCloseToTray } = shell
    // An older desktop app has no tray.
    const trayRow =
      closesToTray && setCloseToTray
        ? h('div', { class: 'switch-list' }, [
            toggle('Close to the tray', closesToTray, setCloseToTray, 'Close keeps Nook running in the tray. Quit it from the tray icon.'),
          ])
        : null
    cards.push(card('Desktop app', row, shellSaid, trayRow))
  }

  const changes = h('button', { text: 'See what’s new' })
  changes.addEventListener('click', () => void import('./whats-new').then(({ showAllChanges }) => showAllChanges()))
  const newest = CHANGELOG[0]
  cards.push(card('What’s new', actionRow(newest?.title ?? 'What changed', 'What came with each update', changes)))

  const releases = h('a', { class: 'button-link' }, [icon('link', 15), 'Releases on GitHub'])
  releases.href = RELEASES
  releases.target = '_blank'
  releases.rel = 'noopener noreferrer'
  const howItWorks = h('a', { class: 'button-link' }, [icon('shield', 15), 'How Nook works'])
  howItWorks.href = HOW_IT_WORKS
  howItWorks.target = '_blank'
  howItWorks.rel = 'noopener noreferrer'
  cards.push(
    card(
      'How Nook works',
      note('What Nook encrypts, what a server can see, and how voice, calls and screen share work.'),
      h('div', { class: 'row wrap' }, [howItWorks]),
    ),
  )
  cards.push(
    card(
      'Releases',
      note(shell ? 'What changed in each desktop release, and every download.' : 'The desktop app for macOS, Windows and Linux, and what changed in each release.'),
      h('div', { class: 'row wrap' }, [
        releases,
      ]),
    ),
  )
  return h('div', { class: 'stack settings-stack' }, cards)
}
