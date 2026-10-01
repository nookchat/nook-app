import { mkdirSync } from 'node:fs'
import { APP_URL, FAKE_MEDIA, check, finish, launch, stoppedEarly, wait } from './harness.mjs'

// A phone: the side bars are drawers a finger pulls out, a popup is a sheet a finger pulls down,
// a long press opens a message's menu, and a picture zooms, steps and closes under the fingers.
// The touches go in through the browser's own touch events, as a phone's do.

const SHOTS = new URL('../test-output/phone/', import.meta.url).pathname
mkdirSync(SHOTS, { recursive: true })
const BOX = '[aria-label="Write a message"]'
const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
}

const browser = await launch({ args: FAKE_MEDIA })
const shot = (page, name) => page.screenshot({ path: `${SHOTS}${name}.png` })

async function person(name, phone) {
  const page = await (await browser.newContext(phone ? PHONE : { viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  return page
}

const touch = (page) => page.context().newCDPSession(page)

async function swipe(page, [x0, y0], [x1, y1], ms = 250, steps = 12) {
  const c = await touch(page)
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] })
  for (let i = 1; i <= steps; i++) {
    const point = { x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] })
    await wait(ms / steps)
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await wait(400)
}

async function hold(page, [x, y], ms = 650) {
  const c = await touch(page)
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await wait(ms)
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await wait(400)
}

async function tap(page, [x, y]) {
  await page.touchscreen.tap(x, y)
  await wait(60)
}

async function say(page, text) {
  await page.click(BOX)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await wait(200)
}

const box = (page, sel) => page.locator(sel).first().boundingBox()
const mid = (b) => [b.x + b.width / 2, b.y + b.height / 2]

