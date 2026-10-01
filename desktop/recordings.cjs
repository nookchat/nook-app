// Finds the game recordings on this computer, so the page can list them and
// share one. Steam keeps a recording as many small video and sound files: this
// joins them into one MP4 as it is read, and never writes a new file. The page
// gets an id for each recording, never where its files are. The id stays the same
// while the recording does, so the page can keep the list and its pictures.
// Nothing here needs Electron: main.cjs gives it the paths it needs.

const { execFile } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')

const TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
}
/** A folder of plain videos is read this deep, and to this many files. */
const MAX_DEPTH = 3
const MAX_FILES = 2000
/** A background recording with a chunk this new is still going. */
const LIVE_MS = 30_000
/** How long the names of the Steam games are kept before they are read again. */
const NAMES_MS = 60_000
/** A request for "from here to the end" gets at most this much, so a video does not pull gigabytes at once. */
const OPEN_RANGE_MAX = 8 * 1024 * 1024
/** A response is read from the files in steps of this size. */
const STEP = 1024 * 1024
/** Folders of Steam's own recordings: a folder of plain videos does not go in them. */
const STEAM_DIR = /^(clip|bg)_/
/** macOS keeps whole libraries in folders like these. They are not recordings. */
const BUNDLE = /\.(photoslibrary|imovielibrary|fcpbundle|tvlibrary|musiclibrary|app)$/i

