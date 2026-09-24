/**
 * How fast it feels, in milliseconds.
 *
 * Seeds one space on the server with a few thousand real, signed messages,
 * then times what a person waits for: opening the
 * space, switching channel, a sent message reaching the screen, and coming
 * back to a space already opened once. Each is the median of a few runs.
 *
 *   node test/speed.mjs [app url] [messages]
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const COUNT = Number(process.argv[3] ?? 3000)
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto(APP_URL)
await page.evaluate(() => localStorage.setItem('cathode.name.v1', 'Speedy'))
await page.reload()
await page.waitForSelector('input[aria-label="Space name"]')

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

// Seed: a space, two channels, COUNT messages across them, written to the
// server the way a device writes them: signed, sealed, and posted.
const link = await page.evaluate(async (count) => {
  const room = await import('/src/room.ts')
  const log = await import('/src/store/log.ts')
  const id = await import('/src/store/identity.ts')
  const { sealEvent } = await import('/src/net/server-api.ts')
  const { defaultServer } = await import('/src/backend.ts')
  const secret = room.newSecret()
  const r = await room.deriveRoom(secret)
  const me = id.loadIdentity().pubkey
  const events = []
  let lamport = Date.now() - count - 100
  events.push(await log.makeEvent(r.id, me, lamport++, 'role', { subject: me, role: 'admin' }))
  events.push(await log.makeEvent(r.id, me, lamport++, 'space', { name: 'Heavy' }))
  events.push(await log.makeEvent(r.id, me, lamport++, 'channel', { name: 'other' }))
  for (let i = 0; i < count; i++) {
    const channel = i % 3 === 0 ? 'other' : 'general'
    events.push(
      await log.makeEvent(r.id, me, lamport++, 'said', {
        text: `Message number ${i}, with **some** words in it and a link https://example.org/${i}`,
        channel,
      }),
    )
  }
  const server = defaultServer()
  const lines = await Promise.all(events.map((e) => sealEvent(r.key, e)))
  for (let i = 0; i < lines.length; i += 300) {
    const res = await fetch(`${server}/api/v1/spaces/${r.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cathode-write': r.write },
      body: JSON.stringify(lines.slice(i, i + 300)),
    })
    if (!res.ok) throw new Error(`the server refused the seed: ${res.status}`)
  }
  return room.roomLink(secret, false, server)
}, COUNT)
// Opened once, so it is on this device's list of spaces.
await page.goto(link)
await page.waitForFunction(() => document.querySelector('.space-name')?.textContent === 'Heavy', null, { timeout: 30_000 })
console.log(`seeded ${COUNT} messages`)

const BOX = '[aria-label="Write a message"]'
const lastLine = `Message number ${COUNT - 1 - ((COUNT - 1) % 3 === 0 ? 1 : 0)}`

const open = []
for (let i = 0; i < 5; i++) {
  await page.goto(APP_URL)
  await page.waitForSelector('.space-row .rail-item')
  const t = await page.evaluate(async (want) => {
    const start = performance.now()
    document.querySelector('.space-row .rail-item').click()
    await new Promise((done) => {
      const look = () => {
        const texts = document.querySelectorAll('.chat-text')
        if (texts.length && texts[texts.length - 1].textContent.includes(want)) done()
        else requestAnimationFrame(look)
      }
      look()
    })
    return performance.now() - start
  }, lastLine)
  open.push(t)
}
console.log(`open a space with history      ${median(open).toFixed(0)} ms   (runs ${open.map((x) => x.toFixed(0)).join(', ')})`)

const railLate = await page.evaluate(async () => {
  const start = performance.now()
  while (![...document.querySelectorAll('.rail-item')].some((b) => b.textContent.includes('other'))) {
    if (performance.now() - start > 10_000) return -1
    await new Promise((r) => requestAnimationFrame(r))
  }
  return performance.now() - start
})
console.log(`channel rail after the messages ${railLate.toFixed(0)} ms`)
const switches = []
for (let i = 0; i < 6; i++) {
  const to = i % 2 === 0 ? 'other' : 'general'
  const t = await page.evaluate(async (name) => {
    const button = [...document.querySelectorAll('.rail-item')].find((b) => b.textContent.includes(name))
    const start = performance.now()
    button.click()
    await new Promise((done) => {
      const look = () => {
        if (document.querySelector('.channel-head')?.textContent?.includes(name) || performance.now() - start > 2000) done()
        else requestAnimationFrame(look)
      }
      look()
    })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return performance.now() - start
  }, to)
  switches.push(t)
}
console.log(`switch channel                 ${median(switches).toFixed(0)} ms`)

const sends = []
for (let i = 0; i < 5; i++) {
  await page.click(BOX)
  await page.keyboard.type(`speed ${i}`)
  const t = await page.evaluate(async (want) => {
    const box = document.querySelector('[aria-label="Write a message"]')
    const start = performance.now()
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise((done) => {
      const look = () => {
        if ([...document.querySelectorAll('.chat-text')].some((n) => n.textContent === want)) done()
        else if (performance.now() - start > 5000) done()
        else requestAnimationFrame(look)
      }
      look()
    })
    const took = performance.now() - start
    return took > 5000 ? Number.NaN : took
  }, `speed ${i}`)
  sends.push(t)
  if (Number.isNaN(t)) console.log('  a sent message never appeared:', await page.evaluate(() => [...document.querySelectorAll('.chat-text')].slice(-2).map((n) => n.textContent)))
}
console.log(`a sent message on screen       ${median(sends).toFixed(0)} ms`)

const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0)
const nodes = await page.evaluate(() => document.getElementsByTagName('*').length)
console.log(`heap ${(heap / 1e6).toFixed(1)} MB, ${nodes} DOM nodes`)
console.log(`link ${link}`)
await browser.close()
