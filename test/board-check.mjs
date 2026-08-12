/**
 * The soundboard, GIF search, and pictures in the chat.
 *
 * Three things that all end up in the same place: something that is not words
 * arriving in a channel. Two browsers, because a noise that only the person
 * who pressed it hears is not a soundboard.
 *
 *   node test/board-check.mjs
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})

const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
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
  await page.waitForTimeout(350)
}

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'the board')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(900)
  const link = alice.url()

  const bob = await person('Bob')
  await bob.goto(link)
  await bob.waitForFunction(
    () => document.querySelector('.space-name')?.textContent === 'the board',
    null,
    { timeout: 60_000 },
  )

  // ---- which links are pictures -------------------------------------------
  // The rule used to be that the address ended in .png, which left a PNG from
  // half the places people get PNGs drawn as a bare link beside a GIF drawn as
  // a picture. These are the shapes that failed.
  const found = await alice.evaluate(async () => {
    const { imageLinks } = await import('/src/ui/chat-panel.ts')
    const one = (text) => imageLinks(text).length === 1
    return {
      plain: one('https://example.com/cat.png'),
      query: one('https://example.com/cat.png?width=400'),
      twitter: one('https://pbs.twimg.com/media/abc123?format=png&name=large'),
      extless: one('https://i.imgur.com/abc123'),
      midPath: one('https://example.com/a.png/large'),
      gif: one('https://media.tenor.com/abc/dancing.gif'),
      page: imageLinks('https://example.com/about').length === 0,
      insecure: imageLinks('http://example.com/cat.png').length === 0,
      stranger: imageLinks('https://example.com/whatever').length === 0,
    }
  })
  check('a plain .png is a picture', found.plain)
  check('and one with a query after it', found.query)
  check('a PNG named in the query is a picture', found.twitter, 'the ?format=png shape')
  check('a picture host with no extension at all is a picture', found.extless)
  check('an address that carries on past the extension', found.midPath)
  check('a GIF is still a picture', found.gif)
  check('a page is not a picture', found.page && found.stranger)
  check('and http is never followed', found.insecure)

  // ---- a picture is not in a bubble ---------------------------------------
  // One real pixel, served from here, because a picture that fails to load
  // takes its own frame out of the message and there would be nothing to look
  // at. The address is the only part that matters to the app.
  const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  await alice.route('https://example.com/cat.png', (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL }),
  )

  await say(alice, 'https://example.com/cat.png')
  await alice.waitForTimeout(300)
  const bare = await alice.evaluate(() => {
    const line = [...document.querySelectorAll('.chat-line')].pop()
    if (!line) return null
    const style = getComputedStyle(line)
    return {
      marked: line.classList.contains('has-picture'),
      background: style.backgroundColor,
      border: style.borderTopColor,
      hasImage: !!line.querySelector('.chat-image'),
    }
  })
  check('a picture message carries the mark', bare?.marked === true)
  check('and no bubble behind it', bare?.background === 'rgba(0, 0, 0, 0)', bare?.background ?? '')
  check('and no bubble around it', bare?.border === 'rgba(0, 0, 0, 0)', bare?.border ?? '')
  check('the picture itself is there', bare?.hasImage === true)

  await say(alice, 'look at this https://example.com/cat.png')
  const withText = await alice.evaluate(() => {
    const line = [...document.querySelectorAll('.chat-line')].pop()
    const text = line?.querySelector('.chat-text')
    return {
      boxed: text?.classList.contains('boxed') === true,
      textBg: text ? getComputedStyle(text).backgroundColor : '',
      lineBg: line ? getComputedStyle(line).backgroundColor : '',
    }
  })
  check('words in the same message keep a bubble of their own', withText.boxed)
  check(
    'and it is the words that are in it, not the picture',
    withText.textBg !== 'rgba(0, 0, 0, 0)' && withText.lineBg === 'rgba(0, 0, 0, 0)',
    `${withText.textBg} on ${withText.lineBg}`,
  )

  // ---- the soundboard ------------------------------------------------------
  await alice.click('button[aria-label="Soundboard"]')
  await alice.waitForSelector('.sound-pop')
  const cells = await alice.$$eval('.sound-cell', (els) => els.length)
  check('the board opens with something on it', cells >= 12, `${cells} sounds`)

  await alice.click('button[aria-label="Play Airhorn for everybody"]')
  const heard = await bob
    .waitForFunction(
      () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Alice played Airhorn')),
      null,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('everybody in the space hears it', heard)

  const wrote = await bob.$$eval('.chat-text', (els) =>
    els.some((e) => e.textContent.includes('Airhorn')),
  )
  check('and nothing is written into the channel', !wrote)

  check(
    'the board stays open, so it can be played',
    await alice.$eval('.sound-pop', () => true).catch(() => false),
  )
  await alice.keyboard.press('Escape')

  // A sound by name, for people who know the board already.
  await bob.waitForTimeout(1600)
  await say(alice, '/sound rimshot')
  const byName = await bob
    .waitForFunction(
      () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Rimshot')),
      null,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('/sound plays one by name', byName)
  check('and the command is not posted as a message', !(await alice.$$eval('.chat-text', (els) => els.some((e) => e.textContent.includes('/sound')))))

  await say(alice, '/sound nothing-like-this')
  const complained = await alice.$$eval('.toast', (els) =>
    els.some((t) => t.textContent.includes('No sound called')),
  )
  check('a name that is not on the board says so', complained)

  // ---- the GIF picker ------------------------------------------------------
  // No key and no archive here, so the grid is empty. What is being checked is
  // that it opens, stays open, and says why, rather than flashing a toast at
  // somebody who was looking at the box.
  await alice.click('button[aria-label="Find a GIF"]')
  await alice.waitForSelector('.gif-pop')
  const missing = await alice.$eval('.gif-pop', (el) => el.textContent)
  check('the picker opens from a button', missing.includes('GIFs'))
  check('a search box comes with it', await alice.$('.gif-search').then((el) => !!el))
  check('and it says what is missing, in the box', missing.includes('Settings, GIFs'), missing.slice(0, 80))

  await alice.keyboard.press('Escape')
  check('escape closes it', await alice.$('.gif-pop').then((el) => el === null))

  // ---- what comes back from each service -----------------------------------
  // No key here, so the answer is stubbed: what is being checked is that the
  // right address is asked, and that the tree it answers with is read down to
  // one big picture and one small one.
  const mapped = await alice.evaluate(async () => {
    const { searchGifs } = await import('/src/store/gifs.ts')
    const real = window.fetch
    let asked = ''
    const answer = (body) => {
      window.fetch = async (url) => {
        asked = String(url)
        return new Response(JSON.stringify(body), { status: 200 })
      }
    }

    answer({
      result: true,
      data: {
        data: [
          {
            file: {
              hd: { gif: { url: 'https://cdn.klipy.test/hd.gif', width: 480 }, mp4: { url: 'https://cdn.klipy.test/hd.mp4', width: 480 } },
              sm: { gif: { url: 'https://cdn.klipy.test/sm.gif', width: 120 } },
            },
          },
        ],
      },
    })
    const klipy = await searchGifs('cat', { service: 'klipy', key: 'KEY123' })
    const klipyAsked = asked

    answer({ results: [{ media_formats: { gif: { url: 'https://media.tenor.test/big.gif' }, tinygif: { url: 'https://media.tenor.test/small.gif' } } }] })
    const tenor = await searchGifs('cat', { service: 'tenor', key: 'AIzaKey' })
    const tenorAsked = asked

    window.fetch = real
    return { klipy, klipyAsked, tenor, tenorAsked }
  })
  check(
    'a Klipy key is asked in the path, not the query',
    mapped.klipyAsked.includes('/api/v1/KEY123/gifs/search?q=cat'),
    mapped.klipyAsked,
  )
  check(
    'the widest picture is the one that gets said',
    mapped.klipy[0]?.url === 'https://cdn.klipy.test/hd.gif',
    mapped.klipy[0]?.url ?? 'nothing',
  )
  check(
    'and the narrowest is the one drawn in the grid',
    mapped.klipy[0]?.preview === 'https://cdn.klipy.test/sm.gif',
    mapped.klipy[0]?.preview ?? 'nothing',
  )
  check(
    'a video in the same tree is left alone',
    !JSON.stringify(mapped.klipy).includes('.mp4'),
  )
  check(
    'Tenor still answers the way it did',
    mapped.tenor[0]?.url === 'https://media.tenor.test/big.gif' &&
      mapped.tenor[0]?.preview === 'https://media.tenor.test/small.gif' &&
      mapped.tenorAsked.includes('tenor.googleapis.com'),
  )

  // A key saved before the menu existed is a bare string, and still opens.
  const legacy = await alice.evaluate(async () => {
    localStorage.setItem('cathode.gifkey.v1', 'AIzaSomethingOld')
    const { gifCredential } = await import('/src/store/gifs.ts')
    return gifCredential()
  })
  check('a key saved before the menu is read as a Tenor key', legacy?.service === 'tenor', JSON.stringify(legacy))

  // A key in this browser is what the picker looks for first.
  await alice.evaluate(() =>
    localStorage.setItem('cathode.gifkey.v1', JSON.stringify({ s: 'klipy', k: 'not-a-real-key' })),
  )
  await alice.click('button[aria-label="Find a GIF"]')
  await alice.waitForSelector('.gif-pop')
  await alice.fill('.gif-search', 'dancing cat')
  const answered = await alice
    .waitForFunction(
      () => {
        const said = document.querySelector('.gif-pop')?.textContent ?? ''
        return said.includes('Nothing for') || said.includes('Results for')
      },
      null,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('a key in this browser is what it searches with', answered, 'a fake key, so: nothing found')
  const stillOpen = await alice.$('.gif-pop').then((el) => el !== null)
  check('and a search that found nothing leaves the box open', stillOpen)
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
}

await browser.close()

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
