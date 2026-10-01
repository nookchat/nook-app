import { APP_URL, check, finish, launch, openSettingsTab, poll, stoppedEarly } from './harness.mjs'

// Settings, Notifications has a button that sends a notification now, to see that this device
// shows them. It says why when it cannot.
const browser = await launch()

async function person(allowed) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  if (allowed) await context.grantPermissions(['notifications'], { origin: new URL(APP_URL).origin })
  // Every notification the page or its worker shows, by its body.
  await context.addInitScript(() => {
    window.__shown = []
    const keep = (title, options) => window.__shown.push(`${title}: ${options?.body ?? ''}`)
    if (typeof ServiceWorkerRegistration !== 'undefined') {
      ServiceWorkerRegistration.prototype.showNotification = async function (title, options) {
        keep(title, options)
      }
    }
    if (typeof Notification !== 'undefined') {
      const Real = Notification
      window.Notification = class extends Real {
        constructor(title, options) {
          super(title, options)
          keep(title, options)
        }
      }
      Object.defineProperty(window.Notification, 'permission', { get: () => Real.permission })
      window.Notification.requestPermission = (...a) => Real.requestPermission(...a)
    }
  })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate(() => localStorage.setItem('nook.name.v1', 'Tess'))
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  await openSettingsTab(page, 'notifications')
  await page.waitForSelector('button.notify-test')
  return page
}

const result = (page) => page.locator('.notify-test-result').textContent()

try {
  const page = await person(true)
  await page.click('button.notify-test')
  check('with notifications allowed, the test shows one', await poll(async () => (await page.evaluate(() => window.__shown)).join() === 'Nook: Notifications work on this device.', 5000), (await page.evaluate(() => window.__shown)).join())
  check('and says it was sent', (await result(page)).startsWith('Sent.'), await result(page))

  await page.evaluate(() => localStorage.setItem('nook.status.v1', JSON.stringify({ mode: 'dnd', text: '' })))
  await page.click('button.notify-test')
  check('with Do not disturb on, it says why nothing shows', await poll(async () => (await result(page)).includes('Do not disturb'), 3000), await result(page))

  const blocked = await person(false)
  await blocked.click('button.notify-test')
  check('with notifications not allowed, nothing shows and it says so', await poll(async () => /Blocked|did not show/.test(await result(blocked)), 5000), await result(blocked))
  check('and no notification was made', (await blocked.evaluate(() => window.__shown)).length === 0)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}
finish()
