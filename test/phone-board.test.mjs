import { APP_URL, AUTOPLAY, check, FAKE_MEDIA, finish, HOME, launch, makeSpace, openSpaceSettings, stoppedEarly } from './harness.mjs'

// One person in a call on a computer, with the same account open on a phone that is not in it.
// The phone plays a sound, and somebody else in the call hears it from the computer.
const browser = await launch({ args: [...FAKE_MEDIA, AUTOPLAY] })

async function person(name, saved) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.addInitScript(
    ({ n, keep }) => {
      localStorage.setItem('nook.name.v1', n)
      for (const [k, v] of Object.entries(keep ?? {})) localStorage.setItem(k, v)
    },
    { n: name, keep: saved },
  )
  const page = await context.newPage()
  await page.goto(APP_URL)
  return page
}

const sounding = () =>
  [...document.querySelectorAll('.voice-member.talking.sounding')].some((m) => m.dataset.sound === 'Honk' && m.textContent.includes('Alice'))

try {
  const alice = await person('Alice')
  await alice.waitForSelector(HOME)
  await makeSpace(alice, 'the phone')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(900)
  const link = alice.url()

  await alice.click('.rail-left .rail-item:has-text("lounge")')
  await alice.waitForSelector('.voice-bar button[aria-label="Soundboard"]', { timeout: 10_000 })

  // Half a second of a tone, as a WAV file, to add.
  const rate = 22050
  const frames = rate / 2
  const wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + frames * 2, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), 44 + i * 2)
  await openSpaceSettings(alice, 'soundboard')
  const chooser = alice.waitForEvent('filechooser')
  await alice.click('.settings-page button:has-text("Add a sound")')
  await (await chooser).setFiles({ name: 'honk.wav', mimeType: 'audio/wav', buffer: wav })
  await alice.waitForSelector('.ask-modal .sound-face')
  await alice.fill('.ask-modal .ask-input', 'Honk')
  await alice.click('.ask-modal button:text-is("Add")')
  await alice.waitForTimeout(1500)
  await alice.waitForSelector('.board-row', { timeout: 15_000 })
  await alice.keyboard.press('Escape')

  const saved = await alice.evaluate(() => Object.fromEntries(Object.entries(localStorage)))
  const phone = await person('Alice', saved)
  await phone.goto(link)
  await phone.waitForSelector('.space-name', { timeout: 60_000 })

  const bob = await person('Bob')
  await bob.goto(link)
  await bob.waitForSelector('.space-name', { timeout: 60_000 })
  await bob.click('.rail-left .rail-item:has-text("lounge")')
  await bob.waitForSelector('.voice-head.on', { timeout: 10_000 })

  const offered = await phone
    .waitForSelector('.voice-bar button:has-text("Soundboard")', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check('the phone, not in the call, offers the soundboard', offered)
  const words = await phone.$$eval('.voice-bar', (els) => els.map((e) => `${e.className}: ${e.textContent}`).join(' | ')).catch(() => '')
  check('and says the call is on another device', words.includes('another device'), words)

  await phone.click('.voice-bar button:has-text("Soundboard")')
  await phone.waitForSelector('button[aria-label="Play Honk for everybody"]', { timeout: 15_000 })
  await bob.waitForTimeout(2000)
  // The ring is set once the sound has started playing there, so it also says the computer played it.
  const computerHears = alice.waitForFunction(sounding, null, { timeout: 10_000 }).then(() => true, () => false)
  await phone.click('button[aria-label="Play Honk for everybody"]')
  const heard = await bob.waitForFunction(sounding, null, { timeout: 10_000 }).then(() => true, () => false)
  check('somebody in the call hears it from the computer, with the ring round Alice', heard)

  check('the computer in the call plays it for its own person too', await computerHears)
  check(
    'and does not say that its own sounds are off',
    !(await alice.$$eval('.toast', (els) => els.some((t) => t.textContent.includes('sounds are off')))),
  )

  // The phone need not have the space open: from Home, the same soundboard is there.
  await phone.keyboard.press('Escape')
  await phone.click('button[aria-label="Switch space"]')
  await phone.click('.menu.switcher .menu-item:has-text("Home")')
  await phone.waitForSelector('.home-grid-shell')
  const fromHome = await phone
    .waitForSelector('.remote-board:not(.hidden) button:has-text("Soundboard")', { timeout: 15_000 })
    .then(() => true, () => false)
  check('on Home, with no space open, the phone offers the soundboard', fromHome)
  await bob.waitForFunction(() => !document.querySelector('.voice-member.sounding'), null, { timeout: 8000 }).catch(() => undefined)
  await phone.click('.remote-board button:has-text("Soundboard")')
  await phone.waitForSelector('button[aria-label="Play Honk for everybody"]', { timeout: 15_000 })
  await phone.click('button[aria-label="Play Honk for everybody"]')
  const heardAgain = await bob.waitForFunction(sounding, null, { timeout: 10_000 }).then(() => true, () => false)
  check('and a sound played there is heard in the call', heardAgain)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
