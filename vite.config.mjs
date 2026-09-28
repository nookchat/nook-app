import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { defineConfig } from 'vite'

const WORKER = 'stream-sw.js'

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

export default defineConfig({
  // Relative, so the build works from any sub path on a static host.
  base: './',
  plugins: [keepTheApp()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
