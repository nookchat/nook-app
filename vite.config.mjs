import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { defineConfig } from 'vite'

const WORKER = 'stream-sw.js'
/** Fetched when a page shows them, not kept by the worker: there are thousands. */
const EMOJI_DIR = 'emoji'
// Twemoji 17 from its GitHub release (npm has no newer SVG package than 15).
const EMOJI_ART = join(dirname(createRequire(import.meta.url).resolve('twemoji-art/package.json')), 'assets', 'svg')
const EMOJI_NAMES = 'virtual:twemoji'

/** @param {string} dir @returns {string[]} */
function filesIn(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesIn(path) : [path]
  })
}

/**
 * Writes the version and every file of the build into the service worker, so
 * it keeps the whole app and a new build is a new worker the browser sees.
 */
/** @returns {import('vite').Plugin} */
function keepTheApp() {
  let outDir = 'dist'
  return {
    name: 'nook-keep-the-app',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const files = filesIn(outDir)
        .map((path) => relative(outDir, path).split(sep).join('/'))
        .filter((file) => file !== WORKER && file !== 'index.html' && !file.endsWith('.map'))
        .filter((file) => !file.startsWith(`${EMOJI_DIR}/`))
        .sort()
      const hash = createHash('sha256')
      for (const file of ['index.html', ...files]) hash.update(file).update(readFileSync(join(outDir, file)))
      const app = { version: hash.digest('hex').slice(0, 12), files: ['./', ...files] }
      const worker = join(outDir, WORKER)
      const source = readFileSync(worker, 'utf8')
      if (!source.includes('const APP = null')) throw new Error(`${WORKER} has no "const APP = null" to fill in.`)
      writeFileSync(worker, source.replace('const APP = null', `const APP = ${JSON.stringify(app)}`))
      console.log(`[nook] the service worker keeps ${app.files.length} files, version ${app.version}`)
    },
  }
}

/**
 * The Twemoji pictures, so an emoji looks the same on every device. The page gets
 * the list of names, and asks only for a picture that exists.
 */
/** @returns {import('vite').Plugin} */
function emojiArt() {
  const names = readdirSync(EMOJI_ART)
    .filter((file) => file.endsWith('.svg'))
    .map((file) => file.slice(0, -4))
    .sort()
  const known = new Set(names)
  return {
    name: 'nook-emoji-art',
    resolveId(id) {
      return id === EMOJI_NAMES ? `\0${EMOJI_NAMES}` : null
    },
    load(id) {
      return id === `\0${EMOJI_NAMES}` ? `export default ${JSON.stringify(names.join(','))}` : null
    },
    configureServer(server) {
      server.middlewares.use(`/${EMOJI_DIR}/`, (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, '').replace(/\.svg$/, ''))
        if (!known.has(name)) return next()
        res.setHeader('Content-Type', 'image/svg+xml')
        res.end(readFileSync(join(EMOJI_ART, `${name}.svg`)))
      })
    },
    generateBundle() {
      for (const name of names) {
        this.emitFile({
          type: 'asset',
          fileName: `${EMOJI_DIR}/${name}.svg`,
          source: readFileSync(join(EMOJI_ART, `${name}.svg`)),
        })
      }
    },
  }
}

/** The commit this is built from, for the About page. Vercel says it; a local build asks git. */
function commit() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA
  if (sha) return sha.slice(0, 7)
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export default defineConfig({
  // Relative, so the build works from any sub path on a static host.
  base: './',
  plugins: [emojiArt(), keepTheApp()],
  define: {
    __NOOK_VERSION__: JSON.stringify(VERSION),
    __NOOK_COMMIT__: JSON.stringify(commit()),
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