const NVIDIA_NAME = /\d{4}\.\d{2}\.\d{2} - \d{2}\.\d{2}\.\d{2}\.\d{2}(\.DVR)?\.mp4$/i
const OBS_NAME = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.(mkv|mp4)$/

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err, out) => resolve(err ? '' : String(out)))
  })
}

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(p) {
  try {
    return (await fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

/** The names of the folders in a folder. */
async function dirs(p) {
  try {
    return (await fsp.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

async function real(p) {
  try {
    return await fsp.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

async function readText(p) {
  try {
    return await fsp.readFile(p, 'utf8')
  } catch {
    return ''
  }
}

/** Steam writes a backslash in its files as two. */
const vdfPath = (text) => text.replace(/\\\\/g, '\\')

/** Drops the fields that have no value, so the page gets plain JSON. */
function clean(item) {
  for (const key of Object.keys(item)) if (item[key] === undefined) delete item[key]
  return item
}

/** Keeps the first of each folder, by where it really is. */
async function unique(list) {
  const seen = new Set()
  const out = []
  for (const folder of list) {
    const key = await real(folder.path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(folder)
  }
  return out
}

// Folders

/** The folders Steam may be in. `home` and `platform` are there for the tests. */
async function steamRoots({ platform = process.platform, home = os.homedir() } = {}) {
  let list = []
  if (platform === 'darwin') list = [path.join(home, 'Library', 'Application Support', 'Steam')]
  else if (platform === 'win32') {
    const out = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'])
    const hit = /SteamPath\s+REG_\w+\s+(.+)/.exec(out)
    if (hit) list.push(path.normalize(hit[1].trim()))
    list.push('C:\\Program Files (x86)\\Steam')
  } else {
    list = [
      path.join(home, '.steam', 'steam'),
      path.join(home, '.local', 'share', 'Steam'),
      path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
    ]
  }
  const out = []
  for (const root of list) if (await isDir(root)) out.push({ path: root })
  return (await unique(out)).map((root) => root.path)
}

/** Each Steam account keeps its recordings in its own folder, or where its settings say. */
async function steamFolders(roots) {
  const out = []
  for (const root of roots) {
    const users = (await dirs(path.join(root, 'userdata'))).filter((name) => /^\d+$/.test(name))
    for (const user of users) {
      const base = path.join(root, 'userdata', user)
      const own = path.join(base, 'gamerecordings')
      if (await isDir(own)) out.push(own)
      const config = await readText(path.join(base, 'config', 'localconfig.vdf'))
      const hit = /"BackgroundRecordPath"\s+"([^"]*)"/.exec(config)
      if (hit && hit[1]) out.push(vdfPath(hit[1]))
    }
  }
  return out
}

/** NVIDIA keeps its folder in the registry, as the bytes of a UTF-16 path. */
async function nvidiaFolder(platform) {
  if (platform !== 'win32') return null
  const out = await run('reg', ['query', 'HKCU\\Software\\NVIDIA Corporation\\Global\\ShadowPlay\\NVSPCAPS', '/v', 'DefaultPathW'])
  const hit = /DefaultPathW\s+REG_BINARY\s+([0-9A-Fa-f]+)/.exec(out)
  if (!hit) return null
  return Buffer.from(hit[1], 'hex').toString('utf16le').replace(/\0+$/, '') || null
}

/** The folders found without help: Steam's, NVIDIA's, and the system's videos folder. */
async function foundFolders(opts = {}) {
  const platform = opts.platform ?? process.platform
  const list = []
  for (const p of await steamFolders(await steamRoots(opts))) list.push({ path: p, label: 'Steam', kind: 'steam', found: true })
  const nvidia = await nvidiaFolder(platform)
  if (nvidia) list.push({ path: nvidia, label: 'NVIDIA', kind: 'nvidia', found: true })
  if (opts.videos && (await isDir(opts.videos))) list.push({ path: opts.videos, label: 'Videos', kind: 'videos', found: true })
  return unique(list)
}

/** A folder of Steam's recordings, or one of its clips or video folders. */
async function looksSteam(p) {
  let list
  try {
    list = await fsp.readdir(p, { withFileTypes: true })
  } catch {
    return false
  }
  if (list.some((d) => d.name === 'gamerecording.pb')) return true
  const base = path.basename(p)
  if ((base === 'clips' || base === 'video') && list.some((d) => d.isDirectory() && STEAM_DIR.test(d.name))) return true
  for (const sub of ['clips', 'video']) {
    if (!list.some((d) => d.isDirectory() && d.name === sub)) continue
    if ((await dirs(path.join(p, sub))).some((name) => STEAM_DIR.test(name))) return true
  }
  return false
}

function strings(list) {
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p) : []
}

function readConfig(file) {
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    const salt = typeof config.salt === 'string' && /^[0-9a-f]{32}$/.test(config.salt) ? config.salt : undefined
    return { folders: strings(config.folders), hidden: strings(config.hidden), salt }
  } catch {
    return { folders: [], hidden: [] }
  }
}

/** Mixed into every id, and kept, so an id is the same after a restart but tells nobody the path. */
function saltOf(opts) {
  const config = readConfig(opts.file)
  if (config.salt) return config.salt
  config.salt = crypto.randomBytes(16).toString('hex')
  writeConfig(opts.file, config)
  return config.salt
}

/** A recording's id: where it is, and how big and how new it is, so a recording that grows gets a new one. */
function idOf(salt, entry) {
  return crypto.createHash('sha256').update(`${salt}\n${entry.key}\n${entry.print}`).digest('hex').slice(0, 16)
}

function writeConfig(file, config) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(config, null, 2))
  } catch {
    /* no place to keep it: the list is the same until the app closes */
  }
}

/**
 * Every folder the list reads: the found ones the user did not remove, then the
 * ones the user added. `opts` is { file, videos, platform?, home? }.
 */
async function folders(opts) {
  const config = readConfig(opts.file)
  const found = (await foundFolders(opts)).filter((folder) => !config.hidden.includes(folder.path))
  const added = []
  for (const p of config.folders) {
    added.push({ path: p, label: path.basename(p) || p, kind: (await looksSteam(p)) ? 'steam' : 'folder', found: false })
  }
  const all = await unique([...found, ...added])
  return Promise.all(all.map(async (folder) => ({ ...folder, exists: await isDir(folder.path) })))
}

async function addFolder(opts, folder) {
  const config = readConfig(opts.file)
  const full = path.resolve(folder)
  config.hidden = config.hidden.filter((p) => p !== full)
  if (!config.folders.includes(full)) config.folders.push(full)
  writeConfig(opts.file, config)
  return folders(opts)
}

/** A folder the user added goes. A found one is hidden, so it does not come back on the next look. */
async function removeFolder(opts, folder) {
  const config = readConfig(opts.file)
  config.folders = config.folders.filter((p) => p !== folder)
  const found = await foundFolders(opts)
  if (found.some((f) => f.path === folder) && !config.hidden.includes(folder)) config.hidden.push(folder)
  writeConfig(opts.file, config)
  return folders(opts)
}

async function restoreFolders(opts) {
  const config = readConfig(opts.file)
  config.hidden = []
  writeConfig(opts.file, config)
  return folders(opts)
}

// Steam game names

let names = { key: '', at: 0, names: new Map() }

/** The name of each Steam game by its app id, from the app manifests in every Steam library. */
async function gameNames(roots) {
  const key = roots.join('\n')
  if (names.key === key && Date.now() - names.at < NAMES_MS) return names.names
  const found = new Map()
  const libraries = new Set(roots)
  for (const root of roots) {
    const vdf = await readText(path.join(root, 'steamapps', 'libraryfolders.vdf'))
    for (const hit of vdf.matchAll(/"path"\s+"([^"]*)"/g)) libraries.add(vdfPath(hit[1]))
  }
  for (const library of libraries) {
    const apps = path.join(library, 'steamapps')
    let files = []
    try {
      files = (await fsp.readdir(apps)).filter((f) => /^appmanifest_\d+\.acf$/.test(f))
    } catch {
      continue
    }
    for (const file of files) {
      const name = /"name"\s+"([^"]+)"/.exec(await readText(path.join(apps, file)))?.[1]
      if (name) found.set(Number(/\d+/.exec(file)[0]), name)
    }
  }
  names = { key, at: Date.now(), names: found }
  return found
}

// Steam recordings

/** clip_730_20260929_201500: the game's app id, and the local time Steam started it. */
function steamName(name) {
  const hit = /^(?:clip|bg)_([^_]*)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name)
  if (!hit) return { appId: undefined, at: 0 }
  const [, app, y, mo, d, h, mi, s] = hit
  const appId = /^\d+$/.test(app) && Number(app) > 0 ? Number(app) : undefined
  return { appId, at: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime() }
}

/** PT1M0.5S in seconds, or null. */
function isoSeconds(text) {
  const hit = /^P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(text ?? '')
  if (!hit) return null
  const [, d = 0, h = 0, m = 0, s = 0] = hit
  const total = Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s)
  return Number.isFinite(total) && total > 0 ? total : null
}

