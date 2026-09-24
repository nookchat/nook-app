/**
 * Files: attached, sealed, kept, copied across the cluster, and opened.
 *
 * Alice drops a picture, a short video, a text file and one file too big for
 * the server onto the conversation, and sends them with a line of text. Bob
 * sees the picture, opens it full screen, plays the video and saves the text
 * file, and what he saves is what she sent. The server's copy is read off its
 * disk: none of it is readable. The second server of the cluster has every
 * file too, byte for byte.
 *
 * Starts two servers of its own; the page is the one test/stack.mjs serves.
 *
 *   node test/files-check.mjs
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { nameEveryone } from './named.mjs'
import { sql, startServer } from './pg.mjs'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const A = 'http://localhost:8797'
const B = 'http://localhost:8798'
const SECRET = 'nobody but Bob should ever read this sentence'
const MAX = 3 * 1024 * 1024

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOTS = new URL('../test-output/files/', import.meta.url).pathname
const { mkdirSync } = await import('node:fs')
mkdirSync(SHOTS, { recursive: true })
const shot = (page, name) => page.screenshot({ path: `${SHOTS}${name}.png` })
async function waitFor(work, ms, label) {
  const end = Date.now() + ms
  let last = null
  while (Date.now() < end) {
    last = await work().catch(() => null)
    if (last) return last
    await wait(300)
  }
  return null
}

const cluster = (self, peer) => ({
  CATHODE_PUBLIC_URL: self,
  CATHODE_PEERS: peer,
  CATHODE_CLUSTER_SECRET: 'files-check-cluster-secret',
  CATHODE_MAX_FILE_BYTES: String(MAX),
})
const a = await startServer(8797, cluster(A, B))
const b = await startServer(8798, cluster(B, A))
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--autoplay-policy=no-user-gesture-required'],
})
nameEveryone(browser)

async function person(name) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate(
    ({ n, server }) => {
      localStorage.setItem('cathode.name.v1', n)
      localStorage.setItem('cathode.server.v1', server)
      localStorage.setItem('cathode.servers.v1', JSON.stringify([server]))
    },
    { n: name, server: A },
  )
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

/** Every file a server holds on disk, by id. */
function onDisk(root) {
  const out = new Map()
  for (const room of readdirSync(root)) {
    if (room === 'incoming') continue
    for (const id of readdirSync(join(root, room))) out.set(id, readFileSync(join(root, room, id)))
  }
  return out
}

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'files')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('button[aria-label="Attach files"]:not(.hidden)', { timeout: 15_000 })
  check('the box offers a way to attach files', true)
  const link = alice.url()

  const bob = await person('Bob')
  await bob.goto(link)
  await bob.waitForFunction(() => document.querySelector('.space-name')?.textContent === 'files', null, {
    timeout: 20_000,
  })

  // A real picture: a screenshot of the page itself.
  const png = (await alice.screenshot()).toString('base64')

  // Drop four files on the conversation: a picture, a clip, some words, and one too big.
  await alice.evaluate(
    async ({ png, secret, big }) => {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 240
      const ctx = canvas.getContext('2d')
      const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' })
      const chunks = []
      recorder.ondataavailable = (e) => chunks.push(e.data)
      let frame = 0
      const paint = setInterval(() => {
        ctx.fillStyle = `hsl(${(frame * 12) % 360} 80% 50%)`
        ctx.fillRect(0, 0, 320, 240)
        ctx.fillStyle = '#fff'
        ctx.font = '40px sans-serif'
        ctx.fillText(String(frame++), 120, 140)
      }, 33)
      recorder.start()
      await new Promise((r) => setTimeout(r, 1600))
      recorder.stop()
      await new Promise((r) => (recorder.onstop = r))
      clearInterval(paint)

      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      const files = [
        new File([bytes], 'screen.png', { type: 'image/png' }),
        new File(chunks, 'clip.webm', { type: 'video/webm' }),
        new File([secret], 'notes.txt', { type: 'text/plain' }),
        new File([new Uint8Array(big)], 'huge.bin', { type: 'application/octet-stream' }),
      ]
      const data = new DataTransfer()
      for (const f of files) data.items.add(f)
      const target = document.querySelector('.chat-panel')
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
      }
    },
    { png, secret: SECRET, big: MAX + 1024 * 1024 },
  )

  const refused = await waitFor(
    () => alice.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).find((t) => t.includes('huge.bin')) ?? null),
    5000,
  )
  check('a file bigger than the server takes is refused, and says why', !!refused, refused ?? 'no word')

  const chips = await alice.$$eval('.attach-chip', (els) => els.map((e) => e.querySelector('.attach-name')?.textContent))
  check('the other three wait in the tray', chips.length === 3, chips.join(', '))
  await shot(alice, 'tray')

  await alice.click('[aria-label="Write a message"]')
  await alice.keyboard.type('three files for you')
  await alice.keyboard.press('Enter')

  const sent = await waitFor(
    () =>
      alice.evaluate(() => {
        const block = document.querySelector('.chat-line .att-block')
        if (!block) return null
        return {
          images: block.querySelectorAll('.att-image').length,
          videos: block.querySelectorAll('.att-video').length,
          cards: block.querySelectorAll('.att-file').length,
          tray: document.querySelectorAll('.attach-chip').length,
        }
      }),
    30_000,
  )
  check(
    'sending waits for the uploads, then the message carries all three',
    !!sent && sent.images === 1 && sent.videos === 1 && sent.cards === 1 && sent.tray === 0,
    JSON.stringify(sent),
  )

  // ---- Bob ----
  const picture = await waitFor(
    () =>
      bob.evaluate(() => {
        const img = document.querySelector('.att-image.ready img')
        return img && img.naturalWidth > 0 ? `${img.naturalWidth}x${img.naturalHeight}` : null
      }),
    30_000,
  )
  check('Bob sees the picture, opened on his own device', !!picture, picture ?? 'nothing')
  await wait(1200)
  await shot(bob, 'message')

  await bob.click('.att-image')
  const viewed = await waitFor(
    () =>
      bob.evaluate(() => {
        const img = document.querySelector('.viewer .viewer-img')
        return img && img.naturalWidth > 100 && !img.classList.contains('soft') ? document.querySelector('.viewer-name')?.textContent : null
      }),
    10_000,
  )
  check('a click opens it full screen', viewed === 'screen.png', viewed ?? 'no viewer')
  await wait(400)
  await shot(bob, 'viewer')
  await bob.keyboard.press('Escape')
  check('and Escape closes it', (await bob.$('.viewer')) === null)

  const poster = await waitFor(
    () => bob.evaluate(() => (document.querySelector('.att-video.ready') ? true : null)),
    15_000,
  )
  check('the video shows its first frame before it is played', !!poster)
  await bob.click('.att-video')
  const playing = await waitFor(
    () =>
      bob.evaluate(() => {
        const v = document.querySelector('.att-video video')
        return v && v.readyState >= 2 && v.videoWidth > 0 ? `${v.videoWidth}x${v.videoHeight}` : null
      }),
    20_000,
  )
  check('and a click plays it', !!playing, playing ?? 'not playing')
  await shot(bob, 'playing')

  const [download] = await Promise.all([
    bob.waitForEvent('download', { timeout: 20_000 }),
    bob.click('.att-file button[aria-label="Save notes.txt"]'),
  ])
  const saved = readFileSync(await download.path(), 'utf8')
  check('saving the text file gives back exactly what was sent', saved === SECRET && download.suggestedFilename() === 'notes.txt', download.suggestedFilename())

  // ---- a file, and nothing else, in a direct message ----
  await bob.click('[aria-label="Write a message"]')
  await bob.keyboard.type('/dm Alice ')
  await bob.keyboard.press('Enter')
  await bob.waitForSelector('.home-grid-shell.dm-open', { timeout: 10_000 })
  await bob.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['just between us'], 'private.txt', { type: 'text/plain' }))
    const target = document.querySelector('.chat-panel')
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
    }
  })
  await bob.waitForSelector('.attach-chip.done', { timeout: 15_000 })
  await bob.click('[aria-label="Write a message"]')
  await bob.keyboard.press('Enter')
  const inDm = await waitFor(async () => {
    const hasItem = await alice.$('.dm-item')
    if (!hasItem) {
      await alice.click('button[aria-label="Switch space"]')
      await alice.click('.menu.switcher .menu-item:has-text("Home")')
      return null
    }
    await alice.click('.dm-item')
    return alice.evaluate(() => document.querySelector('.att-file .att-file-name')?.textContent ?? null)
  }, 20_000)
  check('a file alone can go in a direct message, and arrives', inDm === 'private.txt', inDm ?? 'nothing')

  // ---- what the server has ----
  const kept = onDisk(a.files)
  const blobs = [...kept.values()]
  check('the server keeps each file, and a poster for the video', kept.size === 5, `${kept.size} files`)
  check(
    'none of it is readable',
    blobs.every(
      (blob) =>
        !blob.includes(Buffer.from(SECRET)) && !blob.includes(Buffer.from('IHDR')) && !blob.includes(Buffer.from('just between us')),
    ),
  )
  check(
    'each is named by the hash of what it holds',
    [...kept].every(([id, blob]) => createHash('sha256').update(blob).digest('hex') === id),
  )
  const rows = await sql(a.database, 'select room, id, size from files')
  check('and the database lists them', rows.length === 5, `${rows.length} rows`)

  const room = rows[0]?.room
  const bare = await fetch(`${A}/api/v1/spaces/${room}/files`, { method: 'POST', body: 'junk' })
  check('an upload without the write token is refused', bare.status === 403, String(bare.status))

  // ---- the other server of the cluster ----
  const copied = await waitFor(async () => {
    const there = onDisk(b.files)
    return [...kept.keys()].every((id) => there.has(id)) ? there : null
  }, 20_000)
  check('the second server copies every file by itself', !!copied, copied ? `${copied.size} files` : 'not yet')
  const one = rows.find((r) => r.size > 1000)
  const fromB = await fetch(`${B}/api/v1/spaces/${room}/files/${one.id}`)
  const bytes = Buffer.from(await fromB.arrayBuffer())
  check(
    'and hands one out byte for byte',
    fromB.ok && createHash('sha256').update(bytes).digest('hex') === one.id,
    `${fromB.status}, ${bytes.length} bytes`,
  )
  check('the files folder holds nothing half written', !readdirSync(a.files).includes('incoming') || readdirSync(join(a.files, 'incoming')).length === 0)
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
} finally {
  await browser.close()
  a.child.kill()
  b.child.kill()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
