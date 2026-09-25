import { APP_URL, check, finish, launch, stoppedEarly, wait } from './harness.mjs'

const BOX = '[aria-label="Write a message"]'
const SAID = 'said on the first device'

const browser = await launch({ named: false })
const fresh = async () => (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()

async function makeLink(page) {
  await page.click('button[aria-label="Settings"]')
  await page.click('button:text-is("Link a device")')
  const code = page.locator('.link-code')
  await code.waitFor({ timeout: 15_000 })
  const offer = {
    code: (await code.textContent()).trim(),
    link: await code.getAttribute('data-link'),
    server: (await page.locator('.link-server').textContent()).trim(),
  }
  await page.keyboard.press('Escape')
  await page.click('button[aria-label="Close settings"]')
  return offer
}

async function whoIs(page) {
  await page.waitForSelector('input[aria-label="Space name"]', { timeout: 20_000 })
  const spaces = await page
    .waitForFunction(() => {
      const rows = [...document.querySelectorAll('.space-row .space-row-name')].map((e) => e.textContent)
      return rows.length ? rows : null
    }, null, { timeout: 20_000 })
    .then((h) => h.jsonValue())
    .catch(() => [])
  await page.click('button[aria-label="Settings"]')
  await page.waitForSelector('input[aria-label="Your name"]')
  const me = await page.evaluate(() => ({
    name: document.querySelector('input[aria-label="Your name"]')?.value ?? '',
    id: [...document.querySelectorAll('.share-code')].map((e) => e.textContent).find((t) => t?.startsWith('#')) ?? '',
  }))
  await page.click('button[aria-label="Close settings"]')
  return { ...me, spaces }
}

try {
  const ana = await fresh()
  await ana.goto(APP_URL)
  await ana.click('.welcome-step:not(.hidden) button.primary')
  await ana.fill('input[aria-label="Your name"]', 'Ana')
  await ana.keyboard.press('Enter')
  await ana.fill('input[aria-label="Space name"]', 'linked')
  await ana.click('button:has-text("New space")')
  await ana.waitForSelector(BOX)
  await ana.click(BOX)
  await ana.keyboard.type(SAID)
  await ana.keyboard.press('Enter')
  await wait(1500)
  await ana.click('button[aria-label="Switch space"]')
  await ana.click('.menu.switcher .menu-item:has-text("Home")')
  const her = await whoIs(ana)

  const first = await makeLink(ana)
  check('a link comes as a code of three groups of four', /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(first.code), first.code)

  const two = await fresh()
  await two.goto(APP_URL)
  await two.click('button:has-text("I have an account")')
  await two.click('button:has-text("Use my other device")')
  check('linking asks for no name: the name comes with the account', (await two.$('input[aria-label="Your name"]:visible')) === null)
  check('the code shows the server it waits on, to type beside it', first.server === 'localhost:8787', first.server)
  await two.fill('input[aria-label="The link or code"]', first.code.toLowerCase().replace(/-/g, ''))
  const shaped = await two.inputValue('input[aria-label="The link or code"]')
  check('a code is shaped as it is typed', shaped === first.code, shaped)
  await two.fill('input[aria-label="The server"]', first.server)
  await two.click('button:text-is("Link this device")')
  await two.waitForURL((url) => !url.hash, { timeout: 15_000 }).catch(() => undefined)
  await wait(1500)
  const asTwo = await whoIs(two)
  check('typing the code makes the new device the same person', asTwo.name === 'Ana' && asTwo.id === her.id, JSON.stringify(asTwo))
  check('with the same spaces', asTwo.spaces.includes('linked'), asTwo.spaces.join(', '))
  await two.click('.space-row .rail-item')
  const read = await two
    .waitForFunction((said) => [...document.querySelectorAll('.chat-text')].some((t) => t.textContent.includes(said)), SAID, { timeout: 20_000 })
    .then(() => true, () => false)
  check('and the same messages', read)

  const three = await fresh()
  await three.goto(first.link)
  const refused = await three
    .waitForFunction(() => document.querySelector('.welcome-text')?.textContent?.includes('used') ?? false, null, { timeout: 15_000 })
    .then(() => true, () => false)
  check('a code works once', refused)
  await three.click('button:text-is("Skip")')
  await three.waitForSelector('button:has-text("I have an account")', { timeout: 10_000 })

  const second = await makeLink(ana)
  await three.goto(second.link)
  await three.waitForURL((url) => !url.hash, { timeout: 20_000 }).catch(() => undefined)
  await wait(1500)
  const asThree = await whoIs(three)
  check('opening the link does it in one go', asThree.name === 'Ana' && asThree.id === her.id && asThree.spaces.includes('linked'), JSON.stringify(asThree))

  const third = await makeLink(ana)
  const four = await fresh()
  await four.goto(APP_URL)
  await four.click('button:has-text("I have an account")')
  await four.click('button:has-text("Use my other device")')
  await four.fill('input[aria-label="The link or code"]', third.link)
  await four.waitForURL((url) => !url.hash && url.href !== APP_URL + '#', { timeout: 20_000 }).catch(() => undefined)
  await wait(2500)
  const asFour = await whoIs(four)
  check('a link pasted where the code goes needs nothing more', asFour.name === 'Ana' && asFour.id === her.id, JSON.stringify(asFour))

  const nothing = await fetch('http://localhost:8787/api/v1/links/' + '0'.repeat(32))
  check('a link nobody left is not there', nothing.status === 404, String(nothing.status))
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
