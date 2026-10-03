import { APP_URL, check, finish, HOME, launch, makeSpace, poll, stoppedEarly } from './harness.mjs'

// Making a space takes steps, as making an account does: a starting point, then a name. A
// template sets up its channels, in order, with their topics, and the notes it starts with.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'
const FLOW = '.space-flow'

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector(HOME)
  return page
}

const state = (page) =>
  page.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    const chat = spaces.all()[0]?.chat
    if (!chat) return null
    return {
      name: chat.spaceName(),
      text: chat.channelInfo(false),
      voice: chat.channelInfo(true),
      notes: chat.notes().map((n) => n.title),
    }
  })

try {
  const ada = await person('Ada')

  await ada.click(HOME)
  await ada.waitForSelector(`${FLOW} .template-grid`)
  const offered = await ada.$$eval(`${FLOW} .template-grid .welcome-option-title`, (els) => els.map((e) => e.textContent))
  check('New space offers a start from scratch and templates', offered[0] === 'Start from scratch' && offered.length >= 6, offered.join(', '))
  await ada.keyboard.press('Escape')
  check('Escape closes the steps and makes nothing', (await ada.locator(FLOW).count()) === 0 && (await ada.locator(BOX).count()) === 0)

  await ada.click(HOME)
  await ada.click(`${FLOW} .welcome-option:has-text("Study group")`)
  const chips = await ada.$$eval(`${FLOW} .plan-chip`, (els) => els.map((e) => e.textContent))
  check('the name step shows what the template makes', chips.includes('homework-help') && chips.includes('Study plan'), chips.join(', '))
  const stuck = await ada.$eval(`${FLOW} button.welcome-go:has-text("Make the space")`, (b) => b.disabled)
  check('and it cannot go on without a name', stuck)
  await ada.click(`${FLOW} .welcome-step:not(.hidden) button:has-text("Back")`)
  check('Back goes to the starting points', await ada.isVisible(`${FLOW} .template-grid`))
  await ada.keyboard.press('Escape')

  await makeSpace(ada, 'Bio 101', { template: 'Study group' })
  await ada.waitForSelector(BOX)
  const made = await poll(async () => {
    const s = await state(ada)
    return s && s.text.length >= 4 && s.notes.length >= 1 ? s : null
  }, 15_000)
  check('the space takes its name', made?.name === 'Bio 101', made?.name)
  check(
    'its text channels come in the template order',
    made?.text.map((c) => c.name).join(',') === 'general,homework-help,resources,off-topic',
    made?.text.map((c) => c.name).join(','),
  )
  check('each with its topic', made?.text.find((c) => c.name === 'homework-help')?.topic.startsWith('Ask a question'))
  check(
    'and its voice channels, one of them to listen in',
    made?.voice.map((c) => c.name).join(',') === 'lounge,study-room,quiet-study' && made.voice.find((c) => c.name === 'quiet-study')?.noTalking,
    made?.voice.map((c) => c.name).join(','),
  )
  check('the template note is there', made?.notes.includes('Study plan'), made?.notes.join(','))
  const rail = await ada.$$eval('.rail-left .rail-item', (els) => els.map((e) => e.textContent.trim()).join(' | '))
  check('the channel list shows them', rail.includes('homework-help') && rail.includes('Study plan'), rail)
  await ada.screenshot({ path: 'test-output/template-study.png' })

  const bo = await person('Bo')
  await makeSpace(bo, 'Just us')
  await bo.waitForSelector(BOX)
  const plain = await poll(async () => {
    const s = await state(bo)
    return s?.name === 'Just us' ? s : null
  }, 15_000)
  check(
    'from scratch is one text and one voice channel, and no notes',
    plain?.text.map((c) => c.name).join(',') === 'general' && plain.voice.map((c) => c.name).join(',') === 'lounge' && plain.notes.length === 0,
    JSON.stringify(plain && { text: plain.text.map((c) => c.name), voice: plain.voice.map((c) => c.name), notes: plain.notes }),
  )
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
