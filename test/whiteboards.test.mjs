import { APP_URL, FAKE_MEDIA, answer, check, finish, launch, poll, stoppedEarly } from './harness.mjs'

// A whiteboard sits under the notes, and opens tldraw in place of the chat. What one person
// draws reaches the others record by record, and two people can draw on one board at once.
const browser = await launch({ args: FAKE_MEDIA })
const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const boards = (page) => page.evaluate(async () => {
  const { spaces } = await import('/src/space/registry.ts')
  return spaces.all()[0].chat.whiteboards().map((b) => ({ id: b.id, title: b.title }))
})

/** The shapes the log has for the first board, taken away ones left out: a geo shape by its form. */
const shapes = (page) => page.evaluate(async () => {
  const { spaces } = await import('/src/space/registry.ts')
  const chat = spaces.all()[0].chat
  const board = chat.whiteboards()[0]
  return board
    ? chat.whiteboardRecords(board.id).filter((r) => !r.gone && r.typeName === 'shape').map((r) => (r.type === 'geo' ? r.props.geo : r.type)).sort()
    : []
})

/** Picks a tool by its key, then drags across the board. */
async function drawWith(page, key, from, to) {
  const box = await page.locator('.whiteboard-host .tl-canvas').boundingBox()
  await page.mouse.click(box.x + 40, box.y + box.height / 2)
  await page.keyboard.press(key)
  await page.mouse.move(box.x + from[0], box.y + from[1])
  await page.mouse.down()
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps: 4 })
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 })
  await page.mouse.up()
}

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'boards')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)

  const heads = await alice.locator('.rail-left .rail-head .eyebrow').allTextContents()
  check('Whiteboards comes just after Notes in the list', heads.indexOf('Whiteboards') === heads.indexOf('Notes') + 1, heads.join(' | '))

  await alice.click('button[aria-label="Make a whiteboard"]')
  await answer(alice, 'Sketch')
  await alice.waitForSelector('.whiteboard-view:not(.hidden) .tl-canvas', { timeout: 20_000 })
  check('the board opens in place of the chat', !(await alice.locator(BOX).isVisible()))
  check('the name is at the top', (await alice.locator('.channel-name').textContent()).includes('Sketch'))
  check('Bob sees the board in his list', await poll(async () => (await boards(bob)).some((b) => b.title === 'Sketch'), 10_000))

  const tools = await alice.locator('.whiteboard-tools button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))
  check('the bar has rename, who can see it, and delete', tools.length === 3 && tools[0] === 'Rename' && tools.at(-1) === 'Delete the whiteboard', tools.join(' | '))
  check('no note buttons show beside them', (await alice.locator('.space-head .note-tools:not(.whiteboard-tools):visible').count()) === 0)

  await drawWith(alice, 'r', [300, 200], [450, 320])
  check('a rectangle Alice draws reaches Bob', await poll(async () => (await shapes(bob)).join() === 'rectangle', 10_000), (await shapes(bob)).join())

  await bob.click('.rail-left .rail-item:has-text("Sketch")')
  await bob.waitForSelector('.whiteboard-view:not(.hidden) .tl-canvas', { timeout: 20_000 })
  await drawWith(bob, 'o', [120, 420], [220, 520])
  await drawWith(alice, 'd', [300, 420], [420, 520])
  const all = 'draw,ellipse,rectangle'
  check('both draw at once, and both logs end with every shape', await poll(async () => (await shapes(alice)).join() === all && (await shapes(bob)).join() === all, 10_000), `${(await shapes(alice)).join()} / ${(await shapes(bob)).join()}`)

  // Alice takes the rectangle away: select all, then Delete takes everything she has on screen.
  await alice.keyboard.press('Escape')
  await alice.keyboard.press('ControlOrMeta+a')
  await alice.keyboard.press('Delete')
  check('what Alice deletes is gone for Bob', await poll(async () => (await shapes(bob)).length === 0, 10_000), (await shapes(bob)).join())

  await alice.click('.whiteboard-tools button[aria-label="Rename"]')
  await answer(alice, 'Plan')
  check('rename reaches Bob', await poll(async () => (await boards(bob)).some((b) => b.title === 'Plan'), 10_000))

  await alice.click('.whiteboard-tools button[aria-label^="Who can see it"]')
  await alice.click('.pick-row:has-text("Moderator")')
  await alice.click('.ask-modal button:has-text("Save")')
  check('kept to Moderators, Bob no longer sees it', await poll(async () => (await boards(bob)).length === 0, 10_000))
  check('Bob is back in the channel', await poll(() => bob.locator(BOX).isVisible(), 5000))

  await alice.click('.whiteboard-tools button[aria-label="Delete the whiteboard"]')
  await alice.click('.confirm-modal button:has-text("Delete")')
  check('delete takes it away', await poll(async () => (await boards(alice)).length === 0, 10_000))
  check('Alice is back in the channel', await poll(() => alice.locator(BOX).isVisible(), 5000))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}
finish()
