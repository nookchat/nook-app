import { APP_URL, check, finish, launch, stoppedEarly } from './harness.mjs'
import { startServer } from './pg.mjs'

// Files sealed the ways Nook has ever sealed them still open, whole and a range at a time
// through the service worker, byte for byte: sealed whole, as the first files were, and in
// pieces of any size. A piece changed or moved is refused. A stream let go part way, and one
// that jumps, still gives the right bytes.

const SERVER = 'http://localhost:8861'
const server = await startServer(8861)
const browser = await launch()

async function person(name) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate(
    ({ n, server }) => {
      localStorage.setItem('nook.name.v1', n)
      localStorage.setItem('nook.server.v1', server)
      localStorage.setItem('nook.servers.v1', JSON.stringify([server]))
    },
    { n: name, server: SERVER },
  )
  await page.reload()
  return page
}

// The page's own tools for every step, then the old sealing code, as it was written.
const TOOLS = `
  const { spaces } = await import('/src/space/registry.ts')
  const { filesFor } = await import('/src/space/runtime.ts')
  for (let i = 0; i < 100 && !spaces.all()[0]; i++) await new Promise((ok) => setTimeout(ok, 100))
  const space = spaces.all()[0]
  const files = filesFor(space)
  const base64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  const label = (index, last) => {
    const out = new Uint8Array(5)
    new DataView(out.buffer).setUint32(0, index)
    out[4] = last ? 1 : 0
    return out
  }
  const plainOf = (size, seed) => {
    const out = new Uint8Array(size)
    let x = seed
    for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = x >>> 24 }
    return out
  }
  const sealWhole = async (key, plain) => {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    return new Blob([iv, await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)])
  }
  const sealPieces = async (key, plain, chunk) => {
    const count = Math.max(1, Math.ceil(plain.length / chunk))
    const parts = []
    for (let i = 0; i < count; i++) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: label(i, i === count - 1) }, key, plain.subarray(i * chunk, (i + 1) * chunk))
      parts.push(iv, box)
    }
    return parts
  }
  const upload = async (blob) => {
    const res = await fetch(space.server + '/api/v1/spaces/' + space.room.id + '/files', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-nook-write': space.room.write }, body: blob,
    })
    return (await res.json()).id
  }
  const make = async (size, seed, chunk, spoil) => {
    const plain = plainOf(size, seed)
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    let blob
    if (chunk) {
      const parts = await sealPieces(key, plain, chunk)
      if (spoil === 'flip') new Uint8Array(parts[7])[100] ^= 1
      if (spoil === 'swap') [parts[6], parts[8], parts[7], parts[9]] = [parts[8], parts[6], parts[9], parts[7]]
      blob = new Blob(parts)
    } else blob = await sealWhole(key, plain)
    const id = await upload(blob)
    const file = { id, name: 'f.bin', type: 'video/mp4', size, key: base64(new Uint8Array(await crypto.subtle.exportKey('raw', key)))  }
    if (chunk) file.chunk = chunk
    return { file, plain }
  }
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
  const range = async (file, from, to) => {
    const res = await fetch(files.streamUrl(file), { headers: { range: 'bytes=' + from + '-' + to } })
    return new Uint8Array(await res.arrayBuffer())
  }
`

const inPage = (page, body, arg) =>
  page.evaluate(({ tools, body, arg }) => new Function('arg', `return (async () => { ${tools}\n${body} })()`)(arg), { tools: TOOLS, body, arg })

