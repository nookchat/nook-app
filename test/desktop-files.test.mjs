import { readdirSync, readFileSync } from 'node:fs'
import { check, finish } from './harness.mjs'

// The desktop app is packed from the files its package.json names. A module the app requires
// and the list leaves out is missing in every release, and the app stops as it starts.
const dir = new URL('../desktop/', import.meta.url)
const { build } = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'))
const globs = build.files.map((pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.+').replace(/\*/g, '[^/]*')}$`))
const packed = (file) => globs.some((glob) => glob.test(file))

const needed = new Set([build.main ?? JSON.parse(readFileSync(new URL('package.json', dir), 'utf8')).main])
for (const file of readdirSync(dir).filter((f) => f.endsWith('.cjs'))) {
  const text = readFileSync(new URL(file, dir), 'utf8')
  for (const hit of text.matchAll(/require\('\.\/([^']+)'\)/g)) needed.add(hit[1])
  for (const hit of text.matchAll(/path\.join\(__dirname, '([^']+)'\)/g)) needed.add(hit[1])
}
needed.delete(undefined)
const missing = [...needed].filter((file) => !packed(file))
check('every file the desktop app loads is packed into it', missing.length === 0, missing.join(', ') || [...needed].join(', '))

finish()
