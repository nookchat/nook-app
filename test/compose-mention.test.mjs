import { APP_URL, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

// A mention in the message box looks as it will in the message: a tag, in the colour of the
// person's level. The box's own text stays where it is: the tag is drawn in the copy behind it.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'
const SHOT = process.env.SHOT

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const marks = (page) =>
  page.locator('.compose-box .emoji-mirror .field-mark').evaluateAll((all) => all.map((m) => `${m.textContent}|${m.style.getPropertyValue('--who')}`))

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'tags')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await poll(() => bob.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    return [...spaces.all()[0].chat.log.names().values()].includes('Alice')
  }), 10_000)

  await bob.click(BOX)
  await bob.keyboard.type('hi @Alice and @everyone and @nobody')
  const found = await marks(bob)
  check('each mention in the box is a tag', found.length === 2 && found[0].startsWith('@Alice|') && found[1] === '@everyone|', found.join(' , '))
  check('Alice, the owner, is in the colour of her level', /^#|rgb|color/.test(found[0].split('|')[1]), found[0])
  check('the box draws its text from the copy while there is a tag', await bob.locator(BOX).evaluate((b) => b.classList.contains('mirrored')))

  // The tag lines up with the box's own text: the copy wraps and measures the same.
  const lined = await bob.evaluate((sel) => {
    const box = document.querySelector(sel)
    const mirror = box.parentElement.querySelector('.emoji-mirror')
    const measure = (el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return range.getBoundingClientRect()
    }
    const copy = measure(mirror)
    // The box's text, measured in a twin with its font and padding.
    const twin = document.createElement('div')
    const style = getComputedStyle(box)
    for (const k of ['font', 'letterSpacing', 'padding', 'whiteSpace', 'width', 'lineHeight', 'boxSizing']) twin.style[k] = style[k]
    twin.style.position = 'absolute'
    twin.style.whiteSpace = 'pre-wrap'
    twin.textContent = box.value
    document.body.append(twin)
    const plain = measure(twin)
    twin.remove()
    return Math.abs(copy.width - plain.width)
  }, BOX)
  check('the tags make the text no wider', lined < 1, `${lined}px`)

  await bob.keyboard.press('ControlOrMeta+a')
  await bob.keyboard.press('Backspace')
  await bob.keyboard.type('no tags here')
  check('with no mention, the box draws its own text again', (await marks(bob)).length === 0 && !(await bob.locator(BOX).evaluate((b) => b.classList.contains('mirrored'))))

  await bob.keyboard.press('ControlOrMeta+a')
  await bob.keyboard.press('Backspace')
  await bob.keyboard.type('hey @Alice how are you')
  if (SHOT) await bob.locator('.compose-box').screenshot({ path: SHOT })
  await bob.keyboard.press('Enter')
  await bob.waitForSelector('.chat-scroll .mention')
  check('sent, it is the same tag in the message', (await bob.locator('.chat-scroll .mention').first().textContent()) === '@Alice')
  check('and the box is plain again', (await marks(bob)).length === 0)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}
finish()
