import { APP_URL, check, finish, HOME, launch, stoppedEarly } from './harness.mjs'

// A space you leave stays gone on every device. Another device that still has it open in the
// background saves it again now and then; that save must not bring it back. Opening it again does.
const browser = await launch()

try {
  const page = await browser.newPage()
  await page.goto(APP_URL)
  await page.waitForSelector(HOME)
  const result = await page.evaluate(async () => {
    const { BUILT_IN_SERVER } = await import('/src/backend.ts')
    const { ServerBook } = await import('/src/store/server-spaces.ts')
    const server = BUILT_IN_SERVER
    const room = crypto.randomUUID().replace(/-/g, '')
    const note = { room, secret: 'ABCDEFGHJKMN', title: 'Left one', lastSeen: Date.now(), server }
    const listed = async () => (await new ServerBook(server).list()).some((n) => n.room === room)

    // This device opened it, and the other one has it too.
    const here = new ServerBook(server)
    await here.put(note, true)
    await here.flush()
    const other = new ServerBook(server)
    await other.load()

    // Left here. Then the other device, which had it open in the background, saves it again.
    await new Promise((r) => setTimeout(r, 20))
    await here.forget(room)
    await here.flush()
    await new Promise((r) => setTimeout(r, 20))
    await other.put({ ...note, lastSeen: Date.now() })
    await other.flush()
    const afterBackground = await listed()
    const otherSees = (await other.list()).some((n) => n.room === room)

    // Opened again, from a link: back on the list.
    await new Promise((r) => setTimeout(r, 20))
    await other.put({ ...note, lastSeen: Date.now() }, true)
    await other.flush()
    const afterJoin = await listed()
    return { afterBackground, otherSees, afterJoin }
  })
  check('a space left on one device is not brought back by a background save on another', result.afterBackground === false, JSON.stringify(result))
  check('and the other device sees it gone too', result.otherSees === false)
  check('opening it again brings it back', result.afterJoin === true)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