/** What the session.mpd says: how long, how big, and the codecs of the video and the sound. */
function mpdInfo(text, videoChunks) {
  const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
  const video = []
  const audio = []
  let width
  let height
  for (const hit of text.matchAll(/<Representation\b([^>]*)>/g)) {
    const tag = hit[1]
    const codecs = attr(tag, 'codecs')
    const mime = attr(tag, 'mimeType') ?? ''
    const isVideo = mime.startsWith('video/') || /\bwidth="/.test(tag) || /^(avc|hvc|hev|av01|vp0)/.test(codecs ?? '')
    if (isVideo) {
      width ??= Number(attr(tag, 'width')) || undefined
      height ??= Number(attr(tag, 'height')) || undefined
    }
    if (codecs) (isVideo ? video : audio).push(codecs)
  }
  let duration = isoSeconds(/\bmediaPresentationDuration="([^"]*)"/.exec(text)?.[1])
  if (duration === null && videoChunks > 0) {
    const template = /<SegmentTemplate\b([^>]*)>/.exec(text)?.[1] ?? ''
    const step = Number(attr(template, 'duration'))
    const scale = Number(attr(template, 'timescale')) || 1
    if (step > 0) duration = (videoChunks * step) / scale
  }
  return { duration, width, height, videoCodec: video[0], audioCodec: audio[0] }
}

/** A folder with one Steam recording in it: its size, its newest chunk, and what the mpd says. */
async function readSession(dir) {
  let list
  try {
    list = await fsp.readdir(dir)
  } catch {
    return null
  }
  if (!list.some((name) => /^init-stream\d+\.m4s$/.test(name))) return null
  let size = 0
  let newest = 0
  let videoChunks = 0
  let writing = false
  for (const name of list) {
    if (name.endsWith('.tmp')) {
      writing = true
      continue
    }
    if (!/^(init|chunk)-stream\d+.*\.m4s$/.test(name)) continue
    try {
      const st = await fsp.stat(path.join(dir, name))
      size += st.size
      if (name.startsWith('chunk-')) newest = Math.max(newest, st.mtimeMs)
    } catch {
      continue
    }
    if (name.startsWith('chunk-stream0-')) videoChunks++
  }
  const mpd = list.includes('session.mpd') ? await readText(path.join(dir, 'session.mpd')) : ''
  return { size, newest, writing, ...mpdInfo(mpd, videoChunks) }
}

function steamEntry({ kind, dir, show, thumb, folder, name, part, gameNames: known }) {
  return async () => {
    const info = await readSession(dir)
    if (!info) return null
    const { appId, at } = steamName(name)
    const game = appId ? known.get(appId) : undefined
    const base = game ?? (appId ? `Steam game ${appId}` : 'Steam recording')
    const live = kind === 'steam-background' ? info.writing || Date.now() - info.newest < LIVE_MS : undefined
    return {
      key: await real(dir),
      print: `${info.size}|${Math.round(info.newest)}`,
      kind,
      dir,
      show,
      thumb,
      live: !!live,
      videoCodec: info.videoCodec,
      audioCodec: info.audioCodec,
      item: {
        kind,
        title: part ? `${base} (part ${part})` : base,
        game,
        appId,
        source: 'Steam',
        folder: folder.path,
        at: at || info.newest,
        duration: info.duration,
        size: info.size,
        width: info.width,
        height: info.height,
        live,
        type: 'video/mp4',
        codecs: [info.videoCodec, info.audioCodec].filter(Boolean).join(',') || undefined,
      },
    }
  }
}

/** The clips and background recordings in a Steam folder, or in its clips or video folder. */
async function scanSteam(folder, known) {
  const root = folder.path
  const work = []
  for (const place of new Set([root, path.join(root, 'clips'), path.join(root, 'video')])) {
    for (const name of await dirs(place)) {
      const dir = path.join(place, name)
      if (name.startsWith('clip_')) {
        const sessions = []
        for (const session of (await dirs(path.join(dir, 'video'))).sort()) sessions.push(path.join(dir, 'video', session))
        const thumbFile = path.join(dir, 'thumbnail.jpg')
        const thumb = (await isFile(thumbFile)) ? thumbFile : undefined
        sessions.forEach((session, i) =>
          work.push(
            steamEntry({ kind: 'steam-clip', dir: session, show: dir, thumb, folder, name, part: sessions.length > 1 ? i + 1 : 0, gameNames: known }),
          ),
        )
      } else if (name.startsWith('bg_')) {
        work.push(steamEntry({ kind: 'steam-background', dir, show: dir, folder, name, part: 0, gameNames: known }))
      }
    }
  }
  const out = []
  for (const make of work) {
    const entry = await make()
    if (entry) out.push(entry)
  }
  return out
}

// Plain video files

/** How long each plain file is, by its path, size and time, so a second look does not read it again. */
let durations = new Map()
let nextDurations = new Map()

async function readFull(fh, buf, offset, length, position) {
  let done = 0
  while (done < length) {
    const { bytesRead } = await fh.read(buf, offset + done, length - done, position + done)
    if (!bytesRead) throw new Error('The file ended early.')
    done += bytesRead
  }
}

