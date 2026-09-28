import { APP_URL, FAKE_MEDIA, check, finish, launch, stoppedEarly } from './harness.mjs'

// A web update reloads the page. Before it, the page notes the call; after it, it joins again by itself.
const browser = await launch({ args: FAKE_MEDIA })

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await context.addInitScript((n) => localStorage.setItem('nook.name.v1', n), name)
  const page = await context.newPage()
  return page
}

const inLounge = (page) => page.$eval('.voice-channel .voice-head', (el) => el.classList.contains('on')).catch(() => false)
const loungeNames = (page) =>
  page.$$eval('.voice-channel .voice-member', (els) => els.map((e) => `${e.textContent.trim()}${e.classList.contains('updating') ? ' [updating]' : ''}`))
const until = (page, fn, arg, ms = 20_000) =>
  page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false)

try {
  const alice = await person('Alice')
  await alice.goto(APP_URL)
  await alice.waitForSelector('input[aria-label="Space name"]')
  await alice.fill('input[aria-label="Space name"]', 'resume')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(1200)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector('.space-name')
  await bob.waitForTimeout(1200)

  await alice.click('.voice-join')
  await bob.click('.voice-join')
  await alice.click('button.voice-tool[aria-label="Mute"]')
  const met = await until(bob, () => [...document.querySelectorAll('.voice-member')].some((e) => e.textContent.includes('Alice')))
  check('both are in the lounge', met && (await inLounge(alice)) && (await inLounge(bob)))
  const mutedBefore = await alice.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    return spaces.all().find((s) => s.voice?.state.channel)?.voice.state.muted
  })

  // What the update's Update now does before the reload.
  await alice.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    const { noteForUpdate } = await import('/src/space/resume.ts')
    const space = spaces.all().find((s) => s.voice?.state.channel)
    const { channel, muted, deafened } = space.voice.state
    noteForUpdate({ room: space.room.id, channel, muted, deafened }, null)
    for (const s of spaces.all()) s.announce()
  })
  check(
    'the others see that Alice is updating',
    await until(bob, () => [...document.querySelectorAll('.person-doing')].some((e) => e.textContent.includes('Updating Nook'))),
  )

  // Bob's lounge is watched through the whole reload: Alice never leaves it.
  await bob.evaluate(() => {
    window.__gaps = 0
    window.__watch = setInterval(() => {
      const there = [...document.querySelectorAll('.voice-member')].some((e) => e.textContent.includes('Alice'))
      if (!there) window.__gaps++
    }, 50)
  })
  await alice.reload()
  await alice.waitForSelector('.space-name')

  const back = await until(alice, () => document.querySelector('.voice-channel .voice-head')?.classList.contains('on') === true)
  check('after the reload Alice is back in the lounge, with no click', back)
  const mutedAfter = await alice.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    return spaces.all().find((s) => s.voice?.state.channel)?.voice.state.muted
  })
  check('and muted as she was', mutedBefore === true && mutedAfter === true, `${mutedBefore} -> ${mutedAfter}`)
  const bobSees = await until(bob, () =>
    [...document.querySelectorAll('.voice-member')].some((e) => e.textContent.includes('Alice') && !e.classList.contains('updating')),
  )
  check('Bob sees her back in the lounge', bobSees, (await loungeNames(bob)).join(', '))
  const gaps = await bob.evaluate(() => {
    clearInterval(window.__watch)
    return window.__gaps
  })
  check('and she was in his lounge the whole time, if only faint', gaps === 0, `${gaps} looks without her`)
  check(
    'and no longer as updating',
    await until(bob, () => ![...document.querySelectorAll('.person-doing')].some((e) => e.textContent.includes('Updating Nook'))),
  )
  const heard = await until(alice, () => [...document.querySelectorAll('audio.voice-sink')].some((a) => a.srcObject?.getAudioTracks().length), undefined, 20_000)
  check('the call to Bob comes up again', heard)
  const held = await alice.$$eval('.toast', (els) => els.some((t) => t.textContent.includes('Hear the call')))
  console.log(`  (the browser ${held ? 'held the sound back until a click' : 'let the sound play with no click'})`)
  if (held) {
    await alice.click('.toast button:has-text("Hear the call")')
    const running = await alice.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 300))
      return [...document.querySelectorAll('audio.voice-sink')].every((a) => !a.srcObject || !a.paused)
    })
    check('one click lets the sound go', running)
  }
  const stale = await alice.evaluate(() => sessionStorage.getItem('nook.resume.voice.v1'))
  check('the note is used once', stale === null)

  // A browser that holds sound back until a click. Headless Chrome never does, so a stand-in
  // context plays that part: it stays suspended until something resumes it after the click.
  const fresh = await person('Carol')
  await fresh.goto(APP_URL)
  await fresh.waitForTimeout(1000)
  const state = await fresh.evaluate(async () => {
    const { watchContext } = await import('/src/net/unlock.ts')
    let clicked = false
    window.addEventListener('pointerdown', () => (clicked = true), true)
    window.__ctx = {
      state: 'suspended',
      resume() {
        if (clicked) this.state = 'running'
        return Promise.resolve()
      },
    }
    watchContext(window.__ctx)
    await new Promise((r) => setTimeout(r, 600))
    return window.__ctx.state
  })
  const asked = await fresh.$$eval('.toast', (els) => els.some((t) => t.textContent.includes('Hear the call')))
  check('with no click, the sound waits and the page asks for one', state === 'suspended' && asked, state)
  await fresh.click('.toast button:has-text("Hear the call")')
  const after = await fresh.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 300))
    return window.__ctx.state
  })
  check('and that click lets it go', after === 'running', after)
} catch (err) {
  stoppedEarly(err)
}

await browser.close()
finish()
