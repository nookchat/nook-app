import { APP_URL, check, finish, launch, stoppedEarly } from './harness.mjs'
import { readGifs, urlFor } from '../server/src/gifs.mjs'

const SERVER = 'http://localhost:8787'

const klipyUrl = urlFor({ service: 'klipy', key: 'KEY123' }, 'cat')
check('a Klipy key is asked in the path, not the query', klipyUrl.includes('/api/v1/KEY123/gifs/search?q=cat'), klipyUrl)
check('an empty search asks what is popular', urlFor({ service: 'klipy', key: 'K' }, '').includes('/gifs/trending?'))
check('Tenor is asked at Tenor', urlFor({ service: 'tenor', key: 'AIza' }, 'cat').startsWith('https://tenor.googleapis.com/v2/search?q=cat'))
check('Giphy is asked at Giphy', urlFor({ service: 'giphy', key: 'G' }, '').startsWith('https://api.giphy.com/v1/gifs/trending?'))

const klipy = readGifs('klipy', {
  result: true,
  data: {
    data: [
      {
        file: {
          hd: {
            gif: { url: 'https://cdn.klipy.test/hd.gif', width: 480 },
            webm: { url: 'https://cdn.klipy.test/hd.webm', width: 480 },
            mp4: { url: 'https://cdn.klipy.test/hd.mp4', width: 480 },
            jpg: { url: 'https://cdn.klipy.test/hd.jpg', width: 640 },
          },
          sm: { gif: { url: 'https://cdn.klipy.test/sm.gif', width: 120 }, jpg: { url: 'https://cdn.klipy.test/sm.jpg', width: 60 } },
        },
      },
    ],
  },
})
check('the webm is what gets said', klipy[0]?.url === 'https://cdn.klipy.test/hd.webm', klipy[0]?.url ?? 'nothing')
check('and the narrowest picture is drawn in the grid', klipy[0]?.preview === 'https://cdn.klipy.test/sm.gif', klipy[0]?.preview ?? 'nothing')
check('an mp4 and a still frame lose', !JSON.stringify(klipy).includes('.mp4') && !JSON.stringify(klipy).includes('.jpg'))

const tenor = readGifs('tenor', {
  results: [{ media_formats: { gif: { url: 'https://media.tenor.test/big.gif' }, tinygif: { url: 'https://media.tenor.test/small.gif' } } }],
})
check('Tenor answers a big one and a small one', tenor[0]?.url === 'https://media.tenor.test/big.gif' && tenor[0]?.preview === 'https://media.tenor.test/small.gif')

const giphy = readGifs('giphy', {
  data: [{ images: { original: { url: 'https://media.giphy.test/o.gif' }, fixed_width_small: { url: 'https://media.giphy.test/s.gif' } } }],
})
check('and so does Giphy', giphy[0]?.url === 'https://media.giphy.test/o.gif' && giphy[0]?.preview === 'https://media.giphy.test/s.gif')
check('an address that is not https is dropped', readGifs('tenor', { results: [{ media_formats: { gif: { url: 'http://x.test/a.gif' } } }] }).length === 0)

const health = await fetch(`${SERVER}/api/v1/health`).then((r) => r.json())
check('a server with no key says it has no GIF search', health.gifs === false, JSON.stringify({ gifs: health.gifs }))
const off = await fetch(`${SERVER}/api/v1/gifs?q=cat`)
check('and a search there is refused', off.status === 404, String(off.status))

const browser = await launch()
try {
  const page = await browser.newPage()
  await page.goto(APP_URL)
  await page.fill('input[aria-label="Space name"]', 'gifs')
  await page.click('button:has-text("New space")')
  await page.waitForSelector('button[aria-label="Find a GIF"]')
  await page.click('button[aria-label="Find a GIF"]')
  await page.waitForSelector('.gif-pop')
  await page
    .waitForFunction(() => !document.querySelector('.gif-pop')?.textContent?.includes('Looking'), null, { timeout: 8000 })
    .catch(() => undefined)
  const said = await page.$eval('.gif-pop', (el) => el.textContent ?? '')
  check('the picker says the server has no search, and who can turn it on', said.includes('GIF search is off on localhost:8787'), said.slice(0, 90))
  await page.keyboard.press('Escape')

  await page.evaluate(() => document.querySelector('button[aria-label="Settings"]').click())
  await page.waitForSelector('.settings')
  const box = await page.$('input[aria-label="GIF search key"]')
  check('Settings has nowhere for a person to put a key', box === null)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
