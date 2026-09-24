/**
 * Voice that keeps going, calls between two people, and the settings that
 * find out why voice is not working.
 *
 *   carrying on   Ada stands in the lounge and goes Home: the call carries on,
 *                 and the foot of the channels says so, with a way out
 *   a call        Ada rings Ben from their conversation; Ben's screen rings,
 *                 he answers, and both hear each other
 *   kept out      Cat knows the call's name and walks into it: nobody answers
 *   hanging up    Ben hangs up, and Ada is told and taken out of it
 *   declining     Ada rings again and Ben says no, and Ada is told
 *   the tester    the microphone test moves its meter, and the connection
 *                 test says what the server's relay is doing
 *
 *   node test/call-check.mjs
 */

import { chromium } from 'playwright-core'
import { nameEveryone } from './named.mjs'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BOX = '[aria-label="Write a message"]'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOTS = new URL('../test-output/calls/', import.meta.url).pathname
const { mkdirSync } = await import('node:fs')
mkdirSync(SHOTS, { recursive: true })
const shot = (page, name) => page.screenshot({ path: `${SHOTS}${name}.png` })
async function waitFor(fn, ms) {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    last = await fn().catch(() => null)
    if (last) return last
    await wait(300)
  }
  return null
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
nameEveryone(browser)

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await context.grantPermissions(['microphone'], { origin: new URL(APP_URL).origin })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('cathode.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

/** How loud what is coming in is, over a couple of seconds. The fake microphone beeps. */
const loudness = (page) =>
  page.evaluate(async () => {
    const sinks = [...document.querySelectorAll('audio.voice-sink')].filter((a) => a.srcObject)
    if (sinks.length === 0) return 0
    const ctx = new AudioContext()
    await ctx.resume()
    const analyser = ctx.createAnalyser()
    for (const s of sinks) ctx.createMediaStreamSource(s.srcObject).connect(analyser)
    const data = new Float32Array(analyser.fftSize)
    let peak = 0
    const end = performance.now() + 2500
    while (performance.now() < end) {
      analyser.getFloatTimeDomainData(data)
      for (const v of data) peak = Math.max(peak, Math.abs(v))
      await new Promise((r) => setTimeout(r, 50))
    }
    await ctx.close()
    return peak
  })

const toastSays = (page, words) =>
  waitFor(
    () => page.evaluate((w) => ([...document.querySelectorAll('.toast')].some((t) => t.textContent.includes(w)) ? true : null), words),
    15_000,
  )

const toHome = async (page) => {
  await page.click('button[aria-label="Switch space"]')
  await page.click('.menu.switcher .menu-item:has-text("Home")')
}

try {
  const ada = await person('Ada')
  await ada.fill('input[aria-label="Space name"]', 'calls')
  await ada.click('button:has-text("New space")')
  await ada.waitForSelector(BOX)
  const link = ada.url()
  const ben = await person('Ben')
  await ben.goto(link)
  await ben.waitForSelector(BOX)
  await waitFor(() => ada.evaluate(() => (document.querySelectorAll('.rail-person').length === 2 ? true : null)), 20_000)

  // ---- voice carries on off screen ----
  for (const page of [ada, ben]) {
    await page.click('.voice-channel .rail-item:has-text("lounge")')
    await page.waitForSelector('.voice-bar:not(.hidden)', { timeout: 15_000 })
  }
  const inLounge = await waitFor(async () => ((await loudness(ben)) > 0.01 ? true : null), 20_000)
  check('two people in the lounge hear each other', !!inLounge)
  await toHome(ada)
  await ada.waitForSelector('.home-grid-shell')
  const dock = await waitFor(
    () => ada.evaluate(() => {
      const d = document.querySelector('.voice-dock:not(.hidden)')
      return d ? d.textContent : null
    }),
    5000,
  )
  check('going Home keeps the call, and the foot of the channels says so', !!dock && dock.includes('lounge'), dock ?? 'no dock')
  check('and it still carries sound', (await loudness(ben)) > 0.01 && (await loudness(ada)) > 0.01)
  await ada.click('.voice-dock button[aria-label="Leave voice"]')
  await ben.click('.voice-bar:not(.voice-dock) button[aria-label="Leave"]')
  await wait(800)
  check('and it can be left from there', (await ada.$('.voice-dock:not(.hidden)')) === null)
  check('and from the space itself', (await ben.$('.voice-bar:not(.voice-dock):not(.hidden)')) === null)

  // ---- a call ----
  await ada.click('button[aria-label="Switch space"]')
  await ada.click('.menu.switcher .menu-item:has-text("calls")')
  await ada.waitForSelector(BOX)
  await ada.click(BOX)
  await ada.keyboard.type('/dm Ben hello')
  await ada.keyboard.press('Enter')
  await ada.waitForSelector('.home-grid-shell.dm-open', { timeout: 10_000 })
  await ada.click('.space-head button[aria-label="Call"]')
  const calling = await waitFor(() => ada.evaluate(() => document.querySelector('.call-strip:not(.hidden)')?.textContent ?? null), 8000)
  check('pressing call says it is calling', !!calling && calling.includes('Calling Ben'), calling ?? 'nothing')

  const rang = await waitFor(() => ben.evaluate(() => document.querySelector('.call-card .call-name')?.textContent ?? null), 15_000)
  check('the other end rings, and says who', rang === 'Ada', rang ?? 'no ring')
  await shot(ben, 'ringing')
  await ben.click('.call-card .call-answer')
  const live = await waitFor(
    () => ada.evaluate(() => document.querySelector('.call-strip.live')?.textContent ?? null),
    15_000,
  )
  check('answering puts the two of them in a call', !!live && live.includes('In a call with Ben'), live ?? 'not live')
  const benOnDm = await waitFor(() => ben.evaluate(() => document.querySelector('.call-strip.live')?.textContent ?? null), 8000)
  check('and takes Ben to the conversation, where the call is', !!benOnDm && benOnDm.includes('Ada'), benOnDm ?? 'not there')
  const heard = await waitFor(async () => ((await loudness(ada)) > 0.01 && (await loudness(ben)) > 0.01 ? true : null), 20_000)
  check('and they hear each other', !!heard)
  await shot(ada, 'in-call')

  // ---- somebody else walking in ----
  const cat = await person('Cat')
  await cat.goto(link)
  await cat.waitForSelector(BOX)
  await wait(1500)
  const channel = await ada.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    return spaces.all().find((s) => s.call)?.call?.channel ?? null
  })
  await cat.evaluate(async (name) => {
    const { spaces } = await import('/src/space/registry.ts')
    await spaces.all()[0].voice.join(name)
  }, channel)
  await wait(6000)
  const catHears = await cat.evaluate(() => [...document.querySelectorAll('audio.voice-sink')].filter((a) => a.srcObject).length)
  check('somebody else who knows its name cannot get into the call', !!channel && catHears === 0, `${channel}, ${catHears} connections`)

  // ---- hanging up ----
  await ben.click('.call-strip button[aria-label="Hang up"]')
  check('hanging up tells the other end', !!(await toastSays(ada, 'Call ended')))
  const adaOut = await waitFor(() => ada.evaluate(() => (document.querySelector('.call-strip.hidden') ? true : null)), 5000)
  check('and takes them out of it', !!adaOut)

  // ---- declining ----
  await ada.click('.space-head button[aria-label="Call"]')
  await waitFor(() => ben.evaluate(() => (document.querySelector('.call-card') ? true : null)), 15_000)
  await ben.click('.call-card .call-decline')
  check('declining tells the caller', !!(await toastSays(ada, 'declined')))

  // ---- the settings that find out why ----
  await cat.click('button[aria-label="Settings"]')
  await cat.waitForSelector('button:has-text("Test microphone")')
  await cat.click('button:has-text("Test microphone")')
  const moved = await waitFor(
    () => cat.evaluate(() => (parseFloat(document.querySelector('.meter > i')?.style.width ?? '0') > 5 ? document.querySelector('.meter > i').style.width : null)),
    10_000,
  )
  check('the microphone test moves its meter', !!moved, moved ?? 'flat')
  await cat.click('button:has-text("Test connection")')
  const relay = await waitFor(() => cat.evaluate(() => document.querySelector('.relay-result')?.textContent ?? null), 15_000)
  check('and the connection test says what the relay is doing', !!relay, relay ?? 'nothing')
  await cat.evaluate(() => document.querySelector('.mic-test')?.scrollIntoView({ block: 'center' }))
  await wait(300)
  await shot(cat, 'voice-settings')
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
