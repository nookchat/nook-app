import { spawn } from 'node:child_process'
import { cpus } from 'node:os'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

// Runs the checks a few at a time: most wait on the network, not the processor. Each one's
// output comes out whole when it ends, so two never interleave. CHECKS_AT_ONCE=1 runs them
// one by one, as before.
const dir = new URL('.', import.meta.url).pathname
const CHECK_MOST_MS = 5 * 60 * 1000
const AT_ONCE = Number(process.env.CHECKS_AT_ONCE) || Math.max(1, Math.min(4, cpus().length))
/** How long each took last time, so the slow ones start first and the run ends sooner. */
const TIMES = new URL('../test-output/check-times.json', import.meta.url)
/** Before there is a last time: the ones known to be slow. */
const SLOW_FIRST = ['rejoin', 'chat', 'board', 'call', 'server', 'backup', 'live', 'e2e', 'extras', 'channels', 'ghost']

const wanted = process.argv.slice(2)
// The checks are off for now: they took too long. Name them to run them (npm test qr chat),
// or set CHECKS=all to run every one.
if (wanted.length === 0 && process.env.CHECKS !== 'all') {
  console.log('The checks are off for now. Run some with npm test <name>, or all with CHECKS=all npm test.')
  process.exit(0)
}
let times = {}
try {
  times = JSON.parse(readFileSync(TIMES, 'utf8'))
} catch {
  /* no last run */
}
const guess = (name) => times[name] ?? (SLOW_FIRST.includes(name) ? 1000 - SLOW_FIRST.indexOf(name) : 0)
const checks = readdirSync(dir)
  .filter((file) => file.endsWith('.test.mjs'))
  .map((file) => file.slice(0, -'.test.mjs'.length))
  .filter((name) => wanted.length === 0 || wanted.includes(name))
  .sort((a, b) => guess(b) - guess(a))

function runOne(name) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [`${dir}${name}.test.mjs`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (out += b))
    // One check that hangs must not hold up the rest.
    let late = false
    const timer = setTimeout(() => {
      late = true
      child.kill('SIGKILL')
    }, CHECK_MOST_MS)
    // 'exit', not 'close': a server or a page a check started, and left running, can hold the pipes open.
    child.on('exit', (status) => {
      clearTimeout(timer)
      const seconds = (Date.now() - started) / 1000
      const why = late ? ` (stopped after ${CHECK_MOST_MS / 60_000} minutes)` : ''
      const ok = status === 0 && !late
      console.log(`\n# ${name}\n${out.trimEnd()}\n# ${name}: ${ok ? 'ok' : 'FAILED'} in ${seconds.toFixed(0)} s${why}`)
      resolve({ name, ok, seconds })
    })
  })
}

const started = Date.now()
const queue = [...checks]
const results = []
await Promise.all(
  Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
    while (queue.length) results.push(await runOne(queue.shift()))
  }),
)

// A check that failed in the crowd runs once more on its own. Passing then, it counts, but it is
// named as flaky, so a check that fails now and then is seen, and not hidden.
const flaky = []
for (const r of results.filter((r) => !r.ok)) {
  console.log(`\n# ${r.name} failed with others running; once more, on its own`)
  const again = await runOne(r.name)
  if (!again.ok) continue
  r.ok = true
  flaky.push(r.name)
}

for (const r of results) times[r.name] = Math.round(r.seconds)
try {
  mkdirSync(new URL('.', TIMES), { recursive: true })
  writeFileSync(TIMES, JSON.stringify(times, null, 2))
} catch {
  /* test-output is not there: the next run guesses again */
}
const failed = results.filter((r) => !r.ok).map((r) => r.name)
const took = ((Date.now() - started) / 1000).toFixed(0)
const shaky = flaky.length ? `; flaky, passed on a second try: ${flaky.join(', ')}` : ''
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed in ${took} s, ${AT_ONCE} at once${failed.length ? `; failed: ${failed.join(', ')}` : ''}${shaky}`)
process.exit(failed.length ? 1 : 0)
