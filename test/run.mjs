import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const dir = new URL('.', import.meta.url).pathname
const CHECK_MOST_MS = 5 * 60 * 1000
const wanted = process.argv.slice(2)
const checks = readdirSync(dir)
  .filter((file) => file.endsWith('.test.mjs'))
  .map((file) => file.slice(0, -'.test.mjs'.length))
  .filter((name) => wanted.length === 0 || wanted.includes(name))

const failed = []
for (const name of checks) {
  console.log(`\n# ${name}`)
  const started = Date.now()
  // One check that hangs must not hold up the rest.
  const { status, error } = spawnSync(process.execPath, [`${dir}${name}.test.mjs`], { stdio: 'inherit', timeout: CHECK_MOST_MS })
  const why = error?.code === 'ETIMEDOUT' ? ` (stopped after ${CHECK_MOST_MS / 60_000} minutes)` : ''
  console.log(`# ${name}: ${status === 0 ? 'ok' : 'FAILED'} in ${((Date.now() - started) / 1000).toFixed(0)} s${why}`)
  if (status !== 0) failed.push(name)
}

console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
