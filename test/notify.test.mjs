import { answer, APP_URL, check, finish, HOME, launch, makeSpace, poll, stoppedEarly, wait } from './harness.mjs'

// Notifications say who, where and what, as Discord's do: for a mention and a direct
// message, not every message unless asked, and never from a channel kept from you.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'

async function person(name, away = false) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.addInitScript((away) => {
    window.notes = []
    window.Notification = class {
      static permission = 'granted'
      static requestPermission = async () => 'granted'
      constructor(title, options) {
        window.notes.push({ title, body: options?.body ?? '', icon: options?.icon ?? '' })
      }
      close() {}
    }
    // Looking at another window: Nook has no focus.
    if (away) document.hasFocus = () => false
  }, away)
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector(HOME)
  return page
}

const notes = (page) => page.evaluate(() => window.notes)
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
  await makeSpace(alice, 'Night Shift')
  await alice.waitForSelector(BOX)
  await alice.click('.rail-left button[title="Make a text channel"]')
  await alice.fill('.ask-modal .ask-input', 'staff')
  await alice.check('.pick-row input[aria-label="Moderator"]')
  await alice.click('.ask-modal button:text-is("Make")')
  await alice.click('.rail-left .rail-item:has-text("general")')

  const bob = await person('Bob', true)
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  await wait(1500)

  await say(alice, 'just chatting')
  await say(alice, '@Bob are you there?')
  const got = await poll(async () => (await notes(bob)).find((n) => n.body.includes('are you there')), 20_000)
  check('a mention gives a notification with what was said', !!got, JSON.stringify(await notes(bob)))
  check('titled who and where', got?.title === 'Alice (#general, Night Shift)', got?.title)
  check('a plain message does not, by default', !(await notes(bob)).some((n) => n.body.includes('just chatting')))

  await alice.click('.rail-left .rail-item:has-text("staff")')
  await say(alice, '@everyone staff only')
  await alice.click('.rail-left .rail-item:has-text("general")')
  await say(alice, '@Bob marker after staff')
  await poll(async () => (await notes(bob)).some((n) => n.body.includes('marker after staff')), 20_000)
  check('nothing from a channel kept from Bob', !(await notes(bob)).some((n) => n.body.includes('staff only')))

  await bob.evaluate(() => localStorage.setItem('nook.notify.what.v1', 'all'))
  await say(alice, 'now every message')
  const every = await poll(async () => (await notes(bob)).some((n) => n.body.includes('now every message')), 20_000)
  check('with Every message on, a plain message does too', every)

  await bob.evaluate(() => localStorage.setItem('nook.notify.text.v1', 'off'))
  await say(alice, '@Bob a secret')
  const quiet = await poll(async () => (await notes(bob)).find((n) => n.title.startsWith('Alice') && n.body === 'Mentioned you'), 20_000)
  check('with Show what they said off, it says only that', !!quiet && !(await notes(bob)).some((n) => n.body.includes('a secret')))
  await bob.evaluate(() => localStorage.removeItem('nook.notify.text.v1'))

  const bobKey = await bob.evaluate(async () => (await import('/src/space/registry.ts')).spaces.all()[0].chat.me)
  await alice.evaluate(async (key) => {
    const { spaces } = await import('/src/space/registry.ts')
    await spaces.all()[0].chat.sayDirect(key, 'a private hello')
  }, bobKey)
  const direct = await poll(async () => (await notes(bob)).find((n) => n.title === 'Alice' && n.body.includes('a private hello')), 20_000)
  check('a direct message gives one with its text', !!direct, JSON.stringify((await notes(bob)).slice(-2)))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