try {
  const ada = await person('Ada', false)
  await ada.waitForSelector('input[aria-label="Space name"]')
  await ada.fill('input[aria-label="Space name"]', 'Night Shift')
  await ada.click('button:has-text("New space")')
  await ada.waitForSelector(BOX)
  const link = ada.url()
  for (const text of ['Morning all. The build is green.', 'Release at noon. Notes in https://example.com/notes']) {
    await say(ada, text)
  }
  // Two pictures, dropped on the chat as a file from the computer would be.
  await ada.evaluate(async () => {
    const files = []
    for (const [colour, word] of [['#5b8cff', 'one'], ['#ff8a5b', 'two']]) {
      const canvas = document.createElement('canvas')
      canvas.width = 800
      canvas.height = 600
      const x = canvas.getContext('2d')
      x.fillStyle = colour
      x.fillRect(0, 0, 800, 600)
      x.fillStyle = '#fff'
      x.font = '120px sans-serif'
      x.fillText(word, 260, 340)
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'))
      files.push(new File([blob], `${word}.png`, { type: 'image/png' }))
    }
    const data = new DataTransfer()
    for (const f of files) data.items.add(f)
    const target = document.querySelector('.chat-panel')
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
    }
  })
  await wait(600)
  await say(ada, 'two pictures')
  await wait(2500)

  const mae = await person('Mae', true)
  await mae.goto(link)
  await mae.waitForSelector(BOX)
  await wait(2500)
  const tabsShown = () =>
    mae.evaluate(() => {
      const bar = document.querySelector('.tab-bar')
      return !!bar && getComputedStyle(bar).visibility === 'visible'
    })
  const railsOpen = () => mae.evaluate(() => document.querySelector('.space-grid').className.match(/rail-(left|right)-open/)?.[1] ?? null)
  check('no tab bar in a conversation', !(await tabsShown()))

  await swipe(mae, [40, 500], [330, 510])
  check('swipe right opens the channels', (await railsOpen()) === 'left')
  await wait(300)
  check('tab bar with the channels', await tabsShown())
  await shot(mae, 'channels')
  await swipe(mae, [300, 500], [20, 505])
  check('swipe left closes them', (await railsOpen()) === null)
  await swipe(mae, [350, 500], [60, 505])
  check('swipe left opens the people', (await railsOpen()) === 'right')
  await swipe(mae, [100, 500], [380, 505])
  check('swipe right closes them', (await railsOpen()) === null)
  await swipe(mae, [40, 500], [120, 500], 600)
  check('a short slow drag springs back', (await railsOpen()) === null)

  const line = await box(mae, '.chat-line:has-text("Morning all")')
  await hold(mae, mid(line))
  const sheet = await mae.evaluate(() => document.querySelector('.menu.sheet')?.getBoundingClientRect().bottom ?? null)
  check('long press opens the message menu as a sheet at the bottom', sheet !== null && sheet >= 840, String(sheet))
  check('and the words are not selected', await mae.evaluate(() => !window.getSelection().toString()))
  await shot(mae, 'long-press')
  await tap(mae, [200, 100])
  await wait(300)
  check('a tap on the dim page closes it', await mae.evaluate(() => !document.querySelector('.menu')))
  check('and opens nothing under it', await mae.evaluate(() => !document.querySelector('.profile-card, .viewer')))

  await hold(mae, mid(line))
  const grab = await box(mae, '.menu.sheet .sheet-grab')
  await swipe(mae, mid(grab), [mid(grab)[0], mid(grab)[1] + 300], 200)
  await wait(300)
  check('pulling the sheet down closes it', await mae.evaluate(() => !document.querySelector('.menu')))

  await tap(mae, mid(await box(mae, '.att-image')))
  await wait(900)
  check('tap opens the viewer', await mae.evaluate(() => !!document.querySelector('.viewer')))
  await swipe(mae, [300, 420], [40, 420], 200)
  await wait(500)
  const name = await mae.evaluate(() => document.querySelector('.viewer-name')?.textContent)
  check('swipe sideways goes to the next picture', name === 'two.png', name)
  const c = await touch(mae)
  const doubleTap = async () => {
    for (let i = 0; i < 2; i++) {
      await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 420 }] })
      await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await wait(120)
    }
    await wait(400)
  }
  const scale = () => mae.evaluate(() => Number(document.querySelector('.viewer-img').style.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1))
  await doubleTap()
  const zoom = await mae.evaluate(() => document.querySelector('.viewer-img').style.transform)
  check('double tap zooms in', zoom.includes('scale(2.5)'), zoom)
  check('and does not close it', await mae.evaluate(() => !!document.querySelector('.viewer')))
  await shot(mae, 'zoomed')
  // Two fingers coming together.
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y: 420, id: 1 }, { x: 270, y: 420, id: 2 }] })
  for (let i = 1; i <= 8; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 120 + i * 8, y: 420, id: 1 }, { x: 270 - i * 8, y: 420, id: 2 }] })
    await wait(16)
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await wait(400)
  const pinched = await scale()
  check('pinching in zooms out', pinched < 2.5, String(pinched))
  if (pinched > 1) await doubleTap()
  await swipe(mae, [195, 380], [200, 700], 200)
  await wait(500)
  check('swipe down closes the viewer', await mae.evaluate(() => !document.querySelector('.viewer')))

  await tap(mae, mid(await box(mae, '.att-image')))
  await wait(700)
  await mae.goBack()
  await wait(500)
  check('back closes the viewer', await mae.evaluate(() => !document.querySelector('.viewer')))
  check('and stays in the space', mae.url() === link, mae.url())

  await tap(mae, mid(await box(mae, 'button[aria-label="Channels and settings"]')))
  await wait(400)
  await mae.goBack()
  await wait(400)
  check('back closes the drawer', (await railsOpen()) === null)

  const emojiBtn = await mae.$('.chat-compose button[aria-label*="moji"]')
  if (emojiBtn) {
    await tap(mae, mid(await emojiBtn.boundingBox()))
    await wait(500)
    check('the emoji picker is a sheet', await mae.evaluate(() => !!document.querySelector('.emoji-pop.sheet')))
    check('with no keyboard yet', await mae.evaluate(() => document.activeElement?.className !== 'emoji-search'))
    await tap(mae, [200, 60])
    await wait(300)
  } else check('the message box has an emoji button', false)

  await swipe(mae, [40, 500], [330, 510])
  await tap(mae, mid(await box(mae, '.tab-bar .tab:has-text("You")')))
  await wait(1200)
  check('You opens settings', await mae.evaluate(() => !!document.querySelector('.settings-frame')))
  await tap(mae, mid(await box(mae, '.tab-bar .tab:has-text("Home")')))
  await wait(1200)
  check('Home tab goes home', await mae.evaluate(() => !!document.querySelector('.home-grid-shell')))
  await tap(mae, mid(await box(mae, '.tab-bar .tab:nth-child(2)')))
  await wait(1500)
  check('Space tab opens the space with its channels out', (await railsOpen()) === 'left')
  await shot(mae, 'space-tab')
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
