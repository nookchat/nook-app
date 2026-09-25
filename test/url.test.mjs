import { APP_URL, check, finish, launch, stoppedEarly } from './harness.mjs'

const STUB = `(() => {
  const c = document.createElement('canvas')
  c.width = 1280; c.height = 720
  const x = c.getContext('2d')
  let f = 0
  setInterval(() => {
    f++
    x.fillStyle = '#123'; x.fillRect(0, 0, 1280, 720)
    x.fillStyle = '#0c8'; x.fillRect((f * 9) % 1180, 260, 100, 100)
  }, 33)
  const s = c.captureStream(30)
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream(s.getVideoTracks())
})()`

const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/

const browser = await launch({ args: ['--use-fake-ui-for-media-stream'] })

try {
  const page = await (await browser.newContext()).newPage()
  await page.addInitScript(STUB)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })

  check('the address bar is clean before a space is opened', !page.url().includes('#'), page.url())

  await page.getByRole('button', { name: 'New space' }).click()
  await page.waitForSelector('[aria-label="Write a message"]')
  await page.waitForTimeout(800)
  await page.click('.space-title-button')
  await page.click('.menu-item:has-text("Invite")')
  await page.locator('.share-code').waitFor({ timeout: 15_000 })

  const code = (await page.locator('.share-code').textContent())?.trim() ?? ''
  check('the code reads as three groups of four', CODE.test(code), code)

  const url = page.url()
  check('the address bar carries the space once you are in one', url.includes(`#${code}@`), url)

  const link = await page.locator('.share-code').getAttribute('data-link')
  check('the copied link matches the address bar', link === url, link ?? 'none')

  const many = await page.evaluate(async () => {
    const { newSecret } = await import('/src/room.ts')
    const seen = new Set()
    for (let i = 0; i < 5000; i++) seen.add(newSecret())
    return seen.size
  })
  check('five thousand codes are five thousand different codes', many === 5000, `${many} unique`)

  const folds = await page.evaluate(async () => {
    const { parseSecret } = await import('/src/room.ts')
    const canonical = 'K7M29QPTVB2W'
    return {
      hyphens: parseSecret('K7M2-9QPT-VB2W') === canonical,
      lower: parseSecret('k7m2-9qpt-vb2w') === canonical,
      spaces: parseSecret('  K7M2 9QPT VB2W ') === canonical,
      confused: parseSecret('K7M2-9QPT-VB2W'.replace('0', 'O')) === canonical,
      tooShort: parseSecret('K7M2-9QPT') === null,
      rubbish: parseSecret('not a code at all') === null,
    }
  })
  check('a code survives however it was typed', Object.values(folds).every(Boolean), JSON.stringify(folds))

  await page.keyboard.press('Escape')
  const before = page.url()
  await page.reload()
  await page.waitForTimeout(2000)
  check('reloading keeps you in the same space', page.url() === before, page.url())
  const back = await page.evaluate(() => ({
    chat: !!document.querySelector('.chat-log'),
    channels: document.querySelectorAll('.rail-item').length,
  }))
  check(
    'and the space comes back with its channels and chat',
    back.chat && back.channels > 0,
    `${back.channels} channels`,
  )
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
