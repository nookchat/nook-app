import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_URL, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

// Your recordings, and a clip of one. The desktop app is not here, so a stand-in plays its part:
// window.nookDesktop.recordings lists the videos ffmpeg makes, and the page reads them from an
// address that answers ranges, as the app's nook-rec:// one does. The clip is cut as it is when
// it fits, made smaller when it does not, and made H.264 when it is HEVC.

const dir = mkdtempSync(join(tmpdir(), 'nook-recordings-'))
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: dir })
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch {
  console.log('ffmpeg is not here, so there is nothing to record. Skipped.')
  process.exit(0)
}

const MOVING = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']
ffmpeg(...MOVING, '-t', '40', '-c:v', 'libx264', '-g', '60', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', 'plain.mp4')
ffmpeg(...MOVING, '-t', '12', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'hevc.mp4')

// A Steam background recording, as Steam keeps it: pieces, the picture and the sound apart.
// Its first pieces are gone, as Steam lets the oldest go, so it starts four seconds in.
const steamDir = join(dir, 'gamerecordings', 'video', 'bg_730_20260929_201500')
mkdirSync(steamDir, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', ...MOVING, '-t', '20', '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
  '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '0', 'session.mpd'], { cwd: steamDir })
for (const n of ['00001', '00002']) for (const s of [0, 1]) rmSync(join(steamDir, `chunk-stream${s}-${n}.m4s`))
const desktop = createRequire(import.meta.url)('../desktop/recordings.cjs')
const steam = await desktop.joinSteam(steamDir, { videoCodec: 'avc1.640020', audioCodec: 'mp4a.40.2' })

const files = {
  plain: { path: join(dir, 'plain.mp4'), type: 'video/mp4' },
  hevc: { path: join(dir, 'hevc.mp4'), type: 'video/mp4' },
}
const FAKE = 'https://nook-rec.test/media/'
const now = Date.now()
const items = [
  {
    id: 'plain',
    kind: 'file',
    title: 'Counter-Strike 2 2026.09.29 - 20.15.00.02.DVR',
    game: 'Counter-Strike 2',
    source: 'NVIDIA',
    folder: '/Videos',
    at: now - 60_000,
    duration: 40,
    size: statSync(files.plain.path).size,
    type: 'video/mp4',
    url: `${FAKE}plain`,
  },
  {
    id: 'steam',
    kind: 'steam-background',
    title: 'Counter-Strike 2',
    game: 'Counter-Strike 2',
    appId: 730,
    source: 'Steam',
    folder: '/Steam',
    at: now - 30_000,
    duration: 20,
    size: steam.size,
    type: 'video/mp4',
    url: `${FAKE}steam`,
    codecs: 'avc1.640020,mp4a.40.2',
  },
  {
    id: 'hevc',
    kind: 'file',
    title: 'hevc',
    source: 'Videos',
    folder: '/Videos',
    at: now - 3_600_000,
    duration: 12,
    size: statSync(files.hevc.path).size,
    type: 'video/mp4',
    url: `${FAKE}hevc`,
  },
]

/** The desktop app's range answers, for the page's fetches and its video element. */
async function serveRecordings(page) {
  await page.route(`${FAKE}**`, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()
    const file = id === 'steam' ? { type: 'video/mp4' } : files[id]
    if (!file) return route.fulfill({ status: 404 })
    const bytes = id === 'steam' ? await desktop.readRange(steam, 0, steam.size) : readFileSync(file.path)
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range, content-length, accept-ranges' }
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': 'range' } })
    }
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '')
    if (!range) {
      return route.fulfill({ status: 200, body: bytes, headers: { ...cors, 'content-type': file.type, 'accept-ranges': 'bytes' } })
    }
    const from = Number(range[1])
    const to = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
    return route.fulfill({
      status: 206,
      body: bytes.subarray(from, to + 1),
      headers: { ...cors, 'content-type': file.type, 'accept-ranges': 'bytes', 'content-range': `bytes ${from}-${to}/${bytes.length}` },
    })
  })
  await page.addInitScript(({ list, index }) => {
    window.nookDesktop = {
      platform: 'darwin',
      // A desktop app that is up to date, so no popup offers a new one.
      onUpdate: () => () => undefined,
      installUpdate: () => undefined,
      checkUpdate: async () => ({ state: 'newest' }),
      recordings: {
        folders: async () => [{ path: '/Videos', label: 'Videos', kind: 'videos', found: true, exists: true }],
        addFolder: async () => null,
        removeFolder: async () => [],
        restoreFolders: async () => [],
        list: async () => list,
        index: async (id) => (id === 'steam' ? index : null),
        show: () => undefined,
      },
    }
  }, { list: items, index: steam.index })
}

