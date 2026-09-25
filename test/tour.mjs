import { mkdirSync } from 'node:fs'
import { APP_URL, FAKE_MEDIA, launch, wait } from './harness.mjs'

const OUT = new URL('../test-output/tour/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

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

const browser = await launch({ args: FAKE_MEDIA })
const BOX = '[aria-label="Write a message"]'
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

  await ada.fill('input[aria-label="Space name"]', 'Night Shift')
  const t1 = Date.now()
  await ada.click('button:has-text("New space")')
  await ada.waitForSelector(BOX)
  console.log(`space opened in ${Date.now() - t1} ms`)
  const link = ada.url()

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

  await ada.hover('.chat-row.first >> nth=2')
  await wait(200)
  await shot(ada, 'hover-desktop')
  await ada.hover('.rail-person >> nth=1')
  await ada.click('.rail-person >> nth=1 >> .person-more').catch(() => undefined)
  await wait(300)
  await shot(ada, 'menu-desktop')
  await ada.keyboard.press('Escape')
  await ada.click('.space-title-button')
  await wait(200)
  await shot(ada, 'space-menu-desktop')
  await ada.click('.menu-item:has-text("Invite")')
  await wait(500)
  await shot(ada, 'invite-desktop')
  await ada.keyboard.press('Escape')

  await ada.click('.rail-item:has-text("Lounge")')
  await wait(1500)
  await ada.click('button[aria-label="Share screen"]')
  await wait(2500)
  await shot(ada, 'sharing-desktop')
  await grace.click('.rail-item:has-text("Lounge")')
  await wait(1500)
  await grace.click('.live-badge').catch(() => undefined)
  await wait(3500)
  await shot(grace, 'watching-desktop')
  await shot(linus, 'voice-desktop')

  await linus.click(BOX)
  await linus.keyboard.type('/dm Ada are you free later?')
  await linus.keyboard.press('Enter')
  await wait(1500)
  await shot(linus, 'home-dm-desktop')
  await ada.click('button[aria-label="Switch space"]')
  await wait(400)
  await shot(ada, 'switcher-desktop')
  await ada.click('.menu.switcher .menu-item:has-text("Home")')
  await wait(1200)
  await shot(ada, 'home-desktop')

  await grace.click('button[aria-label="Settings"]').catch(() => undefined)
  await wait(800)
  await shot(grace, 'settings-desktop', true)

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
}
