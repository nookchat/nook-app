// Finds the song Spotify plays on this computer, so the app can say what you
// listen to, the way Discord does. No account and no login: it asks the Spotify
// app on this computer. On macOS through AppleScript, on Windows from the title
// of Spotify's window, and on Linux through playerctl. Only the song goes to the
// page, and only while the page asks for it.

const { execFile } = require('node:child_process')

const POLL_MS = 5000
/** A position this far from where the song should be is a jump: the others are told. */
const JUMP_MS = 4000

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)))
  })
}

const TRACK = /^spotify:track:([A-Za-z0-9]{22})$/
const ART = /^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/

function number(text) {
  const n = Number(text)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
}

/** A song, with only the parts that are there. */
function song({ title, artist, album, uri, duration, position, art }) {
  title = (title ?? '').trim()
  if (!title) return null
  const out = { title, artist: (artist ?? '').trim() }
  if (album?.trim()) out.album = album.trim()
  const track = TRACK.exec((uri ?? '').trim())?.[1]
  if (track) out.track = track
  if (duration) out.duration = duration
  if (position !== undefined) out.position = position
  if (ART.test((art ?? '').trim())) out.art = art.trim()
  return out
}

// Spotify by its bundle id, so a Mac without it is never asked where it is.
const MAC_SCRIPT = `
tell application id "com.spotify.client"
  if player state is not playing then return ""
  set t to current track
  set a to ""
  try
    set a to artwork url of t
  end try
  return (name of t) & tab & (artist of t) & tab & (album of t) & tab & (id of t) & tab & (duration of t) & tab & (round (player position * 1000)) & tab & a
end tell`

/** What `MAC_SCRIPT` answers: seven fields, a tab between each. */
function parseMac(out) {
  const [title, artist, album, uri, duration, position, art] = out.replace(/\r?\n$/, '').split('\t')
  if (!title || uri === undefined) return null
  return song({ title, artist, album, uri, duration: number(duration), position: number(position), art })
}

/**
 * Spotify's window says "Artist - Song" while it plays, and "Spotify", "Spotify Free" or
 * "Spotify Premium" when it does not. The song's own name may hold " - ", the artist's rarely.
 */
function parseWindowsTitle(title) {
  const text = (title ?? '').trim()
  if (!text || /^(spotify( free| premium)?|advertisement|n\/a)$/i.test(text)) return null
  const cut = text.indexOf(' - ')
  if (cut <= 0) return null
  return song({ artist: text.slice(0, cut), title: text.slice(cut + 3) })
}

/** tasklist's CSV: the window title is the last field of each Spotify row. Several rows: one has the title. */
function parseTasklist(out) {
  for (const row of out.split(/\r?\n/)) {
    const fields = [...row.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'))
    if (!/^spotify\.exe$/i.test(fields[0] ?? '')) continue
    const found = parseWindowsTitle(fields.at(-1))
    if (found) return found
  }
  return null
}

/** What playerctl answers for the format below. Lengths are in microseconds. */
function parseLinux(status, out) {
  if (status.trim() !== 'Playing') return null
  const [title, artist, album, uri, length, position, art] = out.replace(/\r?\n$/, '').split('\t')
  const ms = (text) => (number(text) === undefined ? undefined : Math.round(number(text) / 1000))
  // playerctl gives the track as /com/spotify/track/<id>.
  const id = /\/track\/([A-Za-z0-9]{22})$/.exec(uri ?? '')?.[1]
  return song({ title, artist, album, uri: id ? `spotify:track:${id}` : uri, duration: ms(length), position: ms(position), art: (art ?? '').replace('https://open.spotify.com/image/', 'https://i.scdn.co/image/') })
}

async function read() {
  if (process.platform === 'darwin') {
    if (!(await run('pgrep', ['-x', 'Spotify'])).trim()) return null
    return parseMac(await run('osascript', ['-e', MAC_SCRIPT]))
  }
  if (process.platform === 'win32') {
    return parseTasklist(await run('tasklist', ['/v', '/fo', 'csv', '/nh', '/fi', 'imagename eq Spotify.exe']))
  }
  const status = await run('playerctl', ['-p', 'spotify', 'status'])
  if (status.trim() !== 'Playing') return null
  const out = await run('playerctl', [
    '-p',
    'spotify',
    'metadata',
    '--format',
    '{{xesam:title}}\t{{xesam:artist}}\t{{xesam:album}}\t{{mpris:trackid}}\t{{mpris:length}}\t{{position}}\t{{mpris:artUrl}}',
  ])
  return parseLinux(status, out)
}

/** The same song, at about the place it should have got to by now. */
function sameSong(was, next, now) {
  if (!was || !next || was.title !== next.title || was.artist !== next.artist) return false
  if (was.position === undefined || next.position === undefined) return true
  const expected = was.position + (now - was.at)
  return Math.abs(next.position - expected) < JUMP_MS
}

/** Looks every few seconds and calls `onChange` with { title, artist, album?, track?, art?, duration?, position?, at } or null. */
function watchSpotify(onChange) {
  let now = null
  let stopped = false
  let timer = null

  const look = async () => {
    const found = await read().catch(() => null)
    if (stopped) return
    const at = Date.now()
    if (!sameSong(now, found, at) || (now === null) !== (found === null)) {
      now = found ? { ...found, at } : null
      onChange(now)
    }
    timer = setTimeout(look, POLL_MS)
  }
  void look()

  return {
    now: () => now,
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      const was = now
      now = null
      if (was) onChange(null)
    },
  }
}

module.exports = { parseMac, parseTasklist, parseWindowsTitle, parseLinux, sameSong, watchSpotify }
