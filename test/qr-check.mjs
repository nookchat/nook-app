/**
 * Proves the QR encoder is right, by reading its output back.
 *
 * Chrome ships a QR decoder as BarcodeDetector. This renders each code to a
 * canvas and asks Chrome to read it. A code that does not decode is a bug, not
 * a matter of taste.
 *
 *   node test/qr-check.mjs
 */

import { chromium } from 'playwright-core'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Lengths that sit either side of every version boundary at level M. */
const BOUNDARIES = [14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106, 107, 122, 123, 152, 153, 180, 181, 213]

const CASES = [
  'https://cathode.video/#r=UAeg19hayK8wUFSO2oqEWg',
  'https://cathode.video/#r=' + 'A'.repeat(22),
  'http://localhost:5173/#r=hnyiWMSfZ61Cj4V9uGjdlQ',
  'https://a-rather-long-project-name.pages.dev/cathode/#r=xCQwtNoYKsbeF2AfcVPVNA',
  'x',
  'https://example.com/#r=' + 'A'.repeat(40),
  ...BOUNDARIES.map((n) => 'L'.repeat(n)),
]

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await (await browser.newContext()).newPage()
await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })

const results = await page.evaluate(async (cases) => {
  const { qrMatrix } = await import('/src/ui/qr.ts')
  const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
  const out = []

  for (const text of cases) {
    try {
      const matrix = qrMatrix(text)
      const size = matrix.length
      const quiet = 4
      const scale = 6
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = (size + quiet * 2) * scale
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#000'
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (matrix[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale)
        }
      }
      const found = await detector.detect(canvas)
      out.push({
        text,
        version: (size - 17) / 4,
        modules: size,
        decoded: found[0]?.rawValue ?? null,
        ok: found[0]?.rawValue === text,
      })
    } catch (err) {
      out.push({ text, ok: false, decoded: null, error: String(err) })
    }
  }
  return out
}, CASES)

let failed = 0
for (const r of results) {
  const label = r.text.length > 46 ? `${r.text.slice(0, 43)}...` : r.text
  if (r.ok) {
    console.log(`PASS  v${String(r.version).padStart(2)} ${String(r.modules).padStart(2)}x  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}\n      decoded: ${r.decoded ?? r.error ?? 'nothing'}`)
  }
}

console.log(`\n${results.length - failed} of ${results.length} codes decoded correctly.`)
await browser.close()
process.exit(failed === 0 ? 1 * 0 || 0 : 1)