/** What a clip holds, read back with mediabunny in the page. */
const readClip = (page, handle) =>
  page.evaluate(async (file) => {
    const mb = await import('/node_modules/mediabunny/dist/bundles/mediabunny.mjs')
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
    const video = await input.getPrimaryVideoTrack()
    const audio = await input.getPrimaryAudioTrack()
    return {
      duration: await input.computeDuration(),
      video: video?.codec ?? null,
      audio: audio?.codec ?? null,
      width: video ? await video.getDisplayWidth() : 0,
      size: file.size,
      type: file.type,
      name: file.name,
    }
  }, handle)

const browser = await launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  await serveRecordings(page)
  await page.goto(APP_URL)
  await page.waitForSelector('input[aria-label="Space name"]')
  await page.fill('input[aria-label="Space name"]', 'clips')
  await page.click('button:has-text("New space")')
  await page.waitForSelector('.space-name')

  // The clip maker on its own, first.
  const made = async (id, start, end, max) =>
    page.evaluateHandle(
      async ({ item, start, end, max }) => {
        const { makeClip } = await import('/src/media/clip.ts')
        return makeClip({ url: item.url, title: item.game || item.title, size: item.size, duration: item.duration, at: item.at }, { start, end }, { max })
      },
      { item: items.find((i) => i.id === id), start, end, max },
    )
  const copied = await readClip(page, await made('plain', 10, 20, 100 * 1024 * 1024))
  check('a part that fits is cut as it is', copied.video === 'avc' && copied.audio === 'aac' && copied.width === 1280, JSON.stringify(copied))
  check('and is as long as the part', Math.abs(copied.duration - 10) < 1.2, `${copied.duration.toFixed(2)} s`)
  check('named for the game', copied.name.startsWith('Counter-Strike 2 ') && copied.name.endsWith('.mp4'), copied.name)

  const small = await readClip(page, await made('plain', 0, 30, 6 * 1024 * 1024))
  check('a part too big for the server is made smaller, and fits', small.size <= 6 * 1024 * 1024 && small.video === 'avc', `${(small.size / 1024 / 1024).toFixed(1)} MB`)
  check('and keeps its length and its sound', Math.abs(small.duration - 30) < 1.2 && small.audio === 'aac', `${small.duration.toFixed(2)} s`)

  const refused = await page.evaluate(async (item) => {
    const { makeClip } = await import('/src/media/clip.ts')
    try {
      await makeClip({ url: item.url, title: 'x', size: item.size, duration: item.duration, at: item.at }, { start: 0, end: 40 }, { max: 1024 * 1024 })
      return ''
    } catch (err) {
      return err.message
    }
  }, items[0])
  check('a part no clip of which fits says how long it can be', /seconds or less/.test(refused), refused)

  const fromHevc = await readClip(page, await made('hevc', 2, 8, 100 * 1024 * 1024)).catch((err) => ({ error: String(err) }))
  if (fromHevc.error) console.log(`  (this browser cannot make a clip of HEVC: ${fromHevc.error})`)
  else check('HEVC comes out as H.264, which every browser plays', fromHevc.video === 'avc', JSON.stringify(fromHevc))

  // The dialog, from the clip button in the message box.
  const button = page.locator('button[aria-label="Share a clip from your recordings"]')
  await button.waitFor({ timeout: 10_000 })
  check('the desktop app has a clip button in the message box', await button.isVisible())
  await button.click()
  await page.waitForSelector('.recording-card')
  check('the dialog lists the recordings, newest first', (await page.locator('.recording-title').allTextContents()).join('|') === 'Counter-Strike 2|Counter-Strike 2|hevc')
  check('with a filter for each source', (await page.locator('.recordings-filters .chip-toggle').allTextContents()).join('|') === 'All|NVIDIA|Steam|Videos')
  await page.screenshot({ path: 'test-output/recordings-list.png' })

  await page.locator('.recording-card').first().click()
  await page.waitForSelector('.clip-editor')
  const loaded = await poll(() => page.evaluate(() => document.querySelector('.clip-video')?.readyState >= 1), 10_000)
  check('a recording opens in the clip editor, and plays', loaded)
  const about = () => page.locator('.clip-about').textContent()
  check('a short one starts as all of it', /Clip 0:00 to 0:40 · 0:40/.test(await about()), await about())
  // The end, three presses to the left with Shift: fifteen seconds earlier.
  await page.locator('.clip-handle.end').focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft')
  check('the keys move an end', /Clip 0:00 to 0:25 · 0:25/.test(await about()), await about())
  await page.locator('.clip-handle.start').focus()
  await page.keyboard.press('End')
  check('the two ends never cross', /Clip 0:24 to 0:25 · 0:01/.test(await about()), await about())
  await page.keyboard.press('Home')
  await page.screenshot({ path: 'test-output/recordings-clip.png' })

  await page.click('.clip-editor button:has-text("Add to message")')
  await page.waitForSelector('.attach-chip', { timeout: 30_000 })
  check('Add to message puts the clip in the message box', (await page.locator('.attach-chip .attach-name').textContent()).endsWith('.mp4'))
  check('and closes the dialog', (await page.locator('.recordings-modal').count()) === 0)
  const sent = await poll(() => page.evaluate(() => document.querySelector('.attach-chip.done') !== null), 30_000)
  check('the clip goes up to the server', sent)
  await page.click('button[aria-label="Send"]')
  const said = await poll(
    () => page.evaluate(() => document.querySelector('.chat-log .att-video .att-meta span')?.textContent ?? null),
    20_000,
  )
  check('and is in the conversation as a video, as long as the part', said === '0:25', `${said}`)

  // A Steam recording: pieces, played a piece at a time, from four seconds in.
  const base = steam.index.base
  check('the joined Steam file says where it starts', Math.abs(base - 4) < 0.05 && Math.abs(steam.index.duration - 16) < 0.1, `${base} ${steam.index.duration}`)
  const fromSteam = await readClip(page, await made('steam', base + 2, base + 7, 100 * 1024 * 1024))
  check('a clip of a Steam recording has its picture and its sound', fromSteam.video === 'avc' && fromSteam.audio === 'aac', JSON.stringify(fromSteam))
  check('and is as long as the part', Math.abs(fromSteam.duration - 5) < 1.2, `${fromSteam.duration.toFixed(2)} s`)

  await button.click()
  await page.waitForSelector('.recording-card')
  await page.locator('.recording-card').nth(1).click()
  await page.waitForSelector('.clip-editor')
  const shows = await poll(() => page.evaluate(() => document.querySelector('.clip-video')?.readyState >= 2), 10_000)
  check('the Steam recording shows its picture, a piece at a time', shows)
  check('as long as its pieces', /0:00 \/ 0:16/.test(await page.locator('.clip-clock').textContent()), await page.locator('.clip-clock').textContent())
  await page.click('.clip-editor button[aria-label="Play the clip"]')
  const moved = await poll(() => page.evaluate((b) => document.querySelector('.clip-video').currentTime - b > 1, base), 10_000)
  check('and plays', moved)
  const track = await page.locator('.clip-track').boundingBox()
  await page.mouse.click(track.x + track.width * 0.75, track.y + track.height / 2)
  const there = await poll(
    () => page.evaluate((b) => {
      const v = document.querySelector('.clip-video')
      return v.readyState >= 2 && v.currentTime - b > 11.5 ? v.currentTime - b : null
    }, base),
    10_000,
  )
  check('a press on the track goes there, and the pieces for it come in', there, `${there}`)
  await page.screenshot({ path: 'test-output/recordings-steam.png' })
} catch (err) {
  stoppedEarly(err)
}

await browser.close()
finish()
