import { APP_URL, check, finish, launch, stoppedEarly, wait } from './harness.mjs'
import { sql, startServer } from './pg.mjs'

const PORT = 8791
const SERVER = `http://localhost:${PORT}`

const started = await startServer(PORT)
const db = (text, params) => sql(started.database, text, params)
const browser = await launch()
const BOX = '[aria-label="Write a message"]'
const SAID = 'said while nobody was listening'

async function person(name) {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL)
  await page.evaluate(
    ({ n, server }) => {
      localStorage.setItem('cathode.name.v1', n)
      localStorage.setItem('cathode.server.v1', server)
      localStorage.setItem('cathode.servers.v1', JSON.stringify([server]))
    },
    { n: name, server: SERVER },
  )
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'sealed')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  await alice.click(BOX)
  await alice.keyboard.type(SAID)
  await alice.keyboard.press('Enter')
  await wait(1500)
  const link = alice.url()

  const rows = await db('select room, body from lines')
  const room = rows[0]?.room
  check('the server kept it', rows.length > 0, `${rows.length} lines`)
  check('and cannot read it', rows.every((r) => !r.body.includes(SAID) && !r.body.includes('Alice')))

  const bare = await fetch(`${SERVER}/api/v1/spaces/${room}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: ['junk'] }),
  })
  check('a write without the token is refused', bare.status === 403, `${bare.status}`)
  const wrong = await fetch(`${SERVER}/api/v1/spaces/${room}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cathode-write': 'f'.repeat(64) },
    body: JSON.stringify({ events: ['junk'] }),
  })
  check("and one with a stranger's token is refused too", wrong.status === 403, `${wrong.status}`)
  const junk = Number((await db(`select count(*) as n from lines where body = 'junk'`))[0].n)
  check('and neither left a mark', junk === 0)

  await alice.context().close()
  // Every line, not one, so nothing gets through for any other reason.
  await db(
    `update lines set body = substr(body, 1, 30) ||
       (case when substr(body, 31, 1) = 'A' then 'B' else 'A' end) || substr(body, 32)`,
  )

  const carol = await person('Carol')
  await carol.goto(link)
  await wait(4000)
  const fooled = await carol.evaluate(
    (said) => ({
      said: (document.querySelector('.chat-log')?.textContent ?? '').includes(said),
      lines: document.querySelectorAll('.chat-text').length,
    }),
    SAID,
  )
  check('an altered history shows nothing', !fooled.said && fooled.lines === 0, `${fooled.lines} lines shown`)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  started.child.kill()
}

finish()
