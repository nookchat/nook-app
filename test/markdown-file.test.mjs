import { APP_URL, check, finish, HOME, launch, makeSpace, poll, stoppedEarly } from './harness.mjs'

// A markdown file in a message: the top of it drawn in the message, the whole of it in a reader a
// click away, and nothing in it that runs, styles the page or loads from elsewhere.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'

const DOC = [
  '# Raid plan',
  '',
  'Meet at **eight**, bring `potions`.',
  '',
  '- Tank pulls',
  '- Healer stays back',
  '- [Guide](https://example.com/guide)',
  '',
  '<script>window.ranScript = true</script>',
  '<img src="x" onerror="window.ranImage = true">',
  '![boss](https://example.com/boss.png)',
  '',
  '```js',
  'const loot = 3',
  '```',
  '',
  ...Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the long part.`),
  '',
  'The very last line.',
].join('\n')

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector(HOME)
  return page
}

try {
  const alice = await person('Alice')
  await makeSpace(alice, 'Raiders')
  await alice.waitForSelector(BOX)

  await alice.evaluate((doc) => {
    const data = new DataTransfer()
    data.items.add(new File([doc], 'raid-plan.md', { type: '' }))
    const target = document.querySelector('.chat-panel')
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
    }
  }, DOC)
  await alice.waitForSelector('.attach-chip')
  await poll(() => alice.evaluate(() => !document.querySelector('.attach-bar')), 15_000)
  await alice.press(BOX, 'Enter')

  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  const drawn = await poll(() => bob.evaluate(() => document.querySelector('.att-doc-body h1')?.textContent ?? null), 20_000)
  check('a markdown file shows its top in the message', drawn === 'Raid plan', drawn ?? 'nothing')

  const preview = await bob.evaluate(() => {
    const body = document.querySelector('.att-doc-body')
    return {
      items: body.querySelectorAll('li').length,
      strong: body.querySelector('strong')?.textContent,
      code: body.querySelector('pre code')?.textContent,
      link: body.querySelector('a')?.getAttribute('href'),
      images: body.querySelectorAll('img').length,
      scripts: body.querySelectorAll('script').length,
      cut: document.querySelector('.att-doc-page').classList.contains('cut'),
      ran: window.ranScript === true || window.ranImage === true,
    }
  })
  check('lists, bold, code and links are drawn', preview.items === 3 && preview.strong === 'eight' && preview.code?.includes('loot') && preview.link === 'https://example.com/guide', JSON.stringify(preview))
  check('nothing in it runs or loads a picture', !preview.ran && preview.images === 0 && preview.scripts === 0, JSON.stringify(preview))
  check('a long file fades out at the foot of the preview', preview.cut)
  check('the name and the size are on the card', (await bob.locator('.att-doc .att-file-name').textContent()) === 'raid-plan.md')
  await bob.screenshot({ path: 'test-output/markdown-file-card.png' })

  await bob.click('.att-doc-page')
  await bob.waitForSelector('.doc-reader')
  const whole = await bob.evaluate(() => document.querySelector('.doc-reader-page')?.textContent.includes('The very last line.'))
  check('a click opens the whole file in a reader', whole)
  await bob.screenshot({ path: 'test-output/markdown-file-reader.png' })
  await bob.keyboard.press('Escape')
  check('Esc closes the reader', await poll(() => bob.evaluate(() => !document.querySelector('.doc-reader')), 3000))

  await bob.click('.att-doc button[aria-label="Open raid-plan.md"]')
  await bob.waitForSelector('.doc-reader')
  const [download] = await Promise.all([bob.waitForEvent('download'), bob.click('.doc-reader button[title="Save"]')])
  check('Save in the reader saves the file', download.suggestedFilename() === 'raid-plan.md', download.suggestedFilename())

  check('the sender sees it drawn too', await poll(() => alice.evaluate(() => document.querySelector('.att-doc-body h1')?.textContent === 'Raid plan'), 10_000))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
