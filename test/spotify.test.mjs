import { createRequire } from 'node:module'
import { APP_URL, check, finish, launch, stoppedEarly } from './harness.mjs'

// What you listen to on Spotify, as Discord shows it. The desktop shell reads the song from the
// Spotify app; first what it reads, then a stand-in shell tells the page, in one browser, and
// the others see it.
const { parseMac, parseTasklist, parseWindowsTitle, parseLinux, sameSong } = createRequire(import.meta.url)('../desktop/spotify.cjs')

const mac = parseMac('Blinding Lights\tThe Weeknd\tAfter Hours\tspotify:track:0VjIjW4GlUZAMYd2vXMi3b\t200040\t61234\thttps://i.scdn.co/image/ab67616d0000b273\n')
check(
  'macOS: the song, the artist, the album, the track, how long and how far in',
  mac?.title === 'Blinding Lights' && mac.artist === 'The Weeknd' && mac.album === 'After Hours' && mac.track === '0VjIjW4GlUZAMYd2vXMi3b' && mac.duration === 200040 && mac.position === 61234 && mac.art?.startsWith('https://i.scdn.co/'),
  JSON.stringify(mac),
)
check('macOS: nothing when Spotify is paused', parseMac('') === null)
check('macOS: a cover from anywhere else is left out', parseMac('a\tb\tc\tspotify:track:0VjIjW4GlUZAMYd2vXMi3b\t1\t1\thttps://evil.example/x.png')?.art === undefined)
check('macOS: a local file has no track', parseMac('a\tb\tc\tspotify:local:x\t1\t1\t')?.track === undefined)

const rows = [
  '"Spotify.exe","1234","Console","1","100 K","Running","PC\\me","0:00:10","N/A"',
  '"Spotify.exe","99","Console","1","100 K","Running","PC\\me","0:00:10","Daft Punk - One More Time - Radio Edit"',
].join('\r\n')
const win = parseTasklist(rows)
check('Windows: the artist before the first dash, the song after', win?.artist === 'Daft Punk' && win.title === 'One More Time - Radio Edit', JSON.stringify(win))
check('Windows: a paused Spotify says only its name', ['Spotify', 'Spotify Free', 'Spotify Premium', 'Advertisement'].every((t) => parseWindowsTitle(t) === null))

const linux = parseLinux('Playing\n', 'Song\tBand\tRecord\t/com/spotify/track/0VjIjW4GlUZAMYd2vXMi3b\t180000000\t5000000\thttps://open.spotify.com/image/ab67\n')
check('Linux: from playerctl, in milliseconds', linux?.track === '0VjIjW4GlUZAMYd2vXMi3b' && linux.duration === 180000 && linux.position === 5000 && linux.art === 'https://i.scdn.co/image/ab67', JSON.stringify(linux))
check('Linux: nothing when paused', parseLinux('Paused', '') === null)

const was = { title: 'A', artist: 'B', position: 10_000, at: 0 }
check('the same song, played on, is not news', sameSong(was, { title: 'A', artist: 'B', position: 15_000 }, 5000))
check('a jump in the song is', !sameSong(was, { title: 'A', artist: 'B', position: 90_000 }, 5000))
check('another song is', !sameSong(was, { title: 'C', artist: 'B', position: 15_000 }, 5000))

const SHELL = () => {
  window.nookDesktop = {
    platform: 'darwin',
    watchSpotify: (on) => {
      window.__watchingSpotify = on
    },
    onListening: (fn) => {
      window.__song = fn
      return () => {}
    },
    onUpdate: () => () => {},
    installUpdate: () => {},
  }
}

const browser = await launch()
const doingOf = (page) => page.$$eval('.rail-person .person-doing.listening', (els) => els.map((e) => e.textContent.trim()).join('|'))
const seen = (page, want, ms = 20_000) =>
  page
    .waitForFunction(
      (w) => [...document.querySelectorAll('.rail-person .person-doing.listening')].map((e) => e.textContent.trim()).join('|') === w,
      want,
      { timeout: ms },
    )
    .then(() => true, () => false)