/** The length of an MP4 or MOV, from the mvhd box of its moov, or the mehd box of a fragmented one. */
async function mp4Duration(fh, size) {
  const head = Buffer.alloc(16)
  let at = 0
  while (at + 8 <= size) {
    await readFull(fh, head, 0, Math.min(16, size - at), at)
    let len = head.readUInt32BE(0)
    let h = 8
    if (len === 1) {
      len = Number(head.readBigUInt64BE(8))
      h = 16
    } else if (len === 0) len = size - at
    if (len < h) return null
    if (head.toString('latin1', 4, 8) === 'moov') {
      const moov = Buffer.alloc(Math.min(len - h, STEP, size - at - h))
      await readFull(fh, moov, 0, moov.length, at + h)
      return moovDuration(moov)
    }
    at += len
  }
  return null
}

function moovDuration(moov) {
  let fragments = null
  for (const kid of children(moov, 0, moov.length, true)) {
    const p = kid.at + kid.head
    if (kid.type === 'mvhd') {
      const v = moov[p]
      const scale = moov.readUInt32BE(p + 4 + (v ? 16 : 8))
      const length = v ? Number(moov.readBigUInt64BE(p + 24)) : moov.readUInt32BE(p + 16)
      if (scale && length && length !== 0xffffffff) return length / scale
      fragments = scale
    }
    if (kid.type === 'mvex' && fragments) {
      const mehd = children(moov, p, kid.end, true).find((k) => k.type === 'mehd')
      if (!mehd) return null
      const q = mehd.at + mehd.head
      const length = moov[q] ? Number(moov.readBigUInt64BE(q + 4)) : moov.readUInt32BE(q + 4)
      return length ? length / fragments : null
    }
  }
  return null
}

/** An EBML number: an element id keeps its first bit, a size does not. */
function vint(buf, at, keep) {
  const first = buf[at]
  if (first === undefined || first === 0) return null
  let len = 1
  while (!(first & (0x80 >> (len - 1)))) len++
  if (at + len > buf.length) return null
  let value = keep ? first : first & (0xff >> len)
  let ones = value === 0xff >> len
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[at + i]
    if (buf[at + i] !== 0xff) ones = false
  }
  return { value, len, unknown: !keep && ones }
}

/** The length of an MKV or WebM, from the Duration in its Segment Info. */
function ebmlDuration(buf) {
  let scale = 1_000_000
  let duration = null
  const walk = (start, end) => {
    let at = start
    while (at < end) {
      const id = vint(buf, at, true)
      const size = id && vint(buf, at + id.len, false)
      if (!size) return
      const body = at + id.len + size.len
      const stop = size.unknown ? end : Math.min(end, body + size.value)
      if (id.value === 0x18538067 || id.value === 0x1549a966) walk(body, stop)
      else if (id.value === 0x2ad7b1) scale = buf.readUIntBE(body, Math.min(6, size.value))
      else if (id.value === 0x4489) duration = size.value === 4 ? buf.readFloatBE(body) : buf.readDoubleBE(body)
      // The first cluster of pictures: the part that says how long it is is over.
      else if (id.value === 0x1f43b675) return
      if (size.unknown) return
      at = body + size.value
    }
  }
  try {
    walk(0, buf.length)
  } catch {
    /* a header cut short: keep what was read */
  }
  return duration > 0 ? (duration * scale) / 1e9 : null
}

async function fileDuration(file, st) {
  const key = `${file}\n${st.size}\n${st.mtimeMs}`
  if (durations.has(key)) {
    nextDurations.set(key, durations.get(key))
    return durations.get(key)
  }
  let duration = null
  let fh = null
  try {
    fh = await fsp.open(file, 'r')
    const ext = path.extname(file).toLowerCase()
    if (ext === '.mkv' || ext === '.webm') {
      const buf = Buffer.alloc(Math.min(st.size, 256 * 1024))
      await readFull(fh, buf, 0, buf.length, 0)
      duration = ebmlDuration(buf)
    } else duration = await mp4Duration(fh, st.size)
  } catch {
    duration = null
  } finally {
    await fh?.close().catch(() => {})
  }
  if (!Number.isFinite(duration)) duration = null
  nextDurations.set(key, duration)
  return duration
}

/** Where a plain file came from, by its name and its folder. */
function sourceOf(name, rel, folder) {
  if (NVIDIA_NAME.test(name)) return 'NVIDIA'
  if (rel.includes('Captures') || path.basename(folder.path) === 'Captures') return 'Xbox'
  if (OBS_NAME.test(name)) return 'OBS'
  return folder.label
}

async function fileEntry(folder, file, rel) {
  let st
  try {
    st = await fsp.stat(file)
  } catch {
    return null
  }
  const name = path.basename(file)
  const ext = path.extname(name)
  return {
    key: await real(file),
    print: `${st.size}|${Math.round(st.mtimeMs)}`,
    kind: 'file',
    file,
    show: file,
    type: TYPES[ext.toLowerCase()],
    item: {
      kind: 'file',
      title: name.slice(0, name.length - ext.length),
      // NVIDIA saves a game's videos in a folder named after the game.
      game: rel[0],
      source: sourceOf(name, rel, folder),
      folder: folder.path,
      at: Math.round(st.mtimeMs),
      duration: await fileDuration(file, st),
      size: st.size,
      type: TYPES[ext.toLowerCase()],
    },
  }
}

