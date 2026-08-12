/**
 * Getting out of a space, and taking it with you.
 *
 * Three things, and they are different things:
 *
 *   leaving   takes the space off this device and off no other
 *   deleting  closes it for everybody who reads the log, admins only
 *   locking   must not turn one space into two with the same code
 *
 * The last one is here because it looked like a naming bug. A locked space
 * opened from the list without its password derives a different room id, so the
 * list said "staffs" and the space said "Unnamed space", and the pair of them
 * were two different rooms wearing one code.
 *
 *   node test/leave-check.mjs
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})

/** A page with its own store, so two of them are two people. */
async function person() {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const rows = (page) => page.$$eval('.space-row .rail-item', (els) => els.map((e) => e.textContent))

/** Make a space, named, with or without a password, and walk in. */
async function makeSpace(page, name, password = '') {
  await page.fill('input[aria-label="Space name"]', name)
  if (password) {
    page.once('dialog', (d) => d.accept(password))
    await page.click('button:has-text("Add a password")')
  } else {
    await page.click('button:has-text("New space")')
  }
  await page.waitForFunction(
    (wanted) => document.querySelector('.space-name')?.textContent === wanted,
    name,
    { timeout: 15_000 },
  )
}

async function openSettings(page) {
  await page.click('button:has-text("Settings")')
  await page.waitForSelector('button:has-text("Leave this space")')
}

/** Wait for the opening screen, however we got there. */
async function atList(page, ms = 30_000) {
  await page.waitForSelector('input[aria-label="Space name"]', { timeout: ms })
}

try {
  // ---- a space with a password, opened again from the list ----
  const locker = await person()
  await makeSpace(locker, 'vault', 'hunter2')
  const lockedLink = locker.url()
  check('a locked space keeps its lock in the link', lockedLink.endsWith('.P'), lockedLink)

  await locker.click('button[aria-label="Your spaces"]')
  await atList(locker)
  check('one space in the list, not two', (await rows(locker)).length === 1)

  await locker.click('.space-row .rail-item')
  await locker.waitForSelector('.space-name')
  await locker.waitForTimeout(1500)
  const lockedName = await locker.textContent('.space-name')
  check('the name in the list is the name inside', lockedName === 'vault', lockedName)
  check('and it is still the same room', locker.url() === lockedLink, locker.url())
  await locker.context().close()

  // Somebody who has never seen it is asked for the password, once.
  const guest = await person()
  await guest.fill('input[aria-label="Room code"]', lockedLink)
  guest.once('dialog', (d) => d.accept('hunter2'))
  await guest.click('button:has-text("Join")')
  await guest.waitForSelector('.space-name', { timeout: 15_000 })
  check('a pasted locked link asks for the password', guest.url() === lockedLink, guest.url())
  await guest.context().close()

  // ---- leaving, which is this device's business only ----
  const admin = await person()
  await makeSpace(admin, 'staffs')
  const link = admin.url()

  const member = await person()
  await member.goto(link)
  await member.waitForFunction(
    () => document.querySelector('.space-name')?.textContent === 'staffs',
    null,
    { timeout: 60_000 },
  )
  check('a member sees the name the admin gave it', true)

  // Renaming from the settings screen, which is where the name is shown.
  await openSettings(admin)
  admin.once('dialog', (d) => d.accept('staff room'))
  await admin.click('button:has-text("Rename it")')
  await admin.waitForTimeout(800)
  const shown = await admin.textContent('.card:has(button:has-text("Rename it")) .share-code')
  check('the settings card shows the name it was just given', shown === 'staff room', shown)
  await admin.click('button:has-text("Back")')
  await admin.waitForFunction(
    () => document.querySelector('.space-name')?.textContent === 'staff room',
    null,
    { timeout: 10_000 },
  )

  await openSettings(member)
  const memberCanDelete = await member.$('button:has-text("Delete for everybody")')
  check('a member is not offered the delete button', memberCanDelete === null)

  member.once('dialog', (d) => d.accept())
  await member.click('button:has-text("Leave this space")')
  await atList(member)
  check('leaving lands back on the list', (await rows(member)).length === 0)

  await admin.waitForTimeout(1000)
  const adminStill = await admin.textContent('.space-name')
  check('and takes nothing from anybody else', adminStill === 'staff room', adminStill)

  // ---- deleting, which is everybody's ----
  await member.goto(link)
  await member.waitForFunction(
    () => document.querySelector('.space-name')?.textContent === 'staff room',
    null,
    { timeout: 60_000 },
  )

  await openSettings(admin)
  admin.once('dialog', (d) => d.accept())
  await admin.click('button:has-text("Delete for everybody")')
  await atList(admin)
  check('the admin who deletes it lands back on the list', (await rows(admin)).length === 0)

  await atList(member, 60_000)
  check('and everybody else loses it too', (await rows(member)).length === 0)

  // Coming back to the link does not resurrect it: the close is in the log the
  // peers hold, so it arrives again and is honoured again.
  await member.goto(link)
  await atList(member, 60_000)
  check('and it stays gone when the link is opened again', (await rows(member)).length === 0)
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
}

await browser.close()

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
