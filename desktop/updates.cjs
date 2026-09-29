// Keeps the desktop app itself up to date from the GitHub releases. The web app
// updates on its own; this is for the shell round it. A new version downloads in
// the background, and installs when the page says restart. On Windows and Linux
// electron-updater does it, and installs on the next quit too. macOS's own updater
// installs only an update signed by a known developer, which this build is not, so
// there the shell does it itself: it checks the download against the release's
// SHA256SUMS.txt, puts the new app in place of this one, and starts it. Where it
// cannot, it offers the download page.

const { app, net, shell } = require('electron')
const { execFile } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { once } = require('node:events')
const path = require('node:path')

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

  if (!app.isPackaged) return { now: () => null, install: () => undefined, check: async () => ({ state: 'dev' }) }

  if (process.platform === 'darwin') return watchMac(say, () => offer)

  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => say({ version: info.version, ready: true }))
  autoUpdater.on('error', () => undefined)
  const look = () => void autoUpdater.checkForUpdates().catch(() => undefined)
  setTimeout(look, FIRST_CHECK_MS)
  setInterval(look, CHECK_MS)
  // From the About page: what the look found. A newer version downloads by itself.
  const check = async () => {
    if (offer?.ready) return { state: 'ready', version: offer.version }
    try {
      const found = await autoUpdater.checkForUpdates()
      const version = found?.updateInfo?.version
      if (version && compareVersions(version, app.getVersion()) > 0) return { state: 'downloading', version }
      return { state: 'newest' }
    } catch {
      return { state: 'failed' }
    }
  }
  return {
    now: () => offer,
    check,
    // Silent, and opened again after: the page asked, so no installer screens.
    install: () => (offer?.ready ? autoUpdater.quitAndInstall(true, true) : shell.openExternal(RELEASES)),
  }
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000 }, (err, out) => (err ? reject(err) : resolve(String(out))))
  })
}

/** /Applications/Nook.app, from /Applications/Nook.app/Contents/MacOS/Nook. */
function bundlePath() {
  const bundle = path.resolve(process.execPath, '../../..')
  return bundle.endsWith('.app') ? bundle : null
}

/** Only an app this person may write over: not one opened from the disk image, nor one an admin put there. */
function canReplace() {
  const bundle = bundlePath()
  if (!bundle || bundle.startsWith('/Volumes/')) return false
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK)
    fs.accessSync(bundle, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The disk image for this Mac, checked against the release's SHA256SUMS.txt, opened into a folder of ours. */
async function stageMac(version) {
  const dir = path.join(app.getPath('temp'), 'nook-update')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const name = `Nook-${version}-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
  const base = `https://github.com/${OWNER}/${REPO}/releases/download/v${version}/`
  const sums = await net.fetch(`${base}SHA256SUMS.txt`)
  if (!sums.ok) throw new Error('no SHA256SUMS.txt')
  const want = (await sums.text())
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name)?.[0]
  if (!want) throw new Error(`no sum for ${name}`)

  const res = await net.fetch(`${base}${name}`)
  if (!res.ok || !res.body) throw new Error(`no ${name}`)
  const dmg = path.join(dir, name)
  const hash = crypto.createHash('sha256')
  const out = fs.createWriteStream(dmg)
  for await (const chunk of res.body) {
    hash.update(chunk)
    if (!out.write(chunk)) await once(out, 'drain')
  }
  out.end()
  await once(out, 'finish')
  if (hash.digest('hex') !== want) throw new Error('the download does not match its sum')

  const mount = path.join(dir, 'mount')
  await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg])
  const staged = path.join(dir, 'Nook.app')
  try {
    await run('ditto', [path.join(mount, 'Nook.app'), staged])
  } finally {
    await run('hdiutil', ['detach', mount, '-quiet']).catch(() => undefined)
    fs.rmSync(dmg, { force: true })
  }
  // Nothing here came through a browser, so nothing is quarantined, but a copy must not be either.
  await run('xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => undefined)
  return staged
}

/** The new app in place of this one, then it starts. The old one goes on its next start. */
function swapAndRelaunch(staged) {
  swapIn(staged)
  app.relaunch()
  app.exit(0)
}

/** The new app in place of this one, which keeps running from where it was until it quits. */
function swapIn(staged) {
  const bundle = bundlePath()
  const old = path.join(path.dirname(bundle), '.Nook-old.app')
  fs.rmSync(old, { recursive: true, force: true })
  fs.renameSync(bundle, old)
  try {
    try {
      fs.renameSync(staged, bundle)
    } catch {
      require('node:child_process').execFileSync('ditto', [staged, bundle])
    }
  } catch (err) {
    fs.renameSync(old, bundle)
    throw err
  }
}

function watchMac(say, now) {
  const bundle = bundlePath()
  if (bundle) fs.rmSync(path.join(path.dirname(bundle), '.Nook-old.app'), { recursive: true, force: true })
  let staged = null
  let staging = null

  const look = async () => {
    const newest = await newestRelease()
    if (!newest) return { state: 'failed' }
    if (compareVersions(newest, app.getVersion()) <= 0) return { state: 'newest' }
    if (staged?.version === newest) return { state: 'ready', version: newest }
    if (!canReplace()) {
      say({ version: newest, ready: false })
      return { state: 'available', version: newest }
    }
    staging ??= stageMac(newest)
      .then((where) => {
        staged = { version: newest, app: where }
        say({ version: newest, ready: true })
      })
      .catch(() => say({ version: newest, ready: false }))
      .finally(() => {
        staging = null
      })
    return { state: 'downloading', version: newest }
  }
  setTimeout(() => void look(), FIRST_CHECK_MS)
  setInterval(() => void look(), CHECK_MS)
  // As Windows does: an update that has downloaded goes in on quit, so the next start is new.
  app.on('will-quit', () => {
    if (!staged) return
    try {
      swapIn(staged.app)
    } catch {
      /* it stays for the next quit, or the next start downloads it again */
    }
    staged = null
  })

  return {
    now,
    check: look,
    install: () => {
      if (!staged) return shell.openExternal(RELEASES)
      try {
        swapAndRelaunch(staged.app)
      } catch {
        staged = null
        shell.openExternal(RELEASES)
      }
    },
  }
}

module.exports = { compareVersions, watchUpdates }
