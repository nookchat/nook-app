import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { defineConfig } from 'vite'

const WORKER = 'stream-sw.js'
/** The app's own code, as against a library's. */
const SOURCE = new URL('./src/', import.meta.url).pathname
/** Fetched when a page shows them, not kept by the worker: there are thousands. */
const EMOJI_DIR = 'emoji'
// Twemoji 17 from its GitHub release (npm has no newer SVG package than 15).
const EMOJI_ART = join(dirname(createRequire(import.meta.url).resolve('twemoji-art/package.json')), 'assets', 'svg')
const EMOJI_NAMES = 'virtual:twemoji'
/** tldraw's fonts, icons and words, for the whiteboards. Fetched when a board shows them, not kept by the worker. */
const BOARD_ASSETS_DIR = 'tldraw'
const BOARD_ASSET_KINDS = ['fonts', 'icons', 'translations', 'embed-icons']
// The package lists no package.json in its exports, so its folder is found by name.
const BOARD_ASSETS = new URL('./node_modules/@tldraw/assets', import.meta.url).pathname

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
  /**
   * Code that only a library loads when it wants it, such as a diagram tool or a language
   * languages. The worker leaves it out: it is megabytes, and most people never use it.
   */
  const extras = new Set()
  return {
    name: 'nook-keep-the-app',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    generateBundle(_, bundle) {
      const chunks = Object.values(bundle).filter((file) => file.type === 'chunk')
      const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
      const chunkOf = new Map(chunks.flatMap((chunk) => chunk.moduleIds.map((id) => [id, chunk.fileName])))
      const ours = (id) => id.startsWith(SOURCE)
      const needed = new Set()
      const need = (name) => {
        const chunk = byName.get(name)
        if (!chunk || needed.has(name)) return
        needed.add(name)
        for (const css of chunk.viteMetadata?.importedCss ?? []) needed.add(css)
        for (const next of chunk.imports) need(next)
        // What the app's own code loads later, such as the whiteboards, is kept too. A chunk can
        // hold a library beside the app's code, so this asks each module, not the chunk.
        for (const id of chunk.moduleIds.filter(ours)) {
          for (const later of this.getModuleInfo(id)?.dynamicallyImportedIds ?? []) need(chunkOf.get(later))
        }
      }
      for (const chunk of chunks) if (chunk.isEntry) need(chunk.fileName)
      for (const chunk of chunks) {
        if (needed.has(chunk.fileName)) continue
        extras.add(chunk.fileName)
        for (const css of chunk.viteMetadata?.importedCss ?? []) if (!needed.has(css)) extras.add(css)
      }
    },
    closeBundle() {
      const files = filesIn(outDir)
        .map((path) => relative(outDir, path).split(sep).join('/'))
        .filter((file) => file !== WORKER && file !== 'index.html' && !file.endsWith('.map'))
        .filter((file) => !file.startsWith(`${EMOJI_DIR}/`) && !file.startsWith(`${BOARD_ASSETS_DIR}/`) && !extras.has(file))
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

/**
 * tldraw's fonts, icons and words next to the app, so a whiteboard asks no other site for them.
 * The page points tldraw here (src/ui/whiteboard-canvas.ts).
 */
/** @returns {import('vite').Plugin} */
function boardAssets() {
  const files = BOARD_ASSET_KINDS.flatMap((kind) => filesIn(join(BOARD_ASSETS, kind)))
  const known = new Set(files.map((path) => relative(BOARD_ASSETS, path).split(sep).join('/')))
  const TYPES = { woff2: 'font/woff2', svg: 'image/svg+xml', json: 'application/json', png: 'image/png' }
  return {
    name: 'nook-board-assets',
    configureServer(server) {
      server.middlewares.use(`/${BOARD_ASSETS_DIR}/`, (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''))
        if (!known.has(name)) return next()
        res.setHeader('Content-Type', TYPES[name.split('.').pop()] ?? 'application/octet-stream')
        res.end(readFileSync(join(BOARD_ASSETS, name)))
      })
    },
    generateBundle() {
      for (const name of known) {
        this.emitFile({ type: 'asset', fileName: `${BOARD_ASSETS_DIR}/${name}`, source: readFileSync(join(BOARD_ASSETS, name)) })
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
  plugins: [emojiArt(), boardAssets(), keepTheApp()],
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