try {
  const alice = await person('Alice')
  await alice.waitForSelector('input[aria-label="Space name"]')
  await alice.fill('input[aria-label="Space name"]', 'crypto')
  await alice.click('button:has-text("New space")')
  await alice.waitForSelector('button[aria-label="Attach files"]:not(.hidden)', { timeout: 20_000 })
  await alice.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10_000 }).catch(() => alice.reload())
  await alice.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10_000 })
  await alice.waitForSelector('.space-name', { timeout: 20_000 })

  const whole = await inPage(alice, `
    const { file, plain } = await make(700_000, 1, 0)
    return same(new Uint8Array(await (await files.open(file)).arrayBuffer()), plain)
  `)
  check('a file sealed whole, as the first files were, opens byte for byte', whole)

  for (const [chunk, size, seed] of [[256 * 1024, 5 * 1024 * 1024 + 12345, 2], [100_000, 3_000_001, 3], [256 * 1024, 256 * 1024, 4], [256 * 1024, 1000, 5]]) {
    const got = await inPage(alice, `
      const [chunk, size, seed] = arg
      const out = {}
      { const { file, plain } = await make(size, seed, chunk); out.open = same(new Uint8Array(await (await files.open(file)).arrayBuffer()), plain) }
      const { file, plain } = await make(size, seed + 100, chunk)
      const all = new Uint8Array(await (await fetch(files.streamUrl(file))).arrayBuffer())
      out.stream = same(all, plain)
      let ranges = 0
      for (let i = 0; i < 25; i++) {
        const from = Math.floor(Math.random() * size)
        const to = Math.min(size - 1, from + Math.floor(Math.random() * 3 * chunk))
        if (same(await range(file, from, to), plain.subarray(from, to + 1))) ranges++
      }
      out.ranges = ranges
      const tail = await range(file, size - 1, size - 1)
      out.tail = tail.length === 1 && tail[0] === plain[size - 1]
      return out
    `, [chunk, size, seed])
    check(
      `pieces of ${chunk} bytes, ${size} bytes in all: whole, streamed, and 25 random ranges match`,
      got.open && got.stream && got.ranges === 25 && got.tail,
      JSON.stringify(got),
    )
  }

  const letGo = await inPage(alice, `
    const size = 12 * 1024 * 1024
    const { file, plain } = await make(size, 9, 256 * 1024)
    const url = files.streamUrl(file)
    const first = await fetch(url)
    const reader = first.body.getReader()
    let n = 0
    while (n < 1_500_000) n += (await reader.read()).value.length
    await reader.cancel()
    // At once beside it, then far away, then after the grace time where the stopped window was.
    const near = same(await range(file, 1_400_000, 3_000_000), plain.subarray(1_400_000, 3_000_001))
    const far = same(await range(file, 9_000_000, 9_900_000), plain.subarray(9_000_000, 9_900_001))
    await new Promise((ok) => setTimeout(ok, 800))
    const again = same(await range(file, 2_500_000, 4_500_000), plain.subarray(2_500_000, 4_500_001))
    const rest = same(new Uint8Array(await (await fetch(url)).arrayBuffer()), plain)
    return { near, far, again, rest }
  `)
  check('a stream let go part way, then asked beside, far off and again, gives the right bytes', Object.values(letGo).every(Boolean), JSON.stringify(letGo))

  const jumps = await inPage(alice, `
    const size = 6 * 1024 * 1024
    const { file, plain } = await make(size, 11, 256 * 1024)
    const at = [0, 4_000_000, 1_000_000, 5_500_000, 2_000_000]
    const got = await Promise.all(at.map((from) => range(file, from, Math.min(size - 1, from + 700_000))))
    return got.every((bytes, i) => same(bytes, plain.subarray(at[i], Math.min(size, at[i] + 700_001))))
  `)
  check('five ranges asked at once, out of order, all match', jumps)

  for (const spoil of ['flip', 'swap']) {
    const got = await inPage(alice, `
      const { file } = await make(3 * 1024 * 1024, 21, 256 * 1024, arg)
      const opened = await files.open(file).then(() => 'opened', () => 'refused')
      const { file: again } = await make(3 * 1024 * 1024, 22, 256 * 1024, arg)
      const streamed = await fetch(files.streamUrl(again)).then((r) => r.arrayBuffer()).then(() => 'opened', () => 'refused')
      const early = await range(again, 0, 100_000).then(() => 'opened', () => 'refused')
      return { opened, streamed, early }
    `, spoil)
    check(
      spoil === 'flip' ? 'one byte changed in a piece: the file is refused, whole and streamed' : 'two pieces swapped: the file is refused, whole and streamed',
      got.opened === 'refused' && got.streamed === 'refused' && got.early === 'opened',
      JSON.stringify(got),
    )
  }

  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector('.space-name', { timeout: 20_000 })
  await bob.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10_000 })
  const sent = await inPage(alice, `
    const plain = plainOf(4 * 1024 * 1024 + 77, 31)
    const file = await files.send(new File([plain], 'n.bin', { type: 'video/webm' }), () => undefined, new AbortController().signal)
    return { file, plain: Array.from(plain.subarray(0, 64)), sum: plain.reduce((a, b) => (a + b) >>> 0, 0) }
  `)
  const read = await inPage(bob, `
    const { file } = arg
    const whole = new Uint8Array(await (await fetch(files.streamUrl(file))).arrayBuffer())
    const opened = new Uint8Array(await (await files.open(file)).arrayBuffer())
    return { sum: whole.reduce((a, b) => (a + b) >>> 0, 0), same: same(whole, opened), head: Array.from(opened.subarray(0, 64)), size: opened.length }
  `, sent)
  check(
    'a file sent now opens on another device, streamed and whole',
    read.sum === sent.sum && read.same && read.size === sent.file.size && read.head.join() === sent.plain.join(),
    `${read.size} bytes`,
  )
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  server.child.kill()
}

finish()
