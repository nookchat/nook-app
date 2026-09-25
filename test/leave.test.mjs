import { APP_URL, FAKE_MEDIA, check, finish, launch, stoppedEarly } from './harness.mjs'

const browser = await launch({ args: FAKE_MEDIA })

async function person() {
  const page = await (await browser.newContext()).newPage()
  await page.goto(APP_URL)
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const rows = (page) => page.$$eval('.space-row .rail-item', (els) => els.map((e) => e.textContent))

async function makeSpace(page, name, password = '') {
  await page.fill('input[aria-label="Space name"]', name)
  if (password) {
    page.once('dialog', (d) => d.accept(password))
    await page.click('button:text-is("Password")')
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
  await page.click('button[aria-label="Settings"]')
  await page.waitForSelector('button:text-is("Leave")')
}

async function atList(page, ms = 30_000) {
  await page.waitForSelector('input[aria-label="Space name"]', { timeout: ms })
}

try {
  const locker = await person()
  await makeSpace(locker, 'vault', 'hunter2')
  const lockedLink = locker.url()
  check('a locked space keeps its lock in the link', /\.P(@|$)/.test(lockedLink), lockedLink)

  await locker.click('button[aria-label="Switch space"]')
  await locker.click('.menu.switcher .menu-item:has-text("Home")')
  await atList(locker)
  check('one space in the list, not two', (await rows(locker)).length === 1)

  await locker.click('.space-row .rail-item')
  await locker.waitForSelector('.space-name')
  await locker.waitForTimeout(1500)
  const lockedName = await locker.textContent('.space-name')
  check('the name in the list is the name inside', lockedName === 'vault', lockedName)
  check('and it is still the same room', locker.url() === lockedLink, locker.url())
  await locker.context().close()

  const guest = await person()
  await guest.fill('input[aria-label="Room code"]', lockedLink)
  guest.once('dialog', (d) => d.accept('hunter2'))
  await guest.click('button:has-text("Join")')
  await guest.waitForSelector('.space-name', { timeout: 15_000 })
  check('a pasted locked link asks for the password', guest.url() === lockedLink, guest.url())
  await guest.context().close()

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

  await openSettings(admin)
  admin.once('dialog', (d) => d.accept('staff room'))
  await admin.click('.card button:text-is("Rename")')
  await admin.waitForTimeout(800)
  const shown = await admin.textContent('.card:has(button:text-is("Leave")) .small')
  check('the settings card shows the name it was just given', shown === 'staff room', shown)
  await admin.click('button[aria-label="Close settings"]')
  await admin.waitForFunction(
    () => document.querySelector('.space-name')?.textContent === 'staff room',
    null,
    { timeout: 10_000 },
  )

  await openSettings(member)
  const memberCanDelete = await member.$('button:text-is("Delete space")')
  check('a member is not offered the delete button', memberCanDelete === null)

  member.once('dialog', (d) => d.accept())
  await member.click('button:text-is("Leave")')
  await atList(member)
  check('leaving lands back on the list', (await rows(member)).length === 0)

  await admin.waitForTimeout(1000)
  const adminStill = await admin.textContent('.space-name')
  check('and takes nothing from anybody else', adminStill === 'staff room', adminStill)

  await member.goto(link)
  await member.waitForFunction(
    () => document.querySelector('.space-name')?.textContent === 'staff room',
    null,
    { timeout: 60_000 },
  )

  await openSettings(admin)
  admin.once('dialog', (d) => d.accept())
  await admin.click('button:text-is("Delete space")')
  await atList(admin)
  check('the admin who deletes it lands back on the list', (await rows(admin)).length === 0)

  await atList(member, 60_000)
  check('and everybody else loses it too', (await rows(member)).length === 0)

  await member.goto(link)
  await atList(member, 60_000)
  check('and it stays gone when the link is opened again', (await rows(member)).length === 0)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
