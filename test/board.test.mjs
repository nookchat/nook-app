import { APP_URL, AUTOPLAY, check, FAKE_MEDIA, finish, HOME, launch, makeSpace, openSpaceSettings, stoppedEarly } from './harness.mjs'

const browser = await launch({ args: [...FAKE_MEDIA, AUTOPLAY] })

const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector(HOME)
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
  await makeSpace(alice, 'the board')
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

  // A real pixel, because a picture that fails to load takes its own frame out of the message.
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
      border: style.borderTopWidth,
      hasImage: !!line.querySelector('.chat-image'),
    }
  })
  check('a picture message carries the mark', bare?.marked === true)
  check(
    'and nothing is drawn behind it or around it',
    bare?.background === 'rgba(0, 0, 0, 0)' && bare?.border === '0px',
    `${bare?.background ?? ''}, border ${bare?.border ?? ''}`,
  )
  check('the picture itself is there', bare?.hasImage === true)

  await say(alice, 'look at this https://example.com/cat.png')
  const withText = await alice.evaluate(() => {
    const line = [...document.querySelectorAll('.chat-line')].pop()
    const text = line?.querySelector('.chat-text')
    return {
      boxed: text?.classList.contains('boxed') === true,
      display: text ? getComputedStyle(text).display : '',
      above:
        text && line.querySelector('.chat-image-wrap')
          ? (text.compareDocumentPosition(line.querySelector('.chat-image-wrap')) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
          : false,
    }
  })
  check('words in the same message are marked', withText.boxed)
  check(
    'and sit on their own line, above the picture',
    withText.display === 'block' && withText.above,
    `${withText.display}, picture after the words: ${withText.above}`,
  )

  const TALL = await alice.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 300
    canvas.height = 900
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#8e44ad'
    ctx.fillRect(0, 0, 300, 900)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await alice.route('https://example.com/tall.png', (route) =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(TALL, 'base64') }),
  )

  // Enough lines to make the log scroll.
  for (let i = 0; i < 12; i += 1) await say(alice, `filling the channel, line ${i}`)
  await say(alice, 'https://example.com/tall.png')
  await alice.waitForTimeout(1200)
  const landed = await alice.evaluate(() => {
    const log = document.querySelector('.chat-log')
    const img = [...document.querySelectorAll('.chat-image')].pop()
    if (!log || !img) return null
    const below = log.scrollHeight - log.scrollTop - log.clientHeight
    return {
      below,
      cut: Math.round(img.getBoundingClientRect().bottom - log.getBoundingClientRect().bottom),
      tall: img.getBoundingClientRect().height > 100,
    }
  })
  check('the picture is a big one, so there is something to cut off', landed?.tall === true)
  check('the conversation follows it down as it loads', (landed?.below ?? 999) <= 4, `${landed?.below ?? '?'} px left below`)
  check('and none of it is left under the bottom edge', (landed?.cut ?? 999) <= 2, `${landed?.cut ?? '?'} px past the edge`)

  await alice.evaluate(() => {
    document.querySelector('.chat-log').scrollTop = 0
  })
  await alice.waitForTimeout(200)
  await alice.route('https://example.com/second.png', (route) =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(TALL, 'base64') }),
  )
  await say(bob, 'https://example.com/second.png')
  await alice.waitForTimeout(1500)
  const heldPlace = await alice.evaluate(() => document.querySelector('.chat-log').scrollTop)
  check('a picture arriving while you read history leaves you where you are', heldPlace < 60, `${heldPlace} px down`)

  const before = await alice.evaluate(() => location.href)
  await alice.evaluate(() => [...document.querySelectorAll('.chat-image-wrap')].pop().click())
  await alice.waitForTimeout(300)
  const closeUp = await alice.evaluate(() => {
    const box = document.querySelector('.lightbox')
    return {
      up: !!box?.querySelector('img, video'),
      here: location.href,
    }
  })
  check('a click opens the picture over the conversation', closeUp.up === true)
  check('and goes nowhere', closeUp.here === before)
  await alice.keyboard.press('Escape')
  await alice.waitForTimeout(200)
  const putAway = await alice.evaluate(() => !document.querySelector('.lightbox'))
  check('escape puts it away', putAway)

  // A real webm, because a clip that fails to load takes its own frame out of the message.
  const clipBytes = await alice.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 120
    canvas.height = 80
    const ctx = canvas.getContext('2d')
    const stream = canvas.captureStream(20)
    const chunks = []
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' })
    rec.ondataavailable = (e) => chunks.push(e.data)
    rec.start()
    for (let i = 0; i < 8; i += 1) {
      ctx.fillStyle = i % 2 ? '#e67e22' : '#8e44ad'
      ctx.fillRect(0, 0, 120, 80)
      await new Promise((done) => setTimeout(done, 40))
    }
    await new Promise((done) => {
      rec.onstop = done
      rec.stop()
    })
    const buffer = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()
    let binary = ''
    for (const b of new Uint8Array(buffer)) binary += String.fromCharCode(b)
    return btoa(binary)
  })
  await alice.route('https://example.com/dance.webm', (route) =>
    route.fulfill({ contentType: 'video/webm', body: Buffer.from(clipBytes, 'base64') }),
  )

  await say(alice, 'https://example.com/dance.webm')
  await alice.waitForTimeout(900)
  const played = await alice.evaluate(() => {
    const line = [...document.querySelectorAll('.chat-line')].pop()
    const video = line?.querySelector('video.chat-clip')
    if (!video) return null
    return {
      marked: line.classList.contains('has-picture'),
      loop: video.loop,
      muted: video.muted,
      controls: video.controls,
      started: video.currentTime > 0 || video.readyState >= 2,
    }
  })
  check('a webm link becomes a clip in the message', played !== null)
  check('drawn like a picture, with no bubble around it', played?.marked === true)
  check('it loops, it is muted, and it has no controls', played?.loop === true && played?.muted === true && played?.controls === false)
  check('and it plays on its own', played?.started === true)

  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="#076fef"/></svg>'
  await alice.fill(BOX, SVG)
  await alice.press(BOX, 'Enter')
  await alice.waitForTimeout(600)

  const drawn = await bob
    .waitForFunction(
      () => {
        const img = [...document.querySelectorAll('img.chat-image')].find((i) =>
          i.src.startsWith('data:image/svg+xml'),
        )
        return img && img.naturalWidth > 0 ? true : null
      },
      null,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('a posted svg draws as a picture on the other side', drawn)

  const sourceHidden = await bob.evaluate(
    () => ![...document.querySelectorAll('.chat-text')].some((t) => t.textContent.includes('<svg')),
  )
  check('and the markup itself is not shown', sourceHidden)

  const EVIL =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" onload="window.__pwned=1">' +
    '<script>window.__pwned=1<' + '/script>' +
    '<rect width="40" height="40" fill="#c00" onclick="window.__pwned=1"/></svg>'
  await alice.fill(BOX, EVIL)
  await alice.press(BOX, 'Enter')
  await alice.waitForTimeout(1200)
  const pwned = await Promise.all([
    alice.evaluate(() => window.__pwned === 1),
    bob.evaluate(() => window.__pwned === 1),
  ])
  check('a script inside an svg never runs, on either side', !pwned[0] && !pwned[1])
  // The app's own icons sit in the message actions and the channel intro, which no message can write into.
  const noSvgInPage = await bob.evaluate(
    () =>
      [...document.querySelectorAll('.chat-log svg')].filter(
        (el) => !el.closest('.chat-actions, .chat-intro'),
      ).length === 0,
  )
  check('and no svg element is ever parsed into the page', noSvgInPage)

  await say(alice, 'the <svg> element is my favourite')
  const stillText = await alice.evaluate(() =>
    [...document.querySelectorAll('.chat-text')].some((t) =>
      t.textContent.includes('the <svg> element is my favourite'),
    ),
  )
  check('an svg mentioned mid-sentence stays text', stillText)

  const limits = await alice.evaluate(async () => {
    const { MAX_TEXT, MAX_DM_BYTES, trimToBytes } = await import('/src/store/log.ts')
    return {
      MAX_TEXT,
      MAX_DM_BYTES,
      trimmed: trimToBytes('🎺🎺🎺', 9).length,
      whole: trimToBytes('🎺🎺🎺', 12).length,
    }
  })
  check('the limit is larger than it was', limits.MAX_TEXT > 4000, `${limits.MAX_TEXT} characters`)
  check(
    'a byte budget never cuts a character in half',
    limits.trimmed === 4 && limits.whole === 6,
    `${limits.trimmed} then ${limits.whole} units of UTF-16`,
  )

  const long = `long: ${'x'.repeat(limits.MAX_TEXT - 12)} end`
  await alice.fill(BOX, long)
  await alice.press(BOX, 'Enter')
  const arrived = await bob
    .waitForFunction(
      (want) => [...document.querySelectorAll('.chat-text')].some((e) => e.textContent.length >= want),
      long.length - 20,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('a message at the limit reaches the other browser whole', arrived, `${long.length} characters`)

  await alice.fill(BOX, 'x'.repeat(limits.MAX_TEXT + 50))
  await alice.waitForTimeout(200)
  const over = await alice.evaluate(() => ({
    said: document.querySelector('.chat-room-left')?.textContent ?? '',
    red: document.querySelector('.chat-room-left')?.classList.contains('over') === true,
    sendOff: document.querySelector('.chat-compose button:last-child')?.disabled === true,
  }))
  check('over the limit the box says by how much', over.said.includes('too many'), over.said)
  check('and Send stops working', over.red && over.sendOff)

  await alice.press(BOX, 'Enter')
  await alice.waitForTimeout(400)
  const stayed = await alice.inputValue(BOX)
  check('and Enter leaves it in the box rather than losing it', stayed.length > limits.MAX_TEXT)

  await alice.fill(BOX, 'back to normal')
  await alice.waitForTimeout(200)
  const quiet = await alice.evaluate(
    () => document.querySelector('.chat-room-left')?.classList.contains('hidden') === true,
  )
  check('and the count is out of the way when there is room', quiet)
  await alice.fill(BOX, '')

  const hiddenOutside = await alice.evaluate(() => !document.querySelector('button[aria-label="Soundboard"]'))
  check('the soundboard is not offered outside a voice channel', hiddenOutside === true)
  await alice.click('.rail-left .rail-item:has-text("lounge")')
  await alice.waitForSelector('.voice-bar button[aria-label="Soundboard"]', { timeout: 10_000 })
  check('it sits in the voice bar, bottom left', true)
  await alice.click('button[aria-label="Soundboard"]')
  await alice.waitForSelector('.sound-pop')
  const builtIn = await alice.$$eval('.sound-cell:not(.sound-add)', (els) => els.length)
  check('the board has no built-in sounds, only a way to add one', builtIn === 0, `${builtIn} sounds`)

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
  const chooser = alice.waitForEvent('filechooser')
  await alice.click('button[aria-label="Add a sound"]')
  await (await chooser).setFiles({ name: 'honk.wav', mimeType: 'audio/wav', buffer: wav })
  await alice.waitForSelector('.ask-modal .sound-face')
  await alice.fill('.ask-modal .ask-input', 'Honk')
  await alice.click('.ask-modal .sound-face')
  await alice.fill('.emoji-search', 'duck')
  await alice.locator('.emoji-pop .emoji-cell').first().click()
  const face = await alice.textContent('.ask-modal .sound-face')
  check('a sound gets its own emoji, from the picker', face && face !== '🔊', face)
  await alice.click('.ask-modal button:text-is("Add")')
  await alice.waitForTimeout(1500)
  await alice.click('button[aria-label="Soundboard"]')
  await alice.waitForSelector('button[aria-label="Play Honk for everybody"]', { timeout: 15_000 })
  const shown = await alice.textContent('button[aria-label="Play Honk for everybody"] .sound-emoji')
  check('and the board shows it with that emoji', shown === face, shown)

  await alice.click('button[aria-label="Play Honk for everybody"]')
  // No toast: the ring round the face of whoever played it says who.
  const outside = await bob
    .waitForFunction(
      () => [...document.querySelectorAll('.voice-member.talking.sounding')].some((m) => m.dataset.sound === 'Honk' && m.textContent.includes('Alice')),
      null,
      { timeout: 3000 },
    )
    .then(() => true)
    .catch(() => false)
  check('somebody who is not in the voice channel does not hear it', !outside)

  await bob.click('.rail-left .rail-item:has-text("lounge")')
  await bob.waitForSelector('.voice-head.on', { timeout: 10_000 })
  await bob.waitForTimeout(2000)
  await alice.click('button[aria-label="Play Honk for everybody"]')
  const heard = await bob
    .waitForFunction(
      () => [...document.querySelectorAll('.voice-member.talking.sounding')].some((m) => m.dataset.sound === 'Honk' && m.textContent.includes('Alice')),
      null,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('somebody in the voice channel hears it, with the ring round Alice', heard)
  check(
    'and no toast says so',
    !(await bob.$$eval('.toast', (els) => els.some((t) => t.textContent.includes('played Honk')))),
  )
  const ringGoes = await bob
    .waitForFunction(() => !document.querySelector('.voice-member.sounding'), null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  check('the ring goes when the sound ends', ringGoes)

  const wrote = await bob.$$eval('.chat-text', (els) => els.some((e) => e.textContent.includes('Honk')))
  check('and nothing is written into the channel', !wrote)

  check(
    'the board stays open, so it can be played',
    await alice.$eval('.sound-pop', () => true).catch(() => false),
  )

  await alice.click('button[aria-label="Play Honk for everybody"]', { button: 'right' })
  await alice.click('.menu-item:has-text("Change the name or emoji")')
  await alice.waitForSelector('.ask-modal .sound-face')
  await alice.fill('.ask-modal .ask-input', 'Quack')
  await alice.click('.ask-modal button:text-is("Save")')
  const renamed = await bob
    .waitForFunction(async () => {
      const { spaces } = await import('/src/space/registry.ts')
      return spaces.all()[0]?.chat.boardSounds().some((b) => b.label === 'Quack')
    }, null, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('whoever added it can rename it, for everybody', renamed)

  await bob.waitForTimeout(1600)
  await say(alice, '/sound quack')
  const byName = await bob
    .waitForFunction(
      () => [...document.querySelectorAll('.voice-member.talking.sounding')].some((m) => m.dataset.sound === 'Quack' && m.textContent.includes('Alice')),
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

  // A tone of any length, as a mono 16-bit WAV file.
  const tone = (seconds) => {
    const n = Math.round(rate * seconds)
    const out = Buffer.alloc(44 + n * 2)
    out.write('RIFF', 0)
    out.writeUInt32LE(36 + n * 2, 4)
    out.write('WAVEfmt ', 8)
    out.writeUInt32LE(16, 16)
    out.writeUInt16LE(1, 20)
    out.writeUInt16LE(1, 22)
    out.writeUInt32LE(rate, 24)
    out.writeUInt32LE(rate * 2, 28)
    out.writeUInt16LE(2, 32)
    out.writeUInt16LE(16, 34)
    out.write('data', 36)
    out.writeUInt32LE(n * 2, 40)
    for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 330) * 9000), 44 + i * 2)
    return out
  }
  // A sound longer than one may play opens on its waveform, and only the part picked goes out.
  await alice.click('button[aria-label="Soundboard"]')
  await alice.waitForSelector('.sound-pop')
  const longChooser = alice.waitForEvent('filechooser')
  await alice.click('button[aria-label="Add a sound"]')
  await (await longChooser).setFiles({ name: 'long tone.wav', mimeType: 'audio/wav', buffer: tone(25) })
  await alice.waitForSelector('.sound-maker .sound-wave')
  check('a long sound opens with a small waveform of all of it', await alice.$eval('.sound-maker .sound-overview', () => true).catch(() => false))
  const picked = await alice.textContent('.sound-maker .clip-controls .tiny.faint')
  check('and the part picked at first is ten seconds', picked?.startsWith('10.0 s'), picked)
  const nameFirst = await alice.inputValue('.sound-maker .ask-input')
  check('its name comes from the file', nameFirst === 'long tone', nameFirst)
  await alice.fill('.sound-maker .ask-input', 'Long')
  await alice.click('.sound-maker button:text-is("Add")')
  const longShown = await alice
    .waitForSelector('button[aria-label="Play Long for everybody"]', { state: 'attached', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('and the board shows it', longShown || (await alice.click('button[aria-label="Soundboard"]'), await alice.waitForSelector('button[aria-label="Play Long for everybody"]', { timeout: 15_000 }).then(() => true).catch(() => false)))
  if (await alice.$('.sound-pop')) await alice.keyboard.press('Escape')
  // Ten seconds of it, cut from the middle: mono at 44.1 kHz, 16-bit, and the 44 bytes before it.
  const cutOut = await alice.evaluate(async (bytes) => {
    const { cutPart } = await import('/src/ui/sound-maker.ts')
    const buffer = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(new Uint8Array(bytes).buffer)
    const file = await cutPart(buffer, 7, 17, 'Long')
    return { name: file.name, size: file.size }
  }, [...tone(25)])
  check('only the part picked goes out, as a WAV file', cutOut.name === 'Long.wav' && cutOut.size === 44 + 441000 * 2, JSON.stringify(cutOut))

  // Groups: anybody who may add a sound may make one and sort the board.
  await alice.click('button[aria-label="Soundboard"]')
  await alice.waitForSelector('.sound-pop')
  await alice.click('.sound-pop button:text-is("New group")')
  await alice.waitForSelector('.ask-modal .sound-face')
  await alice.fill('.ask-modal .ask-input', 'Memes')
  await alice.click('.ask-modal button:text-is("Make")')
  const madeGroup = await alice
    .waitForSelector('.sound-pop .sound-group-head:has-text("Memes")', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('a new group shows on the board', madeGroup)
  await alice.click('button[aria-label="Play Quack for everybody"]', { button: 'right' })
  await alice.click('.menu-item:has-text("Memes")')
  const moved = await alice
    .waitForSelector('.sound-group[aria-label="Memes"] button[aria-label="Play Quack for everybody"]', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('a sound moves into a group from its menu', moved)
  await alice.click('.sound-group-head:has-text("Memes")')
  check('a group folds shut', await alice.$eval('.sound-group[aria-label="Memes"]', (el) => el.classList.contains('folded')))
  await alice.click('button[aria-label="Soundboard"]')
  await alice.click('button[aria-label="Soundboard"]')
  await alice.waitForSelector('.sound-pop')
  check('and stays shut the next time', await alice.$eval('.sound-group[aria-label="Memes"]', (el) => el.classList.contains('folded')))
  await alice.click('.sound-group-head:has-text("Memes")')

  const groupChooser = alice.waitForEvent('filechooser')
  await alice.click('button[aria-label="Add a sound to Memes"]')
  await (await groupChooser).setFiles({ name: 'beep.wav', mimeType: 'audio/wav', buffer: wav })
  await alice.waitForSelector('.sound-maker .sound-group-pick')
  const inGroup = await alice.$eval('.sound-maker .sound-group-pick', (el) => el.selectedOptions[0]?.textContent ?? '')
  check('a sound added from a group goes in that group', inGroup.endsWith('Memes'), inGroup)
  await alice.click('.sound-maker button:text-is("Cancel")')

  await alice.click('button[aria-label="Soundboard"]')
  await alice.waitForSelector('.sound-pop')
  alice.once('dialog', (d) => void d.accept())
  await alice.click('.sound-group-head:has-text("Memes")', { button: 'right' })
  await alice.click('.menu-item:has-text("Take Memes off")')
  const loose = await alice
    .waitForSelector('.sound-pop > .sound-sections > .sound-grid button[aria-label="Play Quack for everybody"]', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('a group taken off leaves its sounds on the board, outside any group', loose && !(await alice.$('.sound-group')))
  await alice.keyboard.press('Escape')

  // In the desktop app a sound can come from a YouTube link. The shell is stood in for here.
  const ytWav = [...tone(40)]
  await alice.evaluate((bytes) => {
    window.nookDesktop = { youtubeAudio: async () => ({ title: 'A song from YouTube', bytes: new Uint8Array(bytes), type: 'audio/wav' }) }
  }, ytWav)
  await alice.click('button[aria-label="Soundboard"]')
  await alice.waitForSelector('.sound-pop')
  await alice.click('button[aria-label="Add a sound"]')
  await alice.waitForSelector('.sound-maker input[aria-label="A YouTube link"]')
  await alice.fill('.sound-maker input[aria-label="A YouTube link"]', 'https://example.com/watch?v=x')
  await alice.press('.sound-maker input[aria-label="A YouTube link"]', 'Enter')
  const refused = await alice.textContent('.sound-maker .sound-status')
  check('a link that is not YouTube is refused', refused?.includes('not a YouTube link'), refused)
  await alice.fill('.sound-maker input[aria-label="A YouTube link"]', 'https://youtu.be/dQw4w9WgXcQ?t=12')
  await alice.press('.sound-maker input[aria-label="A YouTube link"]', 'Enter')
  await alice.waitForSelector('.sound-maker .sound-wave')
  const startsAt = await alice.getAttribute('.sound-maker .clip-handle.start', 'aria-valuenow')
  check('a YouTube link opens on its waveform, from the t= in the link', startsAt === '12', startsAt)
  const ytName = await alice.inputValue('.sound-maker .ask-input')
  check('and its name comes from the video', ytName === 'A song from YouTube', ytName)
  await alice.click('.sound-maker button:text-is("Cancel")')
  await alice.evaluate(() => delete window.nookDesktop)

  // The same board, in Space settings: every sound, to hear, rename, sort into a group, or take off.
  await openSpaceSettings(alice, 'soundboard')
  await alice.waitForSelector('.board-row')
  const listed = await alice.$$eval('.board-row .switch-label', (els) => els.map((e) => e.textContent))
  check('Space settings lists every sound on the board', listed.includes('Quack') && listed.includes('Long'), listed.join(', '))
  await alice.click('.settings-page button:has-text("New group")')
  await alice.waitForSelector('.ask-modal .sound-face')
  await alice.fill('.ask-modal .ask-input', 'Loud')
  await alice.click('.ask-modal button:text-is("Make")')
  const madeThere = await alice
    .waitForSelector('.settings-section:has(.eyebrow:has-text("Loud"))', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('a group can be made there', madeThere)
  const loudId = await alice.$eval('select[aria-label="Group of Long"]', (el) => [...el.options].find((o) => o.textContent.endsWith('Loud'))?.value ?? '')
  await alice.selectOption('select[aria-label="Group of Long"]', loudId)
  const sorted = await alice
    .waitForSelector('.settings-section:has(.eyebrow:has-text("Loud")) .board-row:has-text("Long")', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('and a sound moves into it from its row', sorted)
  await alice.click('button[aria-label="Change Long"]')
  await alice.waitForSelector('.ask-modal .sound-face')
  await alice.fill('.ask-modal .ask-input', 'Longer')
  await alice.click('.ask-modal button:text-is("Save")')
  const renamedThere = await alice
    .waitForSelector('.board-row .switch-label:text-is("Longer")', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('and renamed there', renamedThere)
  await alice.click('button[aria-label="Close settings"]:visible')

  // No key and no archive here, so the grid is empty.
  await alice.click('button[aria-label="Find a GIF"]')
  await alice.waitForSelector('.gif-pop')
  // The server is asked whether it can search, so the answer takes a moment.
  await alice
    .waitForFunction(() => !document.querySelector('.gif-pop')?.textContent?.includes('Looking'), null, { timeout: 8000 })
    .catch(() => undefined)
  const missing = await alice.$eval('.gif-pop', (el) => el.textContent)
  check('the picker opens from a button', missing.includes('GIFs'))
  check('a search box comes with it', await alice.$('.gif-search').then((el) => !!el))
  check('and it says what is missing, in the box', missing.includes('GIF search is off'), missing.slice(0, 80))

  await alice.keyboard.press('Escape')
  check('escape closes it', await alice.$('.gif-pop').then((el) => el === null))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
