// Keeps the desktop app itself up to date from the GitHub releases. The web app
// updates on its own; this is for the shell round it. On Windows and Linux a new
// version downloads in the background, and installs when the page says restart,
// or on the next quit. macOS installs only an update signed by a known
// developer, which this build is not, so there it offers the download page.

const { app, net, shell } = require('electron')

const OWNER = 'nookchat'
const REPO = 'nook-app'
const RELEASES = `https://github.com/${OWNER}/${REPO}/releases/latest`
const CHECK_MS = 4 * 60 * 60 * 1000
/** Past the start, so the first look does not slow the window down. */
const FIRST_CHECK_MS = 10_000

/** 1 when a is newer than b, -1 when older, 0 when the same. Plain x.y.z. */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

/** The newest release on GitHub, by its tag, or null. */
async function newestRelease() {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    const body = await res.json()
    return typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : null
  } catch {
    return null
  }
}

/**
 * Looks now and every few hours. `tell` gets { version, ready } when there is a
 * newer version: ready means it has downloaded and a restart installs it.
 */
function watchUpdates(tell) {
  let offer = null
  const say = (next) => {
    offer = next
    tell(offer)
  }

  if (!app.isPackaged) return { now: () => null, install: () => undefined }

  if (process.platform === 'darwin') {
    const look = async () => {
      const newest = await newestRelease()
      if (newest && compareVersions(newest, app.getVersion()) > 0) say({ version: newest, ready: false })
    }
    setTimeout(look, FIRST_CHECK_MS)
    setInterval(look, CHECK_MS)
    return { now: () => offer, install: () => shell.openExternal(RELEASES) }
  }

  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => say({ version: info.version, ready: true }))
  autoUpdater.on('error', () => undefined)
  const look = () => void autoUpdater.checkForUpdates().catch(() => undefined)
  setTimeout(look, FIRST_CHECK_MS)
  setInterval(look, CHECK_MS)
  return {
    now: () => offer,
    // Silent, and opened again after: the page asked, so no installer screens.
    install: () => (offer?.ready ? autoUpdater.quitAndInstall(true, true) : shell.openExternal(RELEASES)),
  }
}

module.exports = { compareVersions, watchUpdates }
