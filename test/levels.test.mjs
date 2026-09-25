import { APP_URL, check, finish, launch, stoppedEarly } from './harness.mjs'

const BOX = '[aria-label="Write a message"]'
const TEAL = 'rgb(46, 196, 182)'

const browser = await launch()

async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('cathode.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

async function say(page, text) {
  await page.click(BOX)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
}

const lines = (page) =>
  page.$$eval('.chat-line', (els) =>
    els.map((e) => {
      const text = e.querySelector('.chat-text')
      return {
        text: text?.textContent ?? '',
        jumbo: text?.classList.contains('jumbo') ?? false,
        size: text ? getComputedStyle(text).fontSize : '',
        reply: !!e.querySelector('.chat-reply'),
      }
    }),
  )

const openSettings = (page) => page.evaluate(() => document.querySelector('button[aria-label="Settings"]').click())

try {
  const alice = await person('Alice')
  await alice.fill('input[aria-label="Space name"]', 'levels')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('.space-name')
  await alice.waitForTimeout(1000)
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForFunction(() => document.querySelector('.space-name')?.textContent === 'levels', null, { timeout: 60_000 })

  await say(alice, '😀')
  await say(alice, 'hi 😀')
  const said = await lines(alice)
  check('a message of one emoji is drawn large', said[0]?.jumbo === true, JSON.stringify(said[0]))
  check('a word beside it keeps it text', said[1]?.jumbo === false, JSON.stringify(said[1]))
  check('what people write is 16 pixels', said[1]?.size === '16px', said[1]?.size)

  await bob.waitForFunction(() => document.querySelectorAll('.chat-line').length >= 2, null, { timeout: 20_000 })
  const first = bob.locator('.chat-row').first().locator('button[aria-label="Reply"]')
  await first.evaluate((el) => el.focus())
  await first.click()
  await say(bob, '👍')
  const replied = (await lines(bob)).at(-1)
  check('a reply of one emoji is drawn large too', replied?.reply === true && replied.jumbo === true, JSON.stringify(replied))

  const PICTURE = 'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg'
  await say(alice, PICTURE)
  const toPicture = alice.locator('.chat-row').last().locator('button[aria-label="Reply"]')
  await toPicture.evaluate((el) => el.focus())
  await toPicture.click()
  await say(alice, '😂')
  await say(alice, `${PICTURE} 🎉`)
  const media = (await lines(alice)).slice(-2)
  check('a reply of one emoji to a picture is drawn large', media[0]?.reply === true && media[0].jumbo === true, JSON.stringify(media[0]))
  check('and so is an emoji beside a picture, without the address', media[1]?.jumbo === true && media[1].text === '🎉', JSON.stringify(media[1]))

  await openSettings(alice)
  await alice.waitForSelector('.levels')
  const names = await alice.$$eval('.levels .level-name', (els) => els.map((e) => e.textContent))
  check('the owner sees the levels of the space', names.join(',') === 'Owner,Admin,Moderator,Member', names.join(','))
  await alice.click('.levels button:has-text("New level")')
  await alice.waitForSelector('.level.open input[aria-label="The name of the level"]')
  await alice.fill('.level.open input[aria-label="The name of the level"]', 'Helpers')
  await alice.click('.level.open button[aria-label="Colour #2ec4b6"]')
  await alice.check('.level.open input[aria-label="Pin messages"]')
  await alice.click('.level.open button:text-is("Save")')
  await alice.waitForFunction(() => [...document.querySelectorAll('.levels .level-name')].some((e) => e.textContent === 'Helpers'))
  const helpers = await alice.$eval('.levels .level-name:text-is("Helpers")', (e) => getComputedStyle(e).color).catch(() => '')
  check('a new level has its name and colour', helpers === TEAL, helpers)
  await alice.click('button[aria-label="Close settings"]')

  await alice.waitForSelector('button[aria-label="Actions for Bob"]', { timeout: 20_000 })
  await alice.click('button[aria-label="Actions for Bob"]')
  await alice.waitForSelector('.menu')
  const offered = await alice.$$eval('.menu .menu-item', (els) => els.map((e) => e.textContent ?? ''))
  check('his menu offers the levels', offered.some((t) => t.includes('Helpers')) && offered.some((t) => t.includes('Moderator')), offered.join(' | ').slice(0, 120))
  await alice.click('.menu .menu-item:has-text("Helpers")')
  await alice.waitForTimeout(1500)

  const colourFor = (page) =>
    page.evaluate(() => {
      const name = [...document.querySelectorAll('.chat-name')].find((e) => e.textContent === 'Bob')
      const row = [...document.querySelectorAll('.rail-person .truncate')].find((e) => e.textContent?.startsWith('Bob'))
      return { chat: name ? getComputedStyle(name).color : '', rail: row ? getComputedStyle(row).color : '' }
    })
  const forAlice = await colourFor(alice)
  check('Alice sees his name in the colour of the level, in the conversation', forAlice.chat === TEAL, forAlice.chat)
  check('and in the list of people', forAlice.rail === TEAL, forAlice.rail)
  const bobSees = await bob
    .waitForFunction(
      (teal) => {
        const name = [...document.querySelectorAll('.chat-name')].find((e) => e.textContent === 'Bob')
        return name && getComputedStyle(name).color === teal
      },
      TEAL,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  check('and so does Bob', bobSees)

  const pin = await bob.$('.chat-row button[aria-label="Pin"], .chat-row button[aria-label="Unpin"]')
  check('Bob can pin now', pin !== null)
  await openSettings(bob)
  await bob.waitForSelector('.settings')
  check('but he cannot change the levels', (await bob.$('.levels')) === null)
  await bob.click('button[aria-label="Close settings"]')
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
