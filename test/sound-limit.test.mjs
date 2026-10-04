import { APP_URL, AUTOPLAY, check, FAKE_MEDIA, finish, HOME, launch, makeSpace, poll, stoppedEarly } from './harness.mjs'

// Twenty soundboard sounds an hour for each person. The one who plays keeps the count, and so does
// each listener, because a changed app keeps no count.
const browser = await launch({ args: [...FAKE_MEDIA, AUTOPLAY] })

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector(HOME)
  return page
}

// Half a second of a tone, as a WAV file, to add.
function honk() {
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
  return wav
}

try {
  const alice = await person('Alice')

  const hour = await alice.evaluate(async () => {
    const { SOUNDS_PER_HOUR, soundTurn, soundWait } = await import('/src/ui/soundboard.ts')
    const heard = new Map()
    const start = 1_000_000_000
    let taken = 0
    for (let i = 0; i < SOUNDS_PER_HOUR + 5; i++) if (soundTurn(heard, 'k', start + i * 1000)) taken++
    return {
      taken,
      wait: soundWait(heard.get('k') ?? [], start + 30_000),
      other: soundTurn(heard, 'someone else', start + 30_000),
      late: soundTurn(heard, 'k', start + 60 * 60 * 1000 + 500),
    }
  })
  check('a listener plays twenty sounds an hour from one person, and drops the rest', hour.taken === 20, String(hour.taken))
  check('and the one past it is told how long to wait', hour.wait > 0, String(hour.wait))
  check('another person has their own twenty', hour.other)
  check('and the first one an hour on frees a place again', hour.late)

  await makeSpace(alice, 'the limit')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(900)
  const link = alice.url()
  const bob = await person('Bob')
  await bob.goto(link)
  await bob.waitForFunction(() => document.querySelector('.space-name')?.textContent === 'the limit', null, { timeout: 60_000 })

  await alice.click('.rail-left .rail-item:has-text("lounge")')
  await alice.waitForSelector('.voice-bar button[aria-label="Soundboard"]', { timeout: 10_000 })
  await alice.click('button[aria-label="Soundboard"]')
  await alice.waitForSelector('.sound-pop')
  const chooser = alice.waitForEvent('filechooser')
  await alice.click('button[aria-label="Add a sound"]')
  await (await chooser).setFiles({ name: 'honk.wav', mimeType: 'audio/wav', buffer: honk() })
  await alice.waitForSelector('.ask-modal .sound-face')
  await alice.fill('.ask-modal .ask-input', 'Honk')
  await alice.click('.ask-modal button:text-is("Add")')
  await alice.waitForTimeout(1500)

  await bob.click('.rail-left .rail-item:has-text("lounge")')
  await bob.waitForSelector('.voice-head.on', { timeout: 10_000 })
  await bob.waitForFunction(
    async () => {
      const { spaces } = await import('/src/space/registry.ts')
      return spaces.all()[0]?.chat.boardSounds().some((b) => b.label === 'Honk')
    },
    null,
    { timeout: 15_000 },
  )
  await bob.waitForTimeout(2000)
  // Each sound that plays starts one source, so the count of starts is the count of sounds heard.
  await bob.evaluate(() => {
    window.__started = 0
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__started++
      return start.apply(this, args)
    }
  })

  await alice.click('button[aria-label="Soundboard"]')
  await alice.waitForSelector('button[aria-label="Play Honk for everybody"]', { timeout: 15_000 })
  for (let i = 0; i < 25; i++) {
    await alice.click('button[aria-label="Play Honk for everybody"]')
    await alice.waitForTimeout(250)
  }
  const told = await alice.$$eval('.toast', (els) => els.find((t) => t.textContent.includes('sounds in the last hour'))?.textContent ?? '')
  check('the one who plays is told when the hour is used up', told.includes('20 sounds'), told)
  check('and how long until the next one', /in (59|60) minutes/.test(told), told)

  const heard = await poll(() => bob.evaluate(() => (window.__started >= 20 ? window.__started : 0)), 10_000)
  await bob.waitForTimeout(1500)
  const total = await bob.evaluate(() => window.__started)
  check('the listener hears twenty, and no more', heard && total === 20, `${total} heard`)

  // A reload does not start the hour again.
  await alice.reload()
  await alice.waitForSelector('.space-name', { timeout: 60_000 })
  await alice.click('.rail-left .rail-item:has-text("lounge")')
  await alice.waitForSelector('.voice-bar button[aria-label="Soundboard"]', { timeout: 10_000 })
  await alice.click('button[aria-label="Soundboard"]')
  await alice.waitForSelector('button[aria-label="Play Honk for everybody"]', { timeout: 15_000 })
  await alice.click('button[aria-label="Play Honk for everybody"]')
  const still = await poll(
    () => alice.$$eval('.toast', (els) => els.some((t) => t.textContent.includes('sounds in the last hour'))),
    3000,
  )
  check('after a reload the hour still counts', still)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
