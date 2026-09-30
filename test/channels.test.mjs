import { APP_URL, FAKE_MEDIA, answer, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'

// Your own mutes, for a channel or a whole space; the offer to turn notifications on;
// and a voice channel renamed and deleted.
const browser = await launch({ args: FAKE_MEDIA })
const BOX = '[aria-label="Write a message"]'

async function person(name, { away = false, permission = 'granted' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.addInitScript(
    ({ away, permission }) => {
      window.notes = []
      window.Notification = class {
        static permission = permission
        static requestPermission = async () => {
          window.Notification.permission = 'granted'
          return 'granted'
        }
        constructor(title, options) {
          window.notes.push({ title, body: options?.body ?? '' })
        }
        close() {}
      }
      window.nookDesktop = { setBadge: (n) => (window.badgeSeen = n) }
      if (away) document.hasFocus = () => false
    },
    { away, permission },
  )
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const notes = (page) => page.evaluate(() => window.notes)
const badge = (page) => page.evaluate(() => window.badgeSeen ?? null)
async function say(page, text) {
  await page.click(BOX)
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
  await page.click(BOX)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
}

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'Quiet Please')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector(BOX)
  await alice.click('.rail-left button[title="Make a text channel"]')
  await answer(alice, 'random')
  await alice.click('.rail-left .rail-item:has-text("general")')

  const bob = await person('Bob', { away: true })
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await bob.click('.rail-left .rail-item:has-text("random")')
  await wait(1500)

  await bob.click('.rail-left .rail-row:has-text("general")', { button: 'right' })
  await bob.click('.menu-item:has-text("Mute")')
  const quiet = await poll(async () => (await bob.locator('.rail-item.muted:has-text("general")').count()) === 1, 5000)
  check('a member can mute a channel, and it looks quiet', quiet)
  await say(alice, '@Bob in a muted channel')
  await alice.click('.rail-left .rail-item:has-text("random")')
  await say(alice, '@Bob in random')
  await poll(async () => (await notes(bob)).some((n) => n.body.includes('in random')), 20_000)
  check('a mention in a muted channel gives no notification', !(await notes(bob)).some((n) => n.body.includes('muted channel')))
  check('and no count on the icon', (await badge(bob)) === 0, String(await badge(bob)))

  await bob.click('.space-title-button')
  await bob.click('.menu-item:has-text("Mute this space")')
  await say(alice, '@Bob with the space muted')
  await wait(2500)
  check('a muted space gives none from any channel', !(await notes(bob)).some((n) => n.body.includes('space muted')))

  await bob.click('.space-title-button')
  await bob.click('.menu-item:has-text("Unmute this space")')
  await say(alice, '@Bob unmuted again')
  const back = await poll(async () => (await notes(bob)).some((n) => n.body.includes('unmuted again')), 20_000)
  check('unmuted, they come again', back)

  // A browser that has not been asked yet: the first mention offers notifications, once.
  const carol = await person('Carol', { permission: 'default' })
  await carol.goto(alice.url())
  await carol.waitForSelector(BOX)
  await wait(1500)
  await say(alice, '@Carol hello')
  const offered = await poll(() => carol.$$eval('.toast', (els) => els.some((t) => t.textContent.includes('Get a notification'))), 15_000)
  check('the first mention offers to turn notifications on', offered)
  await carol.click('.toast button:has-text("Turn on")')
  await wait(300)
  check('and Turn on asks the browser', await carol.evaluate(() => window.Notification.permission === 'granted'))
  await carol.evaluate(() => (window.Notification.permission = 'default'))
  await say(alice, '@Carol again')
  await wait(4000)
  const offers = await carol.$$eval('.toast', (els) => els.filter((t) => t.textContent.includes('Get a notification')).length)
  check('and it is offered only once', offers === 0, String(offers))

  await alice.click('button[title="Make a voice channel"]')
  await answer(alice, 'den')
  await wait(500)
  await bob.click('.voice-channel .rail-item:has-text("den")')
  await bob.waitForSelector('.voice-head.on:has-text("den")', { timeout: 10_000 })
  await alice.click('.voice-channel .voice-head:has-text("den")', { button: 'right' })
  await alice.click('.menu-item:has-text("Rename")')
  await answer(alice, 'The Den')
  const renamed = await poll(async () => (await bob.$$eval('.voice-join', (els) => els.map((e) => e.textContent))).some((t) => t.includes('The Den')), 15_000)
  check('a voice channel can be renamed', renamed)
  alice.once('dialog', (d) => void d.accept())
  await alice.click('.voice-channel .voice-head:has-text("The Den")', { button: 'right' })
  await alice.click('.menu-item:has-text("Delete")')
  const gone = await poll(async () => !(await bob.$$eval('.voice-join', (els) => els.map((e) => e.textContent))).some((t) => t.includes('The Den')), 15_000)
  check('and deleted', gone)
  const out = await poll(() => bob.evaluate(() => !document.querySelector('.voice-bar:not(.hidden)')), 10_000)
  check('which takes out whoever was in it', out)

  // A message moved to another channel, for everybody, at the time it was sent.
  await alice.click('.rail-left .rail-item:has-text("general")')
  await say(alice, 'this belongs in random')
  const moving = alice.locator('.chat-line:has-text("this belongs in random")').last()
  await moving.waitFor()
  const sent = await moving.locator('.chat-at').textContent()
  await moving.click({ button: 'right' })
  await alice.click('.menu-item:has(.menu-label:text-is("random"))')
  const left = await poll(async () => (await alice.locator('.chat-line:has-text("this belongs in random")').count()) === 0, 10_000)
  check('a message can be moved to another channel', left)
  await bob.click('.rail-left .rail-item:has-text("random")')
  const landed = await poll(async () => (await bob.locator('.chat-line:has-text("this belongs in random")').count()) === 1, 15_000)
  check('and it shows there for everybody', landed)
  const there = await bob.locator('.chat-line:has-text("this belongs in random") .chat-at').textContent()
  check('at the time it was sent', there === sent, `${sent} -> ${there}`)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
