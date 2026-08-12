/**
 * The optional archive.
 *
 * Two claims to check, and the second matters more than the first. That it
 * works: something said while nobody was listening reaches somebody who turns
 * up later. And that it is not trusted: it cannot read what it holds, and an
 * archive that alters an event produces one that is thrown away rather than
 * believed.
 *
 * The server is started here, for real, on a temporary directory.
 *
 *   node test/archive-check.mjs
 */

import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 8791
const ARCHIVE = `http://localhost:${PORT}`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const data = mkdtempSync(join(tmpdir(), 'cathode-archive-'))
const server = spawn('node', ['server/server.mjs'], {
  env: { ...process.env, PORT: String(PORT), CATHODE_DATA: data },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (b) => process.env.LOUD && console.log('  [server]', String(b).trim()))
server.stderr.on('data', (b) => console.log('  [server error]', String(b).trim()))

const up = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${ARCHIVE}/health`)
      if (res.ok) return (await res.json()).service
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--allow-running-insecure-content'],
})

try {
  check('the archive starts', (await up()) === 'cathode-archive')

  const bad = await fetch(`${ARCHIVE}/events/not-a-room`)
  check('and refuses anything that is not a room', bad.status === 400, `${bad.status}`)

  const open = async (name) => {
    const context = await browser.newContext({ viewport: { width: 1180, height: 800 } })
    const page = await context.newPage()
    await page.goto(APP_URL)
    await page.evaluate((n) => localStorage.setItem('cathode.name.v1', n), name)
    await page.reload()
    await page.waitForTimeout(900)
    return page
  }

  // ---- somebody says something, then everybody goes away -------------------
  const alice = await open('Alice')
  await alice.evaluate(
    () => (document.querySelector('input[aria-label="Space name"]').value = 'Archived'),
  )
  await alice.getByRole('button', { name: 'New space' }).click()
  await alice.waitForTimeout(2500)
  const link = alice.url()

  const attach = async (page) => {
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.waitForTimeout(600)
    await page.fill('input[aria-label="Archive address"]', ARCHIVE)
    await page.getByRole('button', { name: 'Use it' }).click()
    await page.waitForTimeout(1800)
    await page.getByRole('button', { name: 'Back' }).click()
    await page.waitForTimeout(600)
  }
  await attach(alice)

  await alice.evaluate(() => document.querySelector('[aria-label="Write a message"]').focus())
  await alice.keyboard.type('said while nobody was listening')
  await alice.keyboard.press('Enter')
  await alice.waitForTimeout(2500)

  const stored = readdirSync(data).filter((f) => f.endsWith('.jsonl'))
  check('the archive kept something', stored.length === 1, stored.join())

  const raw = readFileSync(join(data, stored[0]), 'utf8')
  check(
    'and what it kept is unreadable to it',
    raw.length > 0 && !raw.includes('said while nobody was listening'),
    `${raw.split('\n').filter(Boolean).length} sealed lines, ${raw.length} bytes`,
  )

  // Alice goes. Nobody in the space holds the history any more.
  await alice.context().close()

  // ---- somebody turns up afterwards ---------------------------------------
  const bob = await open('Bob')
  await bob.goto(link)
  await bob.reload()
  await bob.waitForTimeout(1500)

  const blank = await bob.evaluate(() =>
    (document.querySelector('.chat-log')?.textContent ?? '').includes('said while nobody'),
  )
  check('a newcomer with no archive sees nothing, because nobody is there', blank === false)

  await attach(bob)
  const caughtUp = await (async () => {
    for (let i = 0; i < 40; i++) {
      const got = await bob.evaluate(() =>
        (document.querySelector('.chat-log')?.textContent ?? '').includes(
          'said while nobody was listening',
        ),
      )
      if (got) return true
      await bob.waitForTimeout(500)
    }
    return false
  })()
  check('and with one, they are caught up on what they missed', caughtUp)

  // ---- an archive that lies ------------------------------------------------
  /*
   * Every byte in the file is flipped in one line. The client cannot be fooled
   * by it: the seal fails, or the signature under it does, and either way the
   * event is dropped rather than shown.
   */
  /*
   * Bob goes first. He is still holding the history and still handing it to
   * the archive, so meddling with the file while he is open only means he puts
   * it back, and the check would pass or fail for the wrong reason.
   */
  await bob.context().close()
  await new Promise((r) => setTimeout(r, 1500))

  const lines = readFileSync(join(data, stored[0]), 'utf8').split('\n').filter(Boolean)
  // Every line, not one, so that nothing gets through for any other reason and
  // the count below means exactly what it says.
  const meddled = lines.map(
    (line) => line.slice(0, 30) + (line[30] === 'A' ? 'B' : 'A') + line.slice(31),
  )
  writeFileSync(join(data, stored[0]), meddled.join('\n') + '\n')

  const carol = await open('Carol')
  await carol.goto(link)
  await carol.reload()
  await carol.waitForTimeout(1200)
  await attach(carol)
  await carol.waitForTimeout(3000)

  const fooled = await carol.evaluate(() => ({
    said: (document.querySelector('.chat-log')?.textContent ?? '').includes(
      'said while nobody was listening',
    ),
    lines: document.querySelectorAll('.chat-line').length,
  }))
  check(
    'an archive that alters what it holds is believed about none of it',
    fooled.said === false && fooled.lines === 0,
    `${fooled.lines} of ${lines.length} altered events got through`,
  )
} finally {
  await browser.close()
  server.kill()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} checks passed.`)
process.exit(passed === results.length ? 0 : 1)
