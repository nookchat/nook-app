/**
 * A tour of the app with something in it, for looking at.
 *
 * Starts a server, puts three people in a space on it, gives them a few
 * channels and a conversation worth reading, shares a screen, and takes a
 * picture of each screen at desktop and phone width. Also times how long the
 * first paint and opening a space take, so a change that makes it slower is
 * seen rather than felt.
 *
 *   node test/tour.mjs [app url]      pictures land in test-output/tour/
 */

import { chromium } from 'playwright-core'
import { startServer } from './pg.mjs'
import { mkdirSync } from 'node:fs'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const PORT = 8794
const SERVER = `localhost:${PORT}`
const OUT = new URL('../test-output/tour/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const { child: server } = await startServer(PORT)

const STUB = `(() => {
  const c = document.createElement('canvas'); c.width = 1600; c.height = 900
  const x = c.getContext('2d'); let f = 0
  setInterval(() => { f++; x.fillStyle = '#0d1117'; x.fillRect(0, 0, 1600, 900)
    x.fillStyle = '#e8ecf1'; x.font = '34px monospace'
    x.fillText('export function frame() { return ' + f + ' }', 60, 110)
    x.fillStyle = '#5b8cff'; x.fillRect(60, 160, 520, 6) }, 33)
  const s = c.captureStream(30)
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(s.getVideoTracks())
})()`

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const BOX = '[aria-label="Write a message"]'
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))
const shot = (page, name, full = false) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: full })

async function person(name, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } })
  await context.addInitScript(STUB)
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('cathode.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

async function say(page, text) {
  await page.click(BOX)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await wait(250)
}

try {
  const ada = await person('Ada')
  const t0 = Date.now()
  await ada.reload()
  await ada.waitForSelector('input[aria-label="Space name"]')
  console.log(`list painted in ${Date.now() - t0} ms`)
  await shot(ada, 'list-desktop')

  await ada.click('button:has-text("Server")')
  await ada.fill('input[aria-label="Server address"]', SERVER)
  await ada.fill('input[aria-label="Space name"]', 'Night Shift')
  const t1 = Date.now()
  await ada.click('button:has-text("New space")')
  await ada.waitForSelector(BOX)
  console.log(`space opened in ${Date.now() - t1} ms`)
  const link = ada.url()

  // A couple of channels to stand in.
  for (const [voice, name] of [[false, 'design'], [false, 'releases'], [true, 'Lounge']]) {
    ada.once('dialog', (d) => void d.accept(name))
    await ada.click(voice ? 'button[title="Make a voice channel"]' : 'button[title="Make a text channel"]')
    await wait(300)
  }
  await ada.click('.rail-item:has-text("general")').catch(() => undefined)

  const grace = await person('Grace')
  await grace.goto(link)
  await grace.waitForSelector(BOX)
  const linus = await person('Linus')
  await linus.goto(link)
  await linus.waitForSelector(BOX)
  await wait(1500)

  await say(ada, 'Morning all. The build from last night is green, so I am cutting the release at noon.')
  await say(grace, 'Nice. Did the flaky upload test finally behave?')
  await say(linus, 'It did after I gave it a real timeout. See `test/uplink.mjs`, line 40.')
  await say(ada, '**Release notes** are in #releases. Shout if anything is missing.')
  await say(grace, 'One thing: the invite QR was cut off on small phones. https://github.com/nebbsie/stream/issues/12')
  await linus.click(BOX)
  await linus.keyboard.type('```')
  await linus.keyboard.press('Shift+Enter')
  await linus.keyboard.type('npm run build && npm run test:server')
  await linus.keyboard.press('Shift+Enter')
  await linus.keyboard.type('```')
  await linus.keyboard.press('Enter')
  await wait(250)
  await say(ada, 'On it 👍')
  await say(grace, 'Thanks @Ada')
  await say(grace, 'I will test it on my phone after lunch.')
  await wait(800)

  await shot(ada, 'space-desktop')

  // A message under the pointer, with its actions.
  await ada.hover('.chat-row.first >> nth=2')
  await wait(200)
  await shot(ada, 'hover-desktop')
  // Somebody's menu in the members list.
  await ada.hover('.rail-person >> nth=1')
  await ada.click('.rail-person >> nth=1 >> .person-more').catch(() => undefined)
  await wait(300)
  await shot(ada, 'menu-desktop')
  await ada.keyboard.press('Escape')
  await ada.click('button[aria-label="Show a QR code"]').catch(() => undefined)
  await wait(400)
  await shot(ada, 'qr-desktop')
  await ada.keyboard.press('Escape')

  // Share a screen and have somebody watch it.
  await ada.click('button:has-text("Share screen")')
  await wait(2500)
  await shot(ada, 'sharing-desktop')
  const watch = await grace.$('.stream-tab')
  if (watch) {
    await watch.click()
    await wait(3500)
  }
  await shot(grace, 'watching-desktop')

  // Voice.
  await linus.click('.rail-item:has-text("Lounge")').catch(() => undefined)
  await wait(1500)
  await shot(linus, 'voice-desktop')

  // Settings.
  await grace.click('button[aria-label="Settings"]').catch(() => undefined)
  await wait(500)
  await shot(grace, 'settings-desktop', true)

  // A phone.
  const phone = await person('Mae', 390, 844)
  await shot(phone, 'list-phone', true)
  await phone.goto(link)
  await phone.waitForSelector(BOX)
  await wait(2500)
  await shot(phone, 'space-phone')
  await phone.click('button[aria-label="Channels and settings"]')
  await wait(400)
  await shot(phone, 'drawer-phone')
  console.log(`pictures in ${OUT}`)
} catch (err) {
  console.error('The tour stopped early:', err.message)
  process.exitCode = 1
} finally {
  await browser.close()
  server.kill()
}
