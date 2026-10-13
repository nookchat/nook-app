import { APP_URL, check, finish, launch, makeSpace, openSettingsTab, stoppedEarly, wait } from './harness.mjs'

const BOX = '[aria-label="Write a message"]'
const SAID = 'said before the account went'
const DELETE = 'button:text-is("Delete account")'

const browser = await launch({ named: false })
const named = await launch()
const fresh = async () => (await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } })).newPage()

const shown = (page, selector, ms = 15_000) =>
  page.waitForSelector(selector, { timeout: ms }).then(() => true, () => false)

try {
  const ana = await fresh()
  await ana.goto(APP_URL)
  await ana.click('.welcome-step:not(.hidden) button.primary')
  await ana.click('.tour-skip')
  await ana.fill('input[aria-label="Your name"]', 'Ana')
  await ana.keyboard.press('Enter')
  await makeSpace(ana, 'doomed')
  await ana.waitForSelector(BOX)
  await ana.waitForFunction(() => document.querySelector('.space-name')?.textContent === 'doomed', null, { timeout: 15_000 })
  const link = ana.url()
  await ana.click(BOX)
  await ana.keyboard.type(SAID)
  await ana.keyboard.press('Enter')
  await wait(1500)

  // Ana on a second device, from a backup.
  await openSettingsTab(ana, 'devices')
  await ana.click('button:text-is("Save a backup")')
  const [download] = await Promise.all([ana.waitForEvent('download'), ana.click('button:has-text("Save backup file")')])
  const backup = await download.path()
  await ana.click('button[aria-label="Close settings"]:visible')
  const other = await fresh()
  await other.goto(APP_URL)
  await other.click('button:has-text("I have an account")')
  await other.click('button:has-text("Use a backup file")')
  await other.setInputFiles('input[aria-label="Backup file"]', backup)
  check('the second device has the account', await shown(other, '.space-row .rail-item', 20_000))

  // Somebody else in the space, to see the name change.
  const bo = await (await named.newContext()).newPage()
  await bo.goto(link)
  await bo.waitForSelector(BOX, { timeout: 20_000 }).catch(() => undefined)
  const seesAna = await bo
    .waitForFunction(() => [...document.querySelectorAll('.chat-who')].some((e) => e.textContent.includes('Ana')), null, { timeout: 20_000 })
    .then(() => true, () => false)
  check('Bo sees what Ana said, under her name', seesAna, link)

  await openSettingsTab(ana, 'profile')
  check('Profile has a Delete account button', await shown(ana, DELETE, 5000))
  await ana.click(DELETE)
  check('it asks before it deletes', await shown(ana, '.confirm-modal[role="alertdialog"]', 5000))
  await ana.click('.confirm-modal button:text-is("Cancel")')
  await wait(500)
  const kept = await ana.evaluate(() => !!localStorage.getItem('nook.identity.v1') || Object.keys(localStorage).length > 0)
  check('Cancel keeps the account', kept && !(await ana.$('.confirm-modal')))

  await ana.click(DELETE)
  await ana.click('.confirm-modal button.confirm-ok')
  check('Delete account logs this device out to the first screen', await shown(ana, '.welcome', 30_000))

  await other.bringToFront()
  await other.evaluate(() => window.dispatchEvent(new Event('focus')))
  check('the other device logs out too', await shown(other, '.welcome', 40_000))

  const renamed = await bo
    .waitForFunction(() => [...document.querySelectorAll('.chat-who')].some((e) => e.textContent.includes('Deleted user')), null, { timeout: 20_000 })
    .then(() => true, () => false)
  check('Bo now sees Deleted user in place of Ana', renamed)

  await ana.goto(APP_URL)
  await ana.click('button:has-text("I have an account")')
  await ana.click('button:has-text("Use a backup file")')
  await ana.setInputFiles('input[aria-label="Backup file"]', backup)
  await wait(3000)
  check('the old backup no longer brings the account back', await shown(ana, '.welcome', 30_000))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  await named.close()
  finish()
}