/** The videos in a folder and in its folders, a few deep. Steam's folders are left to scanSteam. */
async function scanFiles(folder) {
  const out = []
  const walk = async (dir, rel) => {
    let list
    try {
      list = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    list.sort((a, b) => a.name.localeCompare(b.name))
    for (const d of list) {
      if (out.length >= MAX_FILES) return
      if (d.name.startsWith('.')) continue
      const full = path.join(dir, d.name)
      if (d.isDirectory()) {
        if (rel.length >= MAX_DEPTH || d.name === 'node_modules' || BUNDLE.test(d.name) || STEAM_DIR.test(d.name)) continue
        if (d.name === 'gamerecordings' || (await looksSteam(full))) continue
        await walk(full, [...rel, d.name])
      } else if (d.isFile() && TYPES[path.extname(d.name).toLowerCase()]) {
        const entry = await fileEntry(folder, full, rel)
        if (entry) out.push(entry)
      }
    }
  }
  await walk(folder.path, [])
  return out
}

// The list

/** The recordings of the latest look, by id. An id of a recording that changed since finds nothing. */
let current = new Map()

/** Every recording in every folder that is there, newest first. Never throws. */
async function list(opts) {
  try {
    const salt = saltOf(opts)
    const all = (await folders(opts)).filter((folder) => folder.exists)
    const known = await gameNames(await steamRoots(opts))
    nextDurations = new Map()
    const seen = new Set()
    const next = new Map()
    const items = []
    for (const folder of all) {
      const found = folder.kind === 'steam' ? await scanSteam(folder, known) : await scanFiles(folder)
      for (const entry of found) {
        if (seen.has(entry.key)) continue
        seen.add(entry.key)
        const id = idOf(salt, entry)
        // The same recording as last time keeps what was worked out about it, such as its join.
        next.set(id, current.get(id) ?? entry)
        items.push(
          clean({
            id,
            ...entry.item,
            url: `nook-rec://media/${id}`,
            thumb: entry.thumb ? `nook-rec://thumb/${id}` : undefined,
          }),
        )
      }
    }
    durations = nextDurations
    current = next
    return items.sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}

/** The path of a plain video file by its id, or null: a Steam recording is many files, and an unknown id none. */
function plainFile(id) {
  const entry = current.get(id)
  return entry && entry.kind === 'file' ? entry.file : null
}

/** What to show in the file manager: the file, or the folder of a Steam recording. */
function place(id) {
  return current.get(id)?.show ?? null
}

// MP4 boxes

/** The boxes from `start` to `end`. `loose` stops at a box cut short, where the strict way throws. */
function children(buf, start, end, loose = false) {
  const out = []
  let at = start
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at)
    let head = 8
    if (size === 1) {
      if (at + 16 > end) break
      size = Number(buf.readBigUInt64BE(at + 8))
      head = 16
    } else if (size === 0) size = end - at
    if (size < head || at + size > end) {
      if (loose) break
      throw new Error('A box is cut short.')
    }
    out.push({ type: buf.toString('latin1', at + 4, at + 8), at, head, size, end: at + size })
    at += size
  }
  if (!loose && at !== end) throw new Error('A box is cut short.')
  return out
}

function child(buf, parent, type) {
  const found = children(buf, parent.at + parent.head, parent.end).find((k) => k.type === type)
  if (!found) throw new Error(`No ${type} box.`)
  return found
}

function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}

function u64(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}

function box(type, parts) {
  const body = Buffer.concat(parts)
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body])
}

/** The same box with the track id in its tkhd (for a trak) or at its start (for a trex) changed. */
function withTrackId(buf, id) {
  const out = Buffer.from(buf)
  const top = children(out, 0, out.length)[0]
  if (top.type === 'trex') {
    out.writeUInt32BE(id, top.head + 4)
    return out
  }
  const tkhd = child(out, top, 'tkhd')
  const p = tkhd.at + tkhd.head
  out.writeUInt32BE(id, p + 4 + (out[p] ? 16 : 8))
  return out
}

/** An init segment: ftyp and a moov with one track. */
function parseInit(buf) {
  const top = children(buf, 0, buf.length)
  const ftyp = top.find((b) => b.type === 'ftyp')
  const moov = top.find((b) => b.type === 'moov')
  if (!ftyp || !moov) throw new Error('No moov box.')
  const kids = children(buf, moov.at + moov.head, moov.end)
  const mvhd = kids.find((k) => k.type === 'mvhd')
  const trak = kids.find((k) => k.type === 'trak')
  const mvex = kids.find((k) => k.type === 'mvex')
  if (!mvhd || !trak || !mvex) throw new Error('Not a fragmented MP4.')
  const trex = child(buf, mvex, 'trex')
  const mdia = child(buf, trak, 'mdia')
  const mdhd = child(buf, mdia, 'mdhd')
  const hdlr = child(buf, mdia, 'hdlr')
  const p = mdhd.at + mdhd.head
  const q = mvhd.at + mvhd.head
  return {
    ftyp: buf.subarray(ftyp.at, ftyp.end),
    kids: kids.map((k) => ({ type: k.type, buf: buf.subarray(k.at, k.end) })),
    trak: buf.subarray(trak.at, trak.end),
    trex: buf.subarray(trex.at, trex.end),
    timescale: buf.readUInt32BE(p + 4 + (buf[p] ? 16 : 8)),
    movieScale: buf.readUInt32BE(q + 4 + (buf[q] ? 16 : 8)),
    handler: buf.toString('latin1', hdlr.at + hdlr.head + 8, hdlr.at + hdlr.head + 12),
    sampleDuration: buf.readUInt32BE(trex.at + trex.head + 12),
  }
}

