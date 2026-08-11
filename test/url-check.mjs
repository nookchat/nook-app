/**
 * The address bar is a place people share from.
 *
 * Once a stream starts the room goes into the URL, so the link can be copied
 * straight out of the address bar. That creates one trap worth a test: reloading
 * the host page reads that fragment back, and without care the host would become
 * a viewer of a room that died with the reload.
 *
 *   node test/url-check.mjs
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

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

const CODE = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream'],
})

try {
  const page = await (await browser.newContext()).newPage()
  await page.addInitScript(STUB)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })

  check('the address bar is clean before sharing', !page.url().includes('#'), page.url())

  await page.getByRole('button', { name: 'Choose what to share' }).click()
  await page.locator('.share-code').waitFor({ timeout: 15_000 })

  const code = (await page.locator('.share-code').textContent())?.trim() ?? ''
  check('the code reads as five groups of five', CODE.test(code), code)

  const url = page.url()
  check('the address bar carries the room once sharing starts', url.endsWith(`#${code}`), url)

  const link = await page.locator('.share-code').getAttribute('data-link')
  check('the copied link matches the address bar', link === url, link ?? 'none')

  // A code is a key. Twenty five Crockford symbols is 125 bits, and no two
  // rooms should ever be near each other.
  const many = await page.evaluate(async () => {
    const { newSecret } = await import('/src/room.ts')
    const seen = new Set()
    for (let i = 0; i < 5000; i++) seen.add(newSecret())
    return seen.size
  })
  check('five thousand codes are five thousand different codes', many === 5000, `${many} unique`)

  const folds = await page.evaluate(async () => {
    const { parseSecret } = await import('/src/room.ts')
    const canonical = 'K7M2X9QPT4VB2WNP8ZQ3MHRF6'
    return {
      hyphens: parseSecret('K7M2X-9QPT4-VB2WN-P8ZQ3-MHRF6') === canonical,
      lower: parseSecret('k7m2x-9qpt4-vb2wn-p8zq3-mhrf6') === canonical,
      spaces: parseSecret('  K7M2X 9QPT4 VB2WN P8ZQ3 MHRF6 ') === canonical,
      confused: parseSecret('K7M2X-9QPT4-VB2WN-P8ZQ3-MHRF6'.replace('0', 'O')) === canonical,
      tooShort: parseSecret('K7M2X-9QPT4') === null,
      rubbish: parseSecret('not a code at all') === null,
    }
  })
  check('a code survives however it was typed', Object.values(folds).every(Boolean), JSON.stringify(folds))

  await page.reload()
  await page.waitForTimeout(1500)
  check('reloading the host does not turn it into a viewer', await page.evaluate(() => !!document.querySelector('.pick')))
  check('reloading the host clears the dead room from the address bar', !page.url().includes('#'), page.url())
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} of ${results.length} checks passed.`)
process.exit(failed === 0 ? 0 : 1)
