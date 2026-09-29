import { APP_URL, FAKE_MEDIA, check, finish, launch, stoppedEarly } from './harness.mjs'

// A share that starts plays a sound: for whoever shares, and for the others in their voice
// channel. One already going when you arrive does not. And the zoom on a stream works from
// its buttons, however fast they are pressed.
const browser = await launch({ args: FAKE_MEDIA })

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.addInitScript((n) => {
    localStorage.setItem('nook.name.v1', n)
    // Each sound played, by the length of its clip.
    window.__played = []
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer) window.__played.push(Math.round(this.buffer.duration * 100) / 100)
      return start.apply(this, args)
    }
  }, name)
  return context.newPage()
}

/** The length of the stream sound's clip, which tells it from the others. */
const streamLength = (page) =>
  page.evaluate(async () => {
    const bytes = await (await fetch('/sounds/stream.mp3')).arrayBuffer()
    const clip = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes)
    return Math.round(clip.duration * 100) / 100
  })
let STREAM_S = 0
const streamSounds = (page) => page.evaluate((s) => window.__played.filter((d) => d === s).length, STREAM_S)
const until = (page, fn, arg, ms = 20_000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false)

try {
  const alice = await person('Alice')
  await alice.goto(APP_URL)
  await alice.waitForSelector('input[aria-label="Space name"]')
  await alice.fill('input[aria-label="Space name"]', 'streams')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  STREAM_S = await streamLength(alice)
  const link = alice.url()
  const bob = await person('Bob')
  await bob.goto(link)
  await bob.waitForSelector('.space-name')
  const carol = await person('Carol')
  await carol.goto(link)
  await carol.waitForSelector('.space-name')
  await alice.waitForTimeout(1500)

  await alice.click('.voice-join')
  await bob.click('.voice-join')
  await until(bob, () => [...document.querySelectorAll('.voice-member')].some((e) => e.textContent.includes('Alice')))

  await alice.click('button[aria-label="Share screen"]')
  check('Alice hears her own share start', await until(alice, (s) => window.__played.includes(s), STREAM_S, 8000))
  check('Bob, in her voice channel, hears it start', await until(bob, (s) => window.__played.includes(s), STREAM_S, 8000))
  await carol.waitForTimeout(2000)
  check('Carol, not in voice, hears nothing', (await streamSounds(carol)) === 0)
  check('it plays once each', (await streamSounds(alice)) === 1 && (await streamSounds(bob)) === 1)

  const dave = await person('Dave')
  await dave.goto(link)
  await dave.waitForSelector('.space-name')
  await dave.waitForTimeout(1500)
  await dave.click('.voice-join')
  await until(dave, () => [...document.querySelectorAll('.voice-member')].some((e) => e.textContent.includes('Alice')))
  await dave.waitForTimeout(2000)
  check('Dave, who comes to a share already going, hears no start', (await streamSounds(dave)) === 0)

  // The zoom, on Alice's own picture.
  const surface = alice.locator('.stage-tile .surface').first()
  await surface.waitFor({ timeout: 10_000 })
  await surface.hover()
  check('the picture is at actual size, with the zoom buttons', (await surface.getAttribute('data-mode')) === 'actual' && (await surface.locator('.zoom-label').isVisible()))
  check('and no other way to fit it', (await surface.locator('button[title*="(Z)"]').count()) === 0)
  check('your own screen has no tag over it', !(await alice.locator('.stage-tile .stage-tag:not(.hidden)').count()))
  const label = () => surface.locator('.zoom-label').textContent()
  await alice.waitForTimeout(150)
  const before = await label()
  await surface.locator('button[aria-label="Zoom in"]').click()
  await alice.waitForTimeout(150)
  const once = await label()
  check('Zoom in zooms in', parseInt(once) > parseInt(before), `${before} -> ${once}`)
  await surface.locator('button[aria-label="Zoom in"]').click()
  await surface.locator('button[aria-label="Zoom in"]').click({ delay: 10 })
  await alice.waitForTimeout(150)
  check('two quick presses zoom twice, and do not leave actual size', (await surface.getAttribute('data-mode')) === 'actual' && parseInt(await label()) > parseInt(once), `${await surface.getAttribute('data-mode')} ${await label()}`)
  const high = await label()
  await surface.locator('button[aria-label="Zoom out"]').click()
  await alice.waitForTimeout(150)
  check('Zoom out zooms out', parseInt(await label()) < parseInt(high), `${high} -> ${await label()}`)
  await surface.locator('button:has-text("Reset")').click()
  await alice.waitForTimeout(150)
  check('Reset goes back', (await label()) === before, `${await label()}`)
  await surface.locator('button[aria-label="Full window (W)"]').click()
  const covers = await surface.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return el.classList.contains('full-window') && box.width === window.innerWidth && box.height >= window.innerHeight - 40
  })
  check('Full window covers the window', covers)
  await alice.keyboard.press('Escape')
  check('the bar closes the stream: Stop sharing, on your own', (await surface.locator('button[aria-label="Stop sharing"]').count()) === 1)
  check('and Escape puts it back, with the stream still on', !(await surface.evaluate((el) => el.classList.contains('full-window'))) && (await surface.isVisible()))

  // The bar shows while the pointer moves, and goes when it rests, even after a click on the picture.
  const barHidden = () => surface.evaluate((el) => el.classList.contains('hide-bar'))
  const box = await surface.boundingBox()
  await alice.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
  await alice.mouse.click(box.x + box.width / 2, box.y + box.height / 3)
  await alice.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 3)
  check('moving over the stream shows its bar', !(await barHidden()))
  await alice.waitForTimeout(3400)
  check('with the pointer still, the bar goes, even after a click on the picture', await barHidden())
  await alice.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 3 + 10)
  check('a move brings it back', !(await barHidden()))
  await alice.waitForTimeout(3400)
  await surface.evaluate((el, at) => el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, ...at })), {
    clientX: box.x + box.width / 2 + 60,
    clientY: box.y + box.height / 3 + 10,
  })
  check('a move to where the pointer already is, as a scroll sends, does not', await barHidden())

  // The player for a video in the chat, playing a moving picture.
  await alice.evaluate(async () => {
    const { videoPlayer } = await import('/src/ui/video-player.ts')
    const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 })
    const pen = canvas.getContext('2d')
    let n = 0
    setInterval(() => {
      pen.fillStyle = `hsl(${(n += 7) % 360} 70% 50%)`
      pen.fillRect(0, 0, 320, 180)
    }, 40)
    const player = videoPlayer('test video', 30)
    Object.assign(player.root.style, { position: 'fixed', left: '40px', top: '40px', width: '480px', height: '270px', zIndex: 9999 })
    player.root.id = 'test-player'
    document.body.append(player.root)
    player.video.srcObject = canvas.captureStream(25)
    player.video.muted = true
    await player.video.play()
  })
  const idle = () => alice.evaluate(() => document.getElementById('test-player').classList.contains('idle'))
  await alice.mouse.move(200, 120)
  await alice.mouse.move(230, 130)
  check('moving over a playing video shows its controls', !(await idle()))
  await alice.waitForTimeout(2800)
  check('with the pointer still, they go', await idle())
  await alice.mouse.move(260, 150)
  check('a move brings them back', !(await idle()))
  await alice.click('#test-player .vp-bar button[aria-label^="Pause"]')
  await alice.click('#test-player .vp-bar button[aria-label^="Play"]')
  await alice.mouse.move(250, 120)
  await alice.waitForTimeout(2800)
  check('after a click on Play, they still go when the pointer rests', await idle())
  await alice.mouse.move(700, 600)
  await alice.waitForTimeout(300)
  check('and they go when the pointer leaves', await idle())
} catch (err) {
  stoppedEarly(err)
}

await browser.close()
finish()