/**
 * The start of the joined file: the video's ftyp, and a moov with the video track as
 * track 1 and the sound track as track 2. The mehd says how long the whole file is.
 */
function joinedHeader(video, audio, seconds) {
  const kids = []
  for (const kid of video.kids) {
    if (kid.type === 'mvex') continue
    if (kid.type === 'mvhd') {
      const mvhd = Buffer.from(kid.buf)
      // next_track_ID is the last field of the mvhd, in both versions.
      mvhd.writeUInt32BE(audio ? 3 : 2, mvhd.length - 4)
      kids.push(mvhd)
    } else kids.push(kid.buf)
  }
  if (audio) kids.push(withTrackId(audio.trak, 2))
  const mehd = box('mehd', [Buffer.from([1, 0, 0, 0]), u64(Math.round(seconds * video.movieScale))])
  const trex = [video.trex]
  if (audio) trex.push(withTrackId(audio.trex, 2))
  kids.push(box('mvex', [mehd, ...trex]))
  return Buffer.concat([video.ftyp, box('moov', kids)])
}

/**
 * A moof: where its fields are, from the start of the moof, so they can be changed
 * as the file is read. `ticks` is how long its samples last, in the track's timescale.
 */
function parseMoof(buf, sampleDuration) {
  const moof = children(buf, 0, buf.length)[0]
  const kids = children(buf, moof.head, moof.end)
  const mfhd = kids.find((k) => k.type === 'mfhd')
  const out = { seqAt: mfhd ? mfhd.at + mfhd.head + 4 : -1, idAts: [], start: -1, ticks: 0 }
  for (const traf of kids.filter((k) => k.type === 'traf')) {
    let each = sampleDuration
    for (const kid of children(buf, traf.at + traf.head, traf.end)) {
      const p = kid.at + kid.head
      if (kid.type === 'tfhd') {
        const flags = buf.readUInt32BE(p) & 0xffffff
        out.idAts.push(p + 4)
        let q = p + 8
        if (flags & 0x1) q += 8
        if (flags & 0x2) q += 4
        if (flags & 0x8) each = buf.readUInt32BE(q)
      } else if (kid.type === 'tfdt') {
        out.start = buf[p] ? Number(buf.readBigUInt64BE(p + 4)) : buf.readUInt32BE(p + 4)
      } else if (kid.type === 'trun') {
        const flags = buf.readUInt32BE(p) & 0xffffff
        const count = buf.readUInt32BE(p + 4)
        let q = p + 8
        if (flags & 0x1) q += 4
        if (flags & 0x4) q += 4
        if (!(flags & 0x100)) out.ticks += count * each
        else {
          // Each sample has a duration first, then the other fields its flags ask for.
          const step = 4 * [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length
          for (let i = 0; i < count; i++, q += step) out.ticks += buf.readUInt32BE(q)
        }
      }
    }
  }
  if (out.start < 0) throw new Error('No tfdt box.')
  return out
}

/** The top boxes of a file, read by their headers only. Throws on a box cut short, as in a file Steam still writes. */
async function fileBoxes(fh, size) {
  const head = Buffer.alloc(16)
  const out = []
  let at = 0
  while (at < size) {
    if (size - at < 8) throw new Error('A box is cut short.')
    await readFull(fh, head, 0, Math.min(16, size - at), at)
    let len = head.readUInt32BE(0)
    let h = 8
    if (len === 1) {
      if (size - at < 16) throw new Error('A box is cut short.')
      len = Number(head.readBigUInt64BE(8))
      h = 16
    } else if (len === 0) len = size - at
    if (len < h || at + len > size) throw new Error('A box is cut short.')
    out.push({ type: head.toString('latin1', 4, 8), at, head: h, size: len, end: at + len })
    at += len
  }
  return out
}

/** The fragments of a chunk file: each moof with its mdat. The styp and sidx are left out. */
async function chunkFragments(file, sampleDuration) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const top = await fileBoxes(fh, size)
    const out = []
    for (let i = 0; i < top.length; i++) {
      if (top[i].type !== 'moof') continue
      let j = i + 1
      while (j < top.length && top[j].type !== 'mdat' && top[j].type !== 'moof') j++
      if (j >= top.length || top[j].type !== 'mdat') throw new Error('A moof has no mdat.')
      const moof = Buffer.alloc(top[i].size)
      await readFull(fh, moof, 0, moof.length, top[i].at)
      // The data offsets count from the moof, so the moof and its mdat move as one run of bytes.
      out.push({ file, at: top[i].at, size: top[j].end - top[i].at, ...parseMoof(moof, sampleDuration) })
    }
    return out
  } finally {
    await fh.close().catch(() => {})
  }
}

