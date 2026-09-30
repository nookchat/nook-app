// Gets the sound of a YouTube video, for the soundboard. yt-dlp does the work: Nook
// fetches it the first time from yt-dlp's own releases on GitHub, keeps it with its
// settings, and lets it update itself once a week, since YouTube changes often. Only
// the audio comes down, as YouTube serves it, so ffmpeg is not needed: the page cuts
// out the part it wants. YouTube needs a JavaScript runtime for yt-dlp to read its
// pages, and the app's own Electron is one, run as Node.

const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { net } = require('electron')

/** As the page opens them: a longer or bigger sound is not fetched. */
const LONGEST_S = 600
const MOST_MB = 40
const FETCH_MS = 3 * 60 * 1000
const UPDATE_EVERY_MS = 7 * 24 * 60 * 60 * 1000
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'])
const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'

/** The release built for this computer. Windows on Arm runs the x64 one. */
function assetName() {
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
  return null
}

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: FETCH_MS, maxBuffer: 4 * 1024 * 1024, ...options },
      (err, out, errOut) => resolve({ ok: !err, out: String(out), err: String(errOut) }),
    )
  })
}

let getting = null

/** The path of yt-dlp, fetched when it is not there yet. */
function ytDlp(dir) {
  const name = assetName()
  if (!name) return Promise.reject(new Error('Nook cannot get YouTube sounds on this computer.'))
  const file = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (fs.existsSync(file)) return Promise.resolve(file)
  getting ??= (async () => {
    fs.mkdirSync(dir, { recursive: true })
    const res = await net.fetch(RELEASES + name)
    if (!res.ok) throw new Error(`Nook could not get yt-dlp from GitHub (${res.status}).`)
    const part = `${file}.part`
    fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()), { mode: 0o755 })
    fs.renameSync(part, file)
    return file
  })().finally(() => {
    getting = null
  })
  return getting
}

/** yt-dlp updates itself, at most once a week. A failed update keeps the one there is. */
async function freshen(file) {
  let age = Infinity
  try {
    age = Date.now() - fs.statSync(file).mtimeMs
  } catch {
    return
  }
  if (age < UPDATE_EVERY_MS) return
  await run(file, ['--update'])
  try {
    const now = new Date()
    fs.utimesSync(file, now, now)
  } catch {
    /* it is checked again next time */
  }
}

/** What yt-dlp said went wrong, in words for the page. */
function reason(errOut) {
  const text = errOut.split('\n').filter((line) => line.startsWith('ERROR:')).join(' ')
  if (/not a bot|sign in to confirm/i.test(text)) return 'YouTube wants to check that this is not a bot. Try again later, or from another network.'
  if (/private video|members-only|age/i.test(text)) return 'That video is private, for members only, or age restricted.'
  if (/unavailable|does not exist|not available/i.test(text)) return 'That video is not there, or not available here.'
  if (/max-filesize|larger than max/i.test(text)) return `That sound is bigger than ${MOST_MB} MB.`
  return 'Nook could not get the sound of that video.'
}

/**
 * The sound of one YouTube video: { title, bytes, type }, or { error } with words to show.
 * `dir` is where yt-dlp is kept.
 */
async function youtubeAudio(dir, raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return { error: 'That is not a YouTube link.' }
  }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) return { error: 'That is not a YouTube link.' }

  let file
  try {
    file = await ytDlp(dir)
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Nook could not get yt-dlp.' }
  }
  await freshen(file)

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nook-yt-'))
  try {
    const got = await run(
      file,
      [
        '--ignore-config',
        '--no-playlist',
        '--no-warnings',
        '--no-part',
        '--no-mtime',
        '--format',
        'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
        '--match-filter',
        `duration <= ${LONGEST_S}`,
        '--max-filesize',
        `${MOST_MB}M`,
        '--output',
        path.join(work, 'sound.%(ext)s'),
        '--print',
        'before_dl:%(duration)s %(title)s',
        '--print',
        'after_move:filepath',
        '--no-simulate',
        '--js-runtimes',
        `node:${process.execPath}`,
        '--',
        url.href,
      ],
      // Electron runs as plain Node for yt-dlp's JavaScript.
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    )
    const lines = got.out.split('\n').map((line) => line.trim()).filter(Boolean)
    const where = lines.find((line) => line.startsWith(work))
    if (!got.ok || !where) {
      // The filter skips a long video without an error.
      if (got.ok) return { error: `That video is longer than ${LONGEST_S / 60} minutes.` }
      return { error: reason(got.err) }
    }
    const first = lines.find((line) => !line.startsWith(work)) ?? ''
    const title = first.replace(/^\S+\s/, '').trim() || 'Sound'
    const ext = path.extname(where).slice(1).toLowerCase()
    const type = ext === 'm4a' || ext === 'mp4' ? 'audio/mp4' : ext === 'webm' ? 'audio/webm' : ext === 'mp3' ? 'audio/mpeg' : 'audio/*'
    return { title, bytes: fs.readFileSync(where), type }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

module.exports = { youtubeAudio }
