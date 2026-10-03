import { APP_URL, FAKE_MEDIA, check, finish, launch, stoppedEarly } from './harness.mjs'

// Inline spoilers: writing one highlights it yellow and keeps it editable as plain `||..||`
// text; sending it conceals it behind an animated veil that scratches, clicks or taps open.
const browser = await launch({ args: FAKE_MEDIA })

try {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage()
  await page.goto(APP_URL)
  await page.waitForSelector('input[aria-label="Space name"]')

  await page.evaluate(async () => {
    const { ChatPanel } = await import('/src/ui/chat-panel.ts')
    const panel = new ChatPanel('me-key', 'Chat')
    document.body.append(panel.root)
    panel.me = 'me-key'
    panel.names = new Map([['me-key', 'Me']])
    window.__messages = []
    panel.actions = {
      say: (text) => {
        window.__messages.push({
          id: String(window.__messages.length).padStart(64, '0'),
          author: 'me-key',
          name: 'Me',
          channel: 'general',
          at: Date.now(),
          lamport: window.__messages.length,
          text,
          replyTo: null,
          edited: false,
          retracted: false,
          reactions: new Map(),
        })
        panel.render(window.__messages)
      },
      edit: () => {},
      react: () => {},
      retract: () => {},
      rename: () => {},
      pin: () => {},
      vote: () => {},
    }
    window.__panel = panel
    panel.setEnabled(true)
    panel.render([])
  })

  const box = page.locator('[aria-label="Write a message"]')
  await box.click()
  await box.type('This character dies at the end')

  // Selecting "dies" offers to wrap it as a spoiler.
  await page.evaluate(() => {
    const input = window.__panel.textInput
    const at = input.value.indexOf('dies')
    input.focus()
    input.setSelectionRange(at, at + 4)
    input.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
  check('"Create spoiler" appears over a selection', await page.locator('.spoiler-bar-action:has-text("Create spoiler")').count() === 1)
  await page.click('.spoiler-bar-action:has-text("Create spoiler")')
  check(
    'it wraps the selection in `||`',
    (await page.evaluate(() => window.__panel.textInput.value)) === 'This character ||dies|| at the end',
  )
  check('the composer marks it with a yellow highlight', await page.locator('.emoji-mirror .field-mark-spoiler').count() === 1)

  // Typing right after "dies", inside the mark, extends the spoiler rather than escaping it.
  await page.evaluate(() => {
    const input = window.__panel.textInput
    const at = input.value.indexOf('dies') + 4
    input.focus()
    input.setSelectionRange(at, at)
  })
  await page.keyboard.type(' horribly')
  check(
    'typing inside the mark extends it',
    (await page.evaluate(() => window.__panel.textInput.value)) === 'This character ||dies horribly|| at the end',
  )

  // Clicking back inside it offers to remove the spoiler, text left untouched.
  await page.evaluate(() => {
    const input = window.__panel.textInput
    const at = input.value.indexOf('horribly')
    input.focus()
    input.setSelectionRange(at, at)
    input.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
  check('"Remove spoiler" appears with the caret inside one', await page.locator('.spoiler-bar-action:has-text("Remove spoiler")').count() === 1)
  await page.click('.spoiler-bar-action:has-text("Remove spoiler")')
  check(
    'it strips the `||` markers, text unchanged',
    (await page.evaluate(() => window.__panel.textInput.value)) === 'This character dies horribly at the end',
  )
  check('the yellow highlight is gone', await page.locator('.emoji-mirror .field-mark-spoiler').count() === 0)

  // Typing the `||..||` markdown directly gets the same yellow treatment.
  await page.evaluate(() => {
    window.__panel.textInput.value = ''
    window.__panel.textInput.focus()
  })
  await page.keyboard.type("I can't believe ||John was the killer||")
  check('the `||..||` shortcut marks it yellow too', await page.locator('.emoji-mirror .field-mark-spoiler').count() === 1)

  // Sent, it's concealed behind an animated veil -- the text is still in the DOM underneath.
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  check('the sent message is concealed, not yellow', await page.locator('.chat-row .spoiler-box:not(.revealed)').count() === 1)
  check('it has an animated veil canvas', await page.locator('.spoiler-box canvas.spoiler-veil').count() === 1)
  check(
    'the real text sits underneath, for copy and search',
    (await page.locator('.spoiler-box .spoiler-words').first().textContent()) === 'John was the killer',
  )

  // A few natural scratch swipes are enough to cross the reveal threshold on their own.
  const veil = page.locator('.spoiler-box canvas.spoiler-veil')
  const veilBox = await veil.boundingBox()
  for (let pass = 0; pass < 3; pass++) {
    const y = veilBox.y + 4 + pass * 4
    await page.mouse.move(veilBox.x + 2, y)
    await page.mouse.down()
    for (let x = 2; x <= veilBox.width - 2; x += 6) await page.mouse.move(veilBox.x + x, y, { steps: 2 })
    await page.mouse.up()
  }
  await page.waitForTimeout(600)
  check('a few scratch swipes reveal it on their own', await page.locator('.chat-row .spoiler-box.revealed').count() === 1)
  check('the veil is gone once scratched open', await page.locator('.spoiler-box canvas.spoiler-veil').count() === 0)

  await page.evaluate(() => window.__panel.render(window.__messages))
  check('the reveal survives a re-render', await page.locator('.chat-row .spoiler-box.revealed').count() === 1)

  // A second spoiler, opened with a plain click/tap instead -- the fallback that needs no scratching.
  await box.click()
  await page.keyboard.type('and ||the butler did it too||')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  await page.locator('.spoiler-box canvas.spoiler-veil').click()
  await page.waitForTimeout(600)
  check('a plain click also fully reveals it', await page.locator('.chat-row .spoiler-box.revealed').count() === 2)

  // Reduced motion: no continuously moving noise, but it's still interactive.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await box.click()
  await page.keyboard.type('one more ||secret here||')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  const stillStatic = await page.evaluate(async () => {
    const canvas = document.querySelector('.chat-row:last-child canvas.spoiler-veil')
    if (!canvas) return 'no canvas'
    const before = canvas.toDataURL()
    await new Promise((r) => setTimeout(r, 400))
    return canvas.toDataURL() === before
  })
  check('reduced motion: the veil holds still', stillStatic === true, String(stillStatic))
  await page.locator('.chat-row:last-child canvas.spoiler-veil').click()
  check('reduced motion: a click still reveals it', await page.locator('.chat-row:last-child .spoiler-box.revealed').count() === 1)
} catch (err) {
  stoppedEarly(err)
} finally {
  finish()
}
