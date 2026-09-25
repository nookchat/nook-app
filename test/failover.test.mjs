import { APP_URL, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'
import { sql, startServer } from './pg.mjs'

const SECRET = 'a-cluster-secret-for-tests'
const A = 'http://localhost:8811'
const B = 'http://localhost:8812'
const cluster = (self, peer) => ({ CATHODE_PUBLIC_URL: self, CATHODE_PEERS: peer, CATHODE_CLUSTER_SECRET: SECRET })
let a = await startServer(8811, cluster(A, B))
const b = await startServer(8812, cluster(B, A))

const browser = await launch()
const BOX = '[aria-label="Write a message"]'

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate(
    ({ n, server }) => {
      localStorage.setItem('cathode.name.v1', n)
      localStorage.setItem('cathode.server.v1', server)
      localStorage.setItem('cathode.servers.v1', JSON.stringify([server]))
    },
    { n: name, server: A },
  )
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const sees = (page, text, timeout = 25_000) =>
  page
    .waitForFunction(
      (t) => [...document.querySelectorAll('.chat-text')].some((n) => n.textContent.includes(t)),
      text,
      { timeout },
    )
    .then(() => true)
    .catch(() => false)

async function say(page, text) {
  await page.click(BOX)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

const status = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.status-bar')
    return `${bar?.textContent ?? ''} | ${bar?.title ?? ''}`
  })

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'two homes')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  await wait(1500)
  const link = alice.url()
  check('the invite names both servers', link.includes('@localhost:8811,localhost:8812'), link)

  const bob = await person('Bob')
  await bob.goto(link)
  await bob.waitForSelector(BOX)
  await say(alice, 'while both are up')
  check('two people talk on the first server', await sees(bob, 'while both are up'))

  a.child.kill()
  await wait(500)
  await say(alice, 'said with the first server gone')
  check('they carry on through the second, without doing anything', await sees(bob, 'said with the first server gone'))
  const moved = await status(alice)
  check('and the status line says which server it is on now', moved.includes('localhost:8812'), moved)

  const carol = await person('Carol')
  await carol.goto(link)
  check('somebody new gets in with the link alone', await sees(carol, 'said with the first server gone'))
  check('and reads what was said before too', await sees(carol, 'while both are up'))

  a = await startServer(8811, { ...cluster(A, B), DATABASE_URL: a.database })
  const room = (await sql(b.database, 'select room from lines limit 1'))[0].room
  const count = async (db) => Number((await sql(db, 'select count(*) as n from lines where room = $1', [room]))[0].n)
  const caught = await poll(async () => (await count(a.database)) === (await count(b.database)), 30_000, 500)
  check('the first server comes back with everything it missed', caught, `${await count(a.database)} and ${await count(b.database)} lines`)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  a.child.kill()
  b.child.kill()
}

finish()
