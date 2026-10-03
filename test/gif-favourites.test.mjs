import { APP_URL, check, finish, launch, makeSpace, poll, stoppedEarly } from './harness.mjs'

// The GIF picker has All and Favourites. A star on a GIF keeps it in Favourites, which needs no
// server, and the favourites go with your settings. The server's GIF search is faked here: the
// stack runs with no GIF key.
const browser = await launch()
// A one-pixel GIF, for every picture the fake service names.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')
const FAKE = ['cat', 'dog', 'fox'].map((name) => ({ url: `https://cdn.gif.test/${name}.gif`, preview: `https://cdn.gif.test/${name}-small.gif`, width: 200, height: 150 }))

async function person() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.route('https://cdn.gif.test/**', (route) => route.fulfill({ contentType: 'image/gif', body: PIXEL }))
  await context.route('**/api/v1/health', async (route) => {
    const real = await route.fetch()
    route.fulfill({ response: real, json: { ...(await real.json()), gifs: true } })
  })
  await context.route('**/api/v1/gifs?**', (route) => route.fulfill({ json: { gifs: FAKE, from: 'Fake' } }))
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate(() => localStorage.setItem('nook.name.v1', 'Gif'))
  await page.reload()
  return page
}

const favourites = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('nook.gifstars.v1') ?? '[]').map((g) => g.url))
const shown = (page) => page.locator('.gif-grid .gif-cell').count()
const tabs = (page) => page.locator('.gif-tab').evaluateAll((all) => all.map((t) => `${t.textContent}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`).join(' '))

try {
  const page = await person()
  await makeSpace(page, 'gifs')
  await page.click('button[aria-label="Find a GIF"]')
  check('the picker opens on All', await poll(async () => (await tabs(page)) === 'All* Favourites', 5000), await tabs(page))
  check('All shows what the search found', await poll(async () => (await shown(page)) === 3, 8000), String(await shown(page)))

  await page.click('.gif-tab:has-text("Favourites")')
  check('Favourites starts empty, and says how to fill it', await poll(() => page.locator('.gif-status:has-text("No favourites yet")').isVisible(), 3000))

  await page.click('.gif-tab:has-text("All")')
  await poll(async () => (await shown(page)) === 3, 5000)
  await page.locator('.gif-cell').nth(1).hover()
  await page.locator('.gif-cell').nth(1).locator('.gif-star').click()
  check('the star keeps the GIF, and the picker stays open', (await favourites(page)).join() === FAKE[1].url && (await page.locator('.gif-pop').count()) === 1)
  check('a starred GIF shows its star lit', (await page.locator('.gif-cell').nth(1).locator('.gif-star').getAttribute('aria-pressed')) === 'true')

  await page.click('.gif-tab:has-text("Favourites")')
  check('Favourites has the one starred', await poll(async () => (await shown(page)) === 1, 3000))

  await page.fill('.gif-search', 'fox')
  check('typing a search goes back to All', await poll(async () => (await tabs(page)) === 'All* Favourites', 3000), await tabs(page))

  await page.click('.gif-tab:has-text("Favourites")')
  await page.locator('.gif-cell .gif-choice').first().click()
  check('a favourite sends like any GIF, and the picker closes', await poll(async () => (await page.locator('.gif-pop').count()) === 0, 3000))
  const said = await page.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    return spaces.all()[0].chat.messages().map((m) => m.text).join('\n')
  })
  check('and what is said is its link, with its size', said.includes(`${FAKE[1].url}#200x150`), said)

  await page.click('button[aria-label="Find a GIF"]')
  await page.click('.gif-tab:has-text("Favourites")')
  await poll(async () => (await shown(page)) === 1, 3000)
  await page.locator('.gif-cell .gif-star').first().click()
  check('taking the star off in Favourites takes it from the list', await poll(async () => (await shown(page)) === 0 && (await favourites(page)).length === 0, 3000))

  const synced = await page.evaluate(async () => (await import('/src/store/prefs.ts')).localPrefs().values)
  check('favourites go with the settings to your other devices', 'nook.gifstars.v1' in synced)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}
finish()