const round = (n) => Math.round(n * 1e6) / 1e6

/**
 * Joins a Steam recording's chunks into one fragmented MP4, as a list of parts: the
 * new header, then every fragment of both tracks in time order. Nothing is copied:
 * each part says which bytes of which file it is, and the small changes to make to
 * them as they are read. `cache` keeps the fragments of chunks that did not change.
 */
async function joinSteam(dir, { videoCodec, audioCodec, cache = new Map() } = {}) {
  const streams = new Map()
  const stream = (n) => {
    if (!streams.has(n)) streams.set(n, { init: null, chunks: [] })
    return streams.get(n)
  }
  for (const name of await fsp.readdir(dir)) {
    let hit = /^init-stream(\d+)\.m4s$/.exec(name)
    if (hit) stream(hit[1]).init = path.join(dir, name)
    hit = /^chunk-stream(\d+)-(\d+)\.m4s$/.exec(name)
    if (hit) stream(hit[1]).chunks.push({ n: Number(hit[2]), file: path.join(dir, name) })
  }
  const tracks = []
  for (const [n, s] of [...streams].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (!s.init) continue
    try {
      tracks.push({ init: parseInit(await fsp.readFile(s.init)), chunks: s.chunks.sort((a, b) => a.n - b.n), n })
    } catch {
      /* an init segment Steam still writes */
    }
  }
  const video = tracks.find((t) => t.init.handler === 'vide')
  let audio = tracks.find((t) => t.init.handler === 'soun')
  if (!video) throw new Error('No video track.')

  const kept = new Map()
  const load = async (track) => {
    const out = []
    for (const chunk of track.chunks) {
      try {
        const st = await fsp.stat(chunk.file)
        const held = cache.get(chunk.file)
        const frags =
          held && held.size === st.size && held.mtime === st.mtimeMs
            ? held.frags
            : await chunkFragments(chunk.file, track.init.sampleDuration)
        kept.set(chunk.file, { size: st.size, mtime: st.mtimeMs, frags })
        out.push(...frags)
      } catch {
        /* a chunk Steam still writes, or one it just removed */
      }
    }
    return out
  }
  const videoFrags = await load(video)
  const audioFrags = audio ? await load(audio) : []

  // Time zero is the first video fragment: a background recording's oldest chunks are gone.
  // The fragments keep their own times, so `base` says where zero is in them.
  const vScale = video.init.timescale
  const zero = videoFrags.reduce((min, f) => Math.min(min, f.start), Infinity) / vScale || 0
  const runs = []
  for (const f of videoFrags) runs.push({ f, video: true, t: f.start / vScale - zero, end: (f.start + f.ticks) / vScale - zero })
  if (audio) {
    const aScale = audio.init.timescale
    for (const f of audioFrags) {
      const t = f.start / aScale - zero
      const end = (f.start + f.ticks) / aScale - zero
      // Sound from before the first picture is left out. Sound that runs past it is kept.
      if (end <= 0) continue
      runs.push({ f, video: false, t: Math.max(0, t), end })
    }
  }
  if (!runs.some((r) => !r.video)) audio = null
  runs.sort((a, b) => a.t - b.t || Number(b.video) - Number(a.video))
  const duration = round(runs.filter((r) => r.video).reduce((max, r) => Math.max(max, r.end), 0))

  const header = joinedHeader(video.init, audio?.init, duration)
  const parts = [{ at: 0, len: header.length, buf: header, patches: [] }]
  const fragments = []
  let at = header.length
  let seq = 1
  for (const r of runs) {
    const { f } = r
    const patches = []
    // The two tracks each count their fragments from 1: the joined file counts them once.
    if (f.seqAt >= 0) patches.push({ at: f.seqAt, bytes: u32(seq++) })
    if (!r.video) for (const idAt of f.idAts) patches.push({ at: idAt, bytes: u32(2) })
    parts.push({ at, len: f.size, file: f.file, from: f.at, patches })
    fragments.push({ t: round(r.t), offset: at, size: f.size, key: r.video, video: r.video })
    at += f.size
  }
  const codecs = [videoCodec, audio ? audioCodec : null].filter(Boolean).join(',')
  return {
    size: at,
    type: 'video/mp4',
    parts,
    cache: kept,
    index: { codecs, duration, base: round(zero), init: { offset: 0, size: header.length }, fragments },
  }
}

/** One file as it is. */
async function fileLayout(file, type) {
  const { size } = await fsp.stat(file)
  return { size, type, parts: [{ at: 0, len: size, file, from: 0, patches: [] }], index: null }
}

/**
 * The joined file of a recording, made once for its id and kept. A recording Steam still
 * writes is not joined again under a page that plays it: every byte would move. The next
 * look gives it a new id, and a new join with the newest chunks.
 */
async function layoutOf(entry) {
  if (entry.kind === 'file') return fileLayout(entry.file, entry.type)
  if (entry.layout) return entry.layout
  entry.building ??= joinSteam(entry.dir, { videoCodec: entry.videoCodec, audioCodec: entry.audioCodec })
    .then((layout) => {
      entry.layout = layout
      return layout
    })
    .finally(() => {
      entry.building = null
    })
  return entry.building
}

