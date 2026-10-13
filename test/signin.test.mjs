import { APP_URL, HOME, check, finish, launch, makeSpace, openSettingsTab, stoppedEarly, wait } from './harness.mjs'

// Ways back in that need no camera and no other device that is open: a passkey, a recovery key,
// and a code that the new device shows and the signed in one types.
const browser = await launch({ named: false })
const fresh = async () => (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
const keyOf = (page) => page.evaluate(() => localStorage.getItem('nook.identity.v1'))

async function ana() {
  const page = await fresh()
  await page.goto(APP_URL)
  await page.click('.welcome-step:not(.hidden) button.primary')
  await page.click('.tour-skip')
  await page.fill('input[aria-label="Your name"]', 'Ana')
  await page.keyboard.press('Enter')
  await makeSpace(page, 'signin')
  await page.waitForSelector('[aria-label="Write a message"]')
  return page
}

async function closeSettings(page) {
  await page.click('button[aria-label="Close settings"]:visible')
}

try {
  const her = await ana()
  const herKey = await keyOf(her)

  // A recovery key.
  await openSettingsTab(her, 'devices')
  await her.click('button:text-is("Make a recovery key")')
  const shown = await her.locator('.recovery-key').waitFor({ timeout: 15_000 }).then(() => her.locator('.recovery-key').textContent())
  check('a recovery key is four groups of five', /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/.test(shown.trim()), shown)
  await her.click('button:text-is("I have saved it")')
  check('Settings says a recovery key is in use', (await her.textContent('.settings-stack')).includes('A recovery key is in use'))
  await closeSettings(her)

  const two = await fresh()
  await two.goto(APP_URL)
  await two.click('button:has-text("I have an account")')
  await two.click('button:has-text("Use a recovery key")')
  check('the server is not asked for when the key is on this device’s own', !(await two.isVisible('input[aria-label="The server for the recovery key"]')))
  await two.fill('input[aria-label="The recovery key"]', shown.trim().toLowerCase().replace(/-/g, ''))
  check('a key is shaped as it is typed', (await two.inputValue('input[aria-label="The recovery key"]')) === shown.trim())
  await two.click('button:text-is("Sign in")')
  await two.waitForSelector(HOME, { timeout: 25_000 })
  await wait(1500)
  check('a recovery key makes the new device the same account', (await keyOf(two)) === herKey)

  const wrong = await fresh()
  await wrong.goto(APP_URL)
  await wrong.click('button:has-text("I have an account")')
  await wrong.click('button:has-text("Use a recovery key")')
  await wrong.fill('input[aria-label="The recovery key"]', 'AAAAA-BBBBB-CCCCC-DDDDD')
  await wrong.click('button:text-is("Sign in")')
  const refused = await wrong.waitForSelector('.toast', { timeout: 15_000 }).then(() => true, () => false)
  check('a key nobody made opens nothing', refused && (await keyOf(wrong)) !== herKey)

  // A new key takes the old one's place.
  await openSettingsTab(her, 'devices')
  await her.click('button:text-is("Make a new recovery key")')
  await her.locator('.recovery-key').waitFor({ timeout: 15_000 })
  const newer = (await her.locator('.recovery-key').textContent()).trim()
  await her.click('button:text-is("I have saved it")')
  await closeSettings(her)
  const old = await fresh()
  await old.goto(APP_URL)
  await old.click('button:has-text("I have an account")')
  await old.click('button:has-text("Use a recovery key")')
  await old.fill('input[aria-label="The recovery key"]', shown.trim())
  await old.click('button:text-is("Sign in")')
  const stale = await old.waitForSelector('.toast', { timeout: 15_000 }).then(() => true, () => false)
  check('making a new recovery key stops the old one', stale && newer !== shown.trim() && (await keyOf(old)) !== herKey)

  // A code the new device shows, typed on the one that is signed in.
  const three = await fresh()
  await three.goto(APP_URL)
  await three.click('button:has-text("I have an account")')
  await three.click('button:has-text("Use my other device")')
  const code = (await three.locator('.receive-code').waitFor({ timeout: 15_000 }).then(() => three.locator('.receive-code').textContent())).trim()
  check('a new device shows a code of three groups of four', /^[0-9A-Z]{4}(-[0-9A-Z]{4}){2}$/.test(code), code)
  await openSettingsTab(her, 'devices')
  await her.click('button:text-is("Link a device")')
  await her.locator('.link-code').waitFor({ timeout: 15_000 })
  check('the signed in device does not ask for the server', !(await her.isVisible('input[aria-label="The server the new device shows"]')))
  await her.fill('input[aria-label="The code the new device shows"]', code.replace(/-/g, '').toLowerCase())
  await her.click('button:text-is("Link it")')
  await three.waitForSelector(HOME, { timeout: 30_000 })
  await wait(1500)
  check('typing the new device’s code on the signed in one links it', (await keyOf(three)) === herKey)
  const told = await her
    .waitForFunction(() => document.querySelector('.modal .link-news-title')?.textContent === 'Linked', null, { timeout: 15_000 })
    .then(() => true, () => false)
  check('and the signed in device is told Linked', told)

  // The server keeps a link for a device that is not there yet only while it waits.
  const nothing = await fetch(`${new URL(APP_URL).protocol}//localhost:${process.env.SERVER_PORT ?? 8787}/api/v1/links/${'2'.repeat(32)}?wait=1`)
  check('a wait for a link that never comes says so, not an error', nothing.status === 200 || nothing.status === 404)

  // A vault belongs to whoever claimed it first.
  const api = `http://localhost:${process.env.SERVER_PORT ?? 8787}/api/v1/vaults/${'a'.repeat(32)}`
  const put = (token, blob = 'x.y') => fetch(api, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-nook-write': token }, body: JSON.stringify({ blob }) })
  check('a vault is claimed by its first write', (await put('mine')).status === 200)
  check('and another token cannot change it', (await put('theirs')).status === 403)
  check('or remove it', (await fetch(api, { method: 'DELETE', headers: { 'x-nook-write': 'theirs' } })).status === 403)
  check('anybody can read the sealed string, which opens for nobody without its key', (await (await fetch(api)).json()).blob === 'x.y')
  check('its owner removes it', (await fetch(api, { method: 'DELETE', headers: { 'x-nook-write': 'mine' } })).status === 200)
  check('and it is gone', (await fetch(api)).status === 404)

  // A passkey, on a virtual authenticator that holds the PRF secret.
  const pk = await ana()
  const pkKey = await keyOf(pk)
  const cdp = await pk.context().newCDPSession(pk)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  })
  await openSettingsTab(pk, 'devices')
  await pk.click('button:text-is("Make a passkey")')
  const made = await pk.waitForFunction(() => document.body.textContent.includes('Passkey made'), null, { timeout: 20_000 }).then(() => true, () => false)
  check('a passkey is made, and Settings lists it', made)
  await closeSettings(pk)
  // Log out: the device forgets the key. The passkey is in the authenticator, as in a keychain.
  await pk.evaluate(() => {
    const keep = localStorage.getItem('nook.vaults.v1')
    localStorage.clear()
    void keep
  })
  await pk.goto(APP_URL)
  await pk.click('button:has-text("I have an account")')
  await pk.click('button:text-is("Sign in with a passkey")')
  await pk.waitForSelector(HOME, { timeout: 30_000 })
  await wait(1500)
  check('a passkey signs a signed out device back in, with one click', (await keyOf(pk)) === pkKey)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