try {
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await hostContext.addInitScript(SHELL)
  const host = await hostContext.newPage()
  await host.goto(APP_URL)
  await host.waitForSelector('input[aria-label="Space name"]')
  await host.fill('input[aria-label="Space name"]', 'music')
  await host.click('button:has-text("New space")')
  await host.waitForSelector('.space-name')
  await host.waitForTimeout(1200)
  check('the page asks the shell to look at Spotify', (await host.evaluate(() => window.__watchingSpotify)) === true)

  const guest = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  // Spotify's covers, served here: a small green square.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  await guest.route('https://i.scdn.co/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await guest.goto(host.url())
  await guest.waitForSelector('.space-name')
  await guest.waitForTimeout(1500)
  check('a browser has no shell, and shows no song', (await doingOf(guest)) === '')

  await host.evaluate(() =>
    window.__song({
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      album: 'After Hours',
      track: '0VjIjW4GlUZAMYd2vXMi3b',
      duration: 200_000,
      position: 60_000,
      at: Date.now(),
    }),
  )
  check('you see your own song under your name', await seen(host, 'Blinding Lights'))
  check('the others see it too', await seen(guest, 'Blinding Lights'), await doingOf(guest))

  await guest.click('.rail-person.has-menu:has(.person-doing.listening)')
  await guest.waitForSelector('.song-card', { timeout: 5000 })
  const card = await guest.$eval('.song-card', (el) => ({
    words: el.textContent,
    link: el.querySelector('.song-open')?.href,
    time: el.querySelector('.song-time')?.textContent ?? '',
  }))
  check('their menu has the song, the artist and the album', card.words.includes('Blinding Lights') && card.words.includes('by The Weeknd') && card.words.includes('on After Hours'), card.words)
  check('and a button that opens it on Spotify', card.link === 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b', card.link)
  check('and how far in it is, by the time the shell gave', /^1:0\d.*3:20$/.test(card.time), card.time)
  await guest.waitForTimeout(500)
  await guest.screenshot({ path: 'test-output/spotify-card.png' })
  const profile = await guest.$eval('.profile-card', (el) => ({
    face: el.querySelector('.profile-face .avatar')?.getBoundingClientRect().width,
    name: el.querySelector('.profile-name')?.textContent,
    message: [...el.querySelectorAll('button')].some((b) => b.textContent.startsWith('Message')),
  }))
  check('a click on a name opens their profile, with a large picture and a Message button', profile.face >= 80 && !!profile.name && profile.message, JSON.stringify(profile))
  await guest.keyboard.press('Escape')
  await guest.click('.rail-person.has-menu:has(.person-doing.listening)', { button: 'right' })
  await guest.waitForSelector('.menu .menu-item')
  const menuItems = await guest.locator('.menu .menu-label').allTextContents()
  check('a right click opens what you can do about them', menuItems.includes('Message') && (await guest.locator('.profile-card').count()) === 0, menuItems.join('|'))
  await guest.keyboard.press('Escape')

  // A long name slides along in the list of people, as Discord's do.
  await host.evaluate(() =>
    window.__song({ title: 'A Very Long Song Name That Cannot Possibly Fit In The List Of People (Extended Remix)', artist: 'Band', art: 'https://i.scdn.co/image/ab67616d0000b273', at: Date.now() }),
  )
  check('a long song shows', await seen(guest, 'A Very Long Song Name That Cannot Possibly Fit In The List Of People (Extended Remix)'))
  const slides = await guest.waitForFunction(() => document.querySelector('.rail-person .person-doing.listening .marquee')?.classList.contains('moving'), null, { timeout: 5000 }).then(() => true, () => false)
  check('and its name slides along, since it does not fit', slides, await guest.$eval('.rail-person .person-doing.listening', (el) => el.outerHTML.slice(0, 300)))
  check('with the cover at the end of the row', (await guest.locator('.rail-person .person-art').count()) === 1)
  await guest.screenshot({ path: 'test-output/spotify-row.png' })

  // A song from Windows has no track: the button searches for it.
  await host.evaluate(() => window.__song({ title: 'One More Time', artist: 'Daft Punk', at: Date.now() }))
  check('a new song shows', await seen(guest, 'One More Time'))
  await guest.click('.rail-person.has-menu:has(.person-doing.listening)')
  await guest.waitForSelector('.song-card')
  const search = await guest.$eval('.song-card .song-open', (a) => a.href)
  check('with no track, the button searches Spotify', search === 'https://open.spotify.com/search/Daft%20Punk%20One%20More%20Time', search)
  await guest.keyboard.press('Escape')

  // Kept to yourself: nobody sees it, and the shell stops asking.
  await host.evaluate(async () => (await import('/src/net/listening.ts')).setShowsListening(false))
  check('turned off, the shell stops looking', (await host.evaluate(() => window.__watchingSpotify)) === false)
  check('and the others no longer see it', await seen(guest, ''))

  // Paused: gone.
  await host.evaluate(async () => (await import('/src/net/listening.ts')).setShowsListening(true))
  await host.evaluate(() => window.__song({ title: 'Back', artist: 'Band', at: Date.now() }))
  check('turned on again, it shows', await seen(guest, 'Back'))
  await host.evaluate(() => window.__song(null))
  check('when Spotify stops, it goes', await seen(guest, ''))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
