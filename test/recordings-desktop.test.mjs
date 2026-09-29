// The desktop app's game recordings, without Electron: ffmpeg makes a Steam
// folder and an NVIDIA video, and the checks list them, join a Steam recording
// into one MP4 and read it back through the nook-rec:// answers.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const recordings = require('../desktop/recordings.cjs')

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', 'ffmpeg'].find((f) => spawnSync(f, ['-version']).status === 0)
const FFPROBE = FFMPEG && FFMPEG.replace(/ffmpeg$/, 'ffprobe')
if (!FFMPEG) {
  console.log('No ffmpeg on this computer, so the recordings checks did not run.')
  process.exit(0)
}

// check() and finish() as in harness.mjs, which starts a browser library on import.
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
function finish() {
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed || process.exitCode ? 1 : 0)
}

const near = (a, b, by = 0.5) => typeof a === 'number' && Math.abs(a - b) <= by

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nook-recordings-'))
const home = path.join(tmp, 'home')
const steam = path.join(home, 'Library', 'Application Support', 'Steam')
const records = path.join(steam, 'userdata', '12345', 'gamerecordings')
const clipDir = path.join(records, 'clips', 'clip_730_20260929_201500')
const clipSession = path.join(clipDir, 'video', 'bg_730_20260929_201430')
const bgSession = path.join(records, 'video', 'bg_570_20260929_190000')
const videos = path.join(tmp, 'Videos')
const nvidiaFile = path.join(videos, 'Counter-Strike 2', 'Counter-Strike 2 2026.09.29 - 20.15.00.02.DVR.mp4')
const library = path.join(tmp, 'library')

function ffmpeg(args, cwd) {
  execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
}

