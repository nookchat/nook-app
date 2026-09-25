import { APP_URL, check, finish, launch, stoppedEarly } from './harness.mjs'

// Lengths that sit either side of every version boundary at level M.
const BOUNDARIES = [14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106, 107, 122, 123, 152, 153, 180, 181, 213]

const CASES = [
  'https://nook.video/#K7M2X-9QPT4-VB2WN-P8ZQ3-MHRF6',
  'https://nook.video/#' + 'ABCDE-'.repeat(4) + 'ABCDE',
  'http://localhost:5173/#K7M2X-9QPT4-VB2WN-P8ZQ3-MHRF6',
  'https://a-rather-long-project-name.pages.dev/nook/#K7M2X-9QPT4-VB2WN-P8ZQ3-MHRF6',
  'x',
  'https://example.com/#' + 'A'.repeat(40),
  ...BOUNDARIES.map((n) => 'L'.repeat(n)),
]

const browser = await launch({ headless: true })
try {
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

  for (const r of results) {
    const label = r.text.length > 46 ? `${r.text.slice(0, 43)}...` : r.text
    if (r.ok) check(`v${String(r.version).padStart(2)} ${String(r.modules).padStart(2)}x  ${label}`, true)
    else check(label, false, `decoded: ${r.decoded ?? r.error ?? 'nothing'}`)
  }
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
}

finish()