/** Where each fragment of a Steam recording is in its joined file. Null for a plain file or an unknown id. */
async function index(id) {
  const entry = current.get(id)
  if (!entry || entry.kind === 'file') return null
  try {
    return (await layoutOf(entry)).index
  } catch {
    return null
  }
}

/** The bytes from `start` up to `end` of a layout, with its changes made. */
async function readRange(layout, start, end) {
  end = Math.min(end, layout.size)
  const out = Buffer.alloc(Math.max(0, end - start))
  if (!out.length) return out
  const parts = layout.parts
  let lo = 0
  let hi = parts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (parts[mid].at <= start) lo = mid
    else hi = mid - 1
  }
  const open = new Map()
  try {
    for (let i = lo; i < parts.length && parts[i].at < end; i++) {
      const part = parts[i]
      const a = Math.max(start, part.at)
      const b = Math.min(end, part.at + part.len)
      if (a >= b) continue
      if (part.buf) part.buf.copy(out, a - start, a - part.at, b - part.at)
      else {
        let fh = open.get(part.file)
        if (!fh) {
          fh = await fsp.open(part.file, 'r')
          open.set(part.file, fh)
        }
        await readFull(fh, out, a - start, b - a, part.from + (a - part.at))
      }
      for (const patch of part.patches) {
        const pa = part.at + patch.at
        const x = Math.max(a, pa)
        const y = Math.min(b, pa + patch.bytes.length)
        if (x < y) patch.bytes.copy(out, x - start, x - pa, y - pa)
      }
    }
  } finally {
    for (const fh of open.values()) await fh.close().catch(() => {})
  }
  return out
}

/** "bytes=a-b", "bytes=a-" or "bytes=-n" as { start, end } with `end` not in it, or null. */
function parseRange(text, total) {
  const hit = /^bytes=(\d*)-(\d*)$/.exec(text.split(',')[0].trim())
  if (!hit || (!hit[1] && !hit[2])) return null
  let start
  let end
  if (!hit[1]) {
    start = Math.max(0, total - Number(hit[2]))
    end = total
  } else {
    start = Number(hit[1])
    end = hit[2] ? Math.min(total, Number(hit[2]) + 1) : Math.min(total, start + OPEN_RANGE_MAX)
  }
  if (start >= total || end <= start) return null
  return { start, end }
}

function bodyStream(layout, start, end) {
  // One plain file, with nothing patched: the disk is read ahead as the page takes it, which is much
  // quicker for a recording of gigabytes than a read and a new buffer for each piece.
  const only = layout.parts.length === 1 ? layout.parts[0] : null
  if (only && only.file && !only.buf && only.patches.length === 0 && only.from === 0) {
    return Readable.toWeb(fs.createReadStream(only.file, { start, end: end - 1, highWaterMark: 4 * 1024 * 1024 }))
  }
  let at = start
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = Math.min(end, at + STEP)
        controller.enqueue(await readRange(layout, at, next))
        at = next
        if (at >= end) controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

/**
 * Answers a nook-rec:// request: nook-rec://media/<id> is the recording, and
 * nook-rec://thumb/<id> is its picture. `isHome` says which pages may read them with fetch.
 */
async function respond(request, { isHome = () => false } = {}) {
  const origin = request.headers.get('origin')
  const cors =
    origin && isHome(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges', Vary: 'Origin' }
      : {}
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...cors, 'Access-Control-Allow-Headers': 'range', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' },
    })
  }
  const missing = () => new Response(null, { status: 404, headers: { ...cors, 'Cache-Control': 'no-store' } })
  let url
  try {
    url = new URL(request.url)
  } catch {
    return missing()
  }
  const entry = current.get(url.pathname.replace(/^\/+/, ''))
  if (!entry) return missing()
  let layout = null
  try {
    if (url.hostname === 'media') layout = await layoutOf(entry)
    else if (url.hostname === 'thumb' && entry.thumb) layout = await fileLayout(entry.thumb, 'image/jpeg')
  } catch {
    layout = null
  }
  if (!layout) return missing()

  const total = layout.size
  const headers = { ...cors, 'Accept-Ranges': 'bytes', 'Content-Type': layout.type, 'Cache-Control': 'no-store' }
  let start = 0
  let end = total
  let status = 200
  const asked = request.headers.get('range')
  if (asked) {
    const range = parseRange(asked, total)
    if (!range) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${total}` } })
    start = range.start
    end = range.end
    status = 206
    headers['Content-Range'] = `bytes ${start}-${end - 1}/${total}`
  }
  headers['Content-Length'] = String(end - start)
  if (request.method === 'HEAD' || end === start) return new Response(null, { status, headers })
  return new Response(bodyStream(layout, start, end), { status, headers })
}

module.exports = {
  folders,
  addFolder,
  removeFolder,
  restoreFolders,
  list,
  index,
  place,
  plainFile,
  respond,
  // For the tests: the parts that need no list.
  joinSteam,
  readRange,
  parseRange,
  looksSteam,
}