function dash(dir, seconds) {
  fs.mkdirSync(dir, { recursive: true })
  ffmpeg(
    [
      ...['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
      ...['-t', String(seconds), '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k'],
      ...['-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '0', 'session.mpd'],
    ],
    dir,
  )
}

function probe(file) {
  const out = execFileSync(FFPROBE, [
    ...['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-show_entries', 'format=duration', '-of', 'json'],
    file,
  ])
  return JSON.parse(String(out))
}

function decodeErrors(file) {
  const run = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' })
  return run.status === 0 ? run.stderr.trim() : `exit ${run.status}: ${run.stderr.trim()}`
}

const get = (id, range, { method = 'GET', origin } = {}) =>
  recordings.respond(
    new Request(`nook-rec://media/${id}`, {
      method,
      headers: { ...(range ? { range } : {}), ...(origin ? { origin } : {}) },
    }),
    { isHome: (url) => url === 'https://cathode.video' },
  )

/** Reads the whole joined file through the nook-rec:// answers, in odd steps. */
async function readAll(id, total, step) {
  const out = fs.openSync(path.join(tmp, `${id}.mp4`), 'w')
  let ranges = 0
  let bad = ''
  for (let at = 0; at < total; at += step) {
    const last = Math.min(total, at + step) - 1
    const res = await get(id, `bytes=${at}-${last}`)
    const body = Buffer.from(await res.arrayBuffer())
    if (res.status !== 206 || body.length !== last - at + 1 || res.headers.get('content-range') !== `bytes ${at}-${last}/${total}`) {
      bad ||= `${res.status} ${res.headers.get('content-range')} ${body.length}`
    }
    fs.writeSync(out, body)
    ranges++
  }
  fs.closeSync(out)
  return { file: path.join(tmp, `${id}.mp4`), ranges, bad }
}

function checkIndex(name, index, seconds) {
  const frags = index?.fragments ?? []
  check(`${name}: the index has fragments`, frags.length > 0, `${frags.length}`)
  check(`${name}: the index codecs`, index?.codecs === 'avc1.640020,mp4a.40.2', index?.codecs)
  check(`${name}: the index duration`, near(index?.duration, seconds, 0.2), `${index?.duration}`)
  check(`${name}: the first fragment is at 0`, frags[0]?.t === 0 && frags[0]?.video, JSON.stringify(frags[0]))
  check(`${name}: the fragments are in time order`, frags.every((f, i) => i === 0 || frags[i - 1].t <= f.t))
  let at = index?.init.size
  const contiguous = frags.every((f) => {
    const ok = f.offset === at
    at += f.size
    return ok
  })
  check(`${name}: the fragments follow the header with no gap`, index?.init.offset === 0 && contiguous)
  const keys = frags.filter((f) => f.key).map((f) => f.t)
  const gaps = keys.slice(1).map((t, i) => t - keys[i])
  check(`${name}: a key video fragment every 2 s`, keys.length >= seconds / 2 - 1 && gaps.every((g) => near(g, 2, 0.1)), keys.join(' '))
  check(`${name}: key means video`, frags.every((f) => f.key === f.video))
  check(`${name}: both tracks are in it`, frags.some((f) => !f.video))
  return at
}

try {
  // A Steam folder with a clip and a background recording, and the names of their games.
  dash(clipSession, 12)
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180', '-frames:v', '1', path.join(clipDir, 'thumbnail.jpg')])
  dash(bgSession, 8)
  fs.mkdirSync(path.join(steam, 'steamapps'), { recursive: true })
  fs.mkdirSync(path.join(library, 'steamapps'), { recursive: true })
  fs.writeFileSync(
    path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${library}"\n\t}\n}\n`,
  )
  fs.writeFileSync(path.join(steam, 'steamapps', 'appmanifest_730.acf'), '"AppState"\n{\n\t"appid"\t\t"730"\n\t"name"\t\t"Counter-Strike 2"\n}\n')
  fs.writeFileSync(path.join(library, 'steamapps', 'appmanifest_570.acf'), '"AppState"\n{\n\t"appid"\t\t"570"\n\t"name"\t\t"Dota 2"\n}\n')
  // The account's settings name the same folder again: it must be listed once.
  fs.mkdirSync(path.join(steam, 'userdata', '12345', 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(steam, 'userdata', '12345', 'config', 'localconfig.vdf'),
    `"UserLocalConfigStore"\n{\n\t"BackgroundRecordPath"\t\t"${records.replace(/\\/g, '\\\\')}"\n}\n`,
  )
  // An NVIDIA video in the videos folder.
  fs.mkdirSync(path.dirname(nvidiaFile), { recursive: true })
  ffmpeg(
    ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', nvidiaFile],
    tmp,
  )

  const opts = { file: path.join(tmp, 'userData', 'recordings.json'), videos, home, platform: 'darwin' }

  // Folders
  const found = await recordings.folders(opts)
  check(
    'the Steam folder and the videos folder are found, once each',
    found.length === 2 && found[0].kind === 'steam' && found[0].path === records && found[1].kind === 'videos',
    JSON.stringify(found.map((f) => [f.kind, f.label, f.found, f.exists])),
  )
  check('a found folder says it is there', found.every((f) => f.found && f.exists))
  const afterRemove = await recordings.removeFolder(opts, videos)
  check('a removed found folder is hidden', afterRemove.length === 1 && afterRemove[0].kind === 'steam')
  const afterRestore = await recordings.restoreFolders(opts)
  check('restore shows the hidden folder again', afterRestore.length === 2)
  const extra = path.join(tmp, 'Extra')
  fs.mkdirSync(extra)
  const afterAdd = await recordings.addFolder(opts, extra)
  const added = afterAdd.find((f) => f.path === extra)
  check('an added folder is in the list', added?.kind === 'folder' && added.label === 'Extra' && added.found === false, JSON.stringify(added))
  check('a Steam folder is known by what is in it', await recordings.looksSteam(records))
  check('a clips folder is known as Steam too', await recordings.looksSteam(path.join(records, 'clips')))
  check('a plain folder is not Steam', !(await recordings.looksSteam(videos)))
  const afterDrop = await recordings.removeFolder(opts, extra)
  check('a removed added folder goes', afterDrop.length === 2 && !afterDrop.some((f) => f.path === extra))
  check('the folders are kept in recordings.json', JSON.parse(fs.readFileSync(opts.file, 'utf8')).hidden.length === 0)

  // The list
  const items = await recordings.list(opts)
  const clip = items.find((i) => i.kind === 'steam-clip')
  const bg = items.find((i) => i.kind === 'steam-background')
  const file = items.find((i) => i.kind === 'file')
  check('three recordings are listed', items.length === 3, JSON.stringify(items.map((i) => i.kind)))
  check('newest first', items.every((it, i) => i === 0 || items[i - 1].at >= it.at), items.map((i) => i.title).join(', '))
  check('the clip has its game name', clip?.title === 'Counter-Strike 2' && clip.game === 'Counter-Strike 2' && clip.appId === 730, clip?.title)
  check('the clip time is the folder name in local time', clip?.at === new Date(2026, 8, 29, 20, 15, 0).getTime())
  check('the clip lasts 12 s', near(clip?.duration, 12), `${clip?.duration}`)
  check('the clip size, codecs and picture size', clip?.size > 1e6 && clip.codecs === 'avc1.640020,mp4a.40.2' && clip.width === 1280 && clip.height === 720)
  check('the clip has a thumb', clip?.thumb === `nook-rec://thumb/${clip?.id}` && clip.url === `nook-rec://media/${clip?.id}`)
  check('the clip id is 16 hex characters', /^[0-9a-f]{16}$/.test(clip?.id ?? ''))
  check('the background recording is named from the second library', bg?.title === 'Dota 2' && bg.appId === 570, bg?.title)
  check('the background recording lasts 8 s', near(bg?.duration, 8), `${bg?.duration}`)
  check('the background recording is live, as its chunks are new', bg?.live === true)
  check('the background recording has no thumb', bg && !('thumb' in bg))
  check(
    'the NVIDIA video',
    file?.title === 'Counter-Strike 2 2026.09.29 - 20.15.00.02.DVR' && file.game === 'Counter-Strike 2' && file.source === 'NVIDIA' && file.type === 'video/mp4',
    JSON.stringify(file),
  )
  check('the NVIDIA video lasts 3 s', near(file?.duration, 3), `${file?.duration}`)
  check('no real path of a recording goes to the page', !JSON.stringify(items).includes('bg_') && !JSON.stringify(items).includes('.mp4"'))
  check('the Steam items come from the Steam folder', clip?.folder === records && bg?.folder === records && file?.folder === videos)

  // The joined clip
  const index = await recordings.index(clip.id)
  const total = checkIndex('clip', index, 12)
  check('the index base is where zero is in the file', index?.base === 0, `${index?.base}`)
  const head = await get(clip.id, null, { method: 'HEAD' })
  check('HEAD gives the whole size', head.status === 200 && Number(head.headers.get('content-length')) === total && head.headers.get('accept-ranges') === 'bytes')
  check('the type is video/mp4 and it is not cached', head.headers.get('content-type') === 'video/mp4' && head.headers.get('cache-control') === 'no-store')
  const { file: joined, ranges, bad } = await readAll(clip.id, total, 777777)
  check('every range answers 206 with its Content-Range', !bad, bad || `${ranges} ranges`)
  const probed = probe(joined)
  const kinds = probed.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort()
  check('ffprobe finds one h264 video and one aac sound', kinds.join(' ') === 'audio:aac video:h264', kinds.join(' '))
  check('ffprobe finds 12 s', near(Number(probed.format.duration), 12, 0.3), probed.format.duration)
  const errors = decodeErrors(joined)
  check('ffmpeg decodes it all with no error', !errors, errors.slice(0, 300))

  // The nook-rec:// answers
  const open = await get(clip.id, 'bytes=0-')
  const openBody = Buffer.from(await open.arrayBuffer())
  check(
    'an open range gets at most 8 MiB',
    open.status === 206 && openBody.length === Math.min(total, 8 * 1024 * 1024) && open.headers.get('content-range') === `bytes 0-${openBody.length - 1}/${total}`,
    open.headers.get('content-range'),
  )
  const tail = await get(clip.id, 'bytes=-100')
  check('a suffix range gets the last bytes', tail.status === 206 && (await tail.arrayBuffer()).byteLength === 100)
  const wrong = await get(clip.id, `bytes=${total}-`)
  check('a range past the end is 416', wrong.status === 416 && wrong.headers.get('content-range') === `bytes */${total}`)
  const whole = await get(clip.id)
  const wholeBody = Buffer.from(await whole.arrayBuffer())
  check('no range gets the whole file', whole.status === 200 && wholeBody.equals(fs.readFileSync(joined)))
  const cors = await get(clip.id, 'bytes=0-9', { origin: 'https://cathode.video' })
  check(
    'the home page may read it with fetch',
    cors.headers.get('access-control-allow-origin') === 'https://cathode.video' && /Content-Range/.test(cors.headers.get('access-control-expose-headers')),
  )
  const other = await get(clip.id, 'bytes=0-9', { origin: 'https://example.com' })
  check('another page may not', other.headers.get('access-control-allow-origin') === null)
  const pre = await get(clip.id, null, { method: 'OPTIONS', origin: 'https://cathode.video' })
  check('OPTIONS answers 204 with the allowed headers', pre.status === 204 && pre.headers.get('access-control-allow-headers') === 'range')
  const thumb = await recordings.respond(new Request(`nook-rec://thumb/${clip.id}`))
  const thumbBody = Buffer.from(await thumb.arrayBuffer())
  check('the thumb is the JPEG', thumb.status === 200 && thumb.headers.get('content-type') === 'image/jpeg' && thumbBody[0] === 0xff && thumbBody[1] === 0xd8)
  const nothing = await recordings.respond(new Request('nook-rec://media/0123456789abcdef'))
  check('an unknown id is 404', nothing.status === 404)
  const noThumb = await recordings.respond(new Request(`nook-rec://thumb/${bg.id}`))
  check('a thumb that is not there is 404', noThumb.status === 404)
  const plain = await get(file.id, 'bytes=0-99')
  check(
    'a plain file answers from its own bytes',
    plain.status === 206 && Buffer.from(await plain.arrayBuffer()).equals(fs.readFileSync(nvidiaFile).subarray(0, 100)),
  )
  check('a plain file has no index', (await recordings.index(file.id)) === null)
  check('show gives the clip folder, and the file', recordings.place(clip.id) === clipDir && recordings.place(file.id) === nvidiaFile)

  // The background recording, whole, then with its oldest chunks gone as Steam's ring buffer does
  const bgIndex = await recordings.index(bg.id)
  checkIndex('background', bgIndex, 8)
  for (const name of ['chunk-stream0-00001.m4s', 'chunk-stream1-00001.m4s']) fs.rmSync(path.join(bgSession, name))
  fs.writeFileSync(path.join(bgSession, 'chunk-stream0-00009.m4s.tmp'), 'still being written')
  const again = await recordings.list(opts)
  check('an id from an older list finds nothing', (await recordings.index(bg.id)) === null)
  const bg2 = again.find((i) => i.kind === 'steam-background')
  const cutIndex = await recordings.index(bg2.id)
  checkIndex('cut background', cutIndex, 6)
  check('the cut background says where zero is', near(cutIndex?.base, 2, 0.05), `${cutIndex?.base}`)
  const cut = await readAll(bg2.id, cutIndex.init.size + cutIndex.fragments.reduce((n, f) => n + f.size, 0), 1_000_003)
  const cutProbe = probe(cut.file)
  check('the cut background is h264 and aac', cutProbe.streams.map((s) => s.codec_name).sort().join(' ') === 'aac h264')
  // The fragments keep their own times, so the file ends at 8 s and starts at `base`.
  check('the cut background ends at 8 s in its own time', near(Number(cutProbe.format.duration), 8, 0.3), cutProbe.format.duration)
  const cutErrors = decodeErrors(cut.file)
  check('the cut background decodes with no error', !cutErrors, cutErrors.slice(0, 300))
} catch (err) {
  console.error('\nThe run stopped early:', err?.stack ?? err)
  process.exitCode = 1
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

finish()
