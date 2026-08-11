/**
 * A QR encoder, byte mode, error correction level M, versions 1 to 10.
 *
 * Cathode needs one QR code, for one short link, and a library would cost more
 * than the code below. Ten versions carry 213 bytes, which is far more than any
 * Cathode link.
 *
 * Correctness here is not a matter of opinion: the end to end test renders the
 * output and reads it back with the QR decoder built into Chrome. Look for
 * "the QR code decodes back to the link" in test/e2e.mjs.
 *
 * Level M recovers from about 15 percent damage, which is the usual choice for
 * a screen, and it keeps the code small enough to scan from a laptop display.
 */

interface VersionSpec {
  /** Data plus error correction codewords in the whole symbol. */
  total: number
  /** Error correction codewords per block. */
  ec: number
  /** [block count, data codewords per block] */
  g1: [number, number]
  g2?: [number, number]
}

const SPECS: Record<number, VersionSpec> = {
  1: { total: 26, ec: 10, g1: [1, 16] },
  2: { total: 44, ec: 16, g1: [1, 28] },
  3: { total: 70, ec: 26, g1: [1, 44] },
  4: { total: 100, ec: 18, g1: [2, 32] },
  5: { total: 134, ec: 24, g1: [2, 43] },
  6: { total: 172, ec: 16, g1: [4, 27] },
  7: { total: 196, ec: 18, g1: [4, 31] },
  8: { total: 242, ec: 22, g1: [2, 38], g2: [2, 39] },
  9: { total: 292, ec: 22, g1: [3, 36], g2: [2, 37] },
  10: { total: 346, ec: 26, g1: [4, 43], g2: [1, 44] },
}

/** Centre coordinates of the alignment patterns, by version. */
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
}

/** Bits left over after the codewords, by version. */
function remainderBits(version: number): number {
  return version >= 2 && version <= 6 ? 7 : 0
}

// ---------------------------------------------------------------------------
// Arithmetic over GF(256), primitive polynomial 0x11d
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/** The generator polynomial for n error correction codewords. */
function generator(n: number): number[] {
  let poly = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= mul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

function errorCorrection(data: number[], ecLength: number): number[] {
  const gen = generator(ecLength)
  const buffer = new Array<number>(data.length + ecLength).fill(0)
  for (let i = 0; i < data.length; i++) buffer[i] = data[i]
  for (let i = 0; i < data.length; i++) {
    const factor = buffer[i]
    if (factor === 0) continue
    for (let j = 0; j < gen.length; j++) buffer[i + j] ^= mul(gen[j], factor)
  }
  return buffer.slice(data.length)
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function dataCodewords(spec: VersionSpec): number {
  return spec.g1[0] * spec.g1[1] + (spec.g2 ? spec.g2[0] * spec.g2[1] : 0)
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= 10; version++) {
    const spec = SPECS[version]
    const countBits = version < 10 ? 8 : 16
    if (4 + countBits + byteLength * 8 <= dataCodewords(spec) * 8) return version
  }
  throw new Error('This text is too long for a QR code.')
}

function buildCodewords(bytes: Uint8Array, version: number): number[] {
  const spec = SPECS[version]
  const capacity = dataCodewords(spec)
  const countBits = version < 10 ? 8 : 16

  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }

  push(0b0100, 4) // byte mode
  push(bytes.length, countBits)
  for (const b of bytes) push(b, 8)

  // Terminator, then pad to a whole byte.
  const room = capacity * 8 - bits.length
  push(0, Math.min(4, room))
  while (bits.length % 8 !== 0) bits.push(0)

  const words: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let word = 0
    for (let j = 0; j < 8; j++) word = (word << 1) | bits[i + j]
    words.push(word)
  }
  // The standard pad bytes, alternating, until the block is full.
  const PADS = [0xec, 0x11]
  while (words.length < capacity) words.push(PADS[(words.length - bits.length / 8) % 2])

  // Split into blocks, compute error correction, then interleave.
  const blocks: number[][] = []
  const ecBlocks: number[][] = []
  let offset = 0
  const groups: [number, number][] = spec.g2 ? [spec.g1, spec.g2] : [spec.g1]
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = words.slice(offset, offset + size)
      offset += size
      blocks.push(block)
      ecBlocks.push(errorCorrection(block, spec.ec))
    }
  }

  const result: number[] = []
  const longest = Math.max(...blocks.map((b) => b.length))
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) result.push(block[i])
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const block of ecBlocks) result.push(block[i])
  }
  return result
}

// ---------------------------------------------------------------------------
// The symbol
// ---------------------------------------------------------------------------

type Grid = boolean[][]

function blank(size: number): Grid {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
}

function placeFinder(matrix: Grid, reserved: Grid, row: number, col: number): void {
  // The 7x7 eye plus its one module separator, clipped at the symbol edge.
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const y = row + r
      const x = col + c
      if (y < 0 || x < 0 || y >= matrix.length || x >= matrix.length) continue
      const onRing = r === 0 || r === 6 || c === 0 || c === 6
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6
      matrix[y][x] = inside && (onRing || inCore)
      reserved[y][x] = true
    }
  }
}

function placeAlignment(matrix: Grid, reserved: Grid, version: number): void {
  const centres = ALIGNMENT[version]
  const size = matrix.length
  for (const row of centres) {
    for (const col of centres) {
      // The three finder corners already own these spots.
      const nearFinder =
        (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8)
      if (nearFinder) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          matrix[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1
          reserved[row + r][col + c] = true
        }
      }
    }
  }
}

function placeTiming(matrix: Grid, reserved: Grid): void {
  const size = matrix.length
  for (let i = 8; i < size - 8; i++) {
    const on = i % 2 === 0
    matrix[6][i] = on
    matrix[i][6] = on
    reserved[6][i] = true
    reserved[i][6] = true
  }
}

/**
 * Version 7 and above carry an 18 bit version block twice, beside the top right
 * and bottom left eyes. It is a function pattern, so it is written before the
 * mask and never masked.
 */
function placeVersion(matrix: Grid, reserved: Grid, version: number): void {
  if (version < 7) return
  const size = matrix.length
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = (version << 12) | rem

  for (let i = 0; i < 18; i++) {
    const bit = ((bits >> i) & 1) === 1
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    matrix[b][a] = bit
    matrix[a][b] = bit
    reserved[b][a] = true
    reserved[a][b] = true
  }
}

function reserveFormat(reserved: Grid, version: number): void {
  const size = reserved.length
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = true
    reserved[i][8] = true
  }
  for (let i = 0; i < 8; i++) {
    reserved[size - 1 - i][8] = true
    reserved[8][size - 1 - i] = true
  }
  // The one module that is always dark.
  reserved[4 * version + 9][8] = true
}

function placeData(matrix: Grid, reserved: Grid, codewords: number[], version: number): void {
  const size = matrix.length
  const bits: number[] = []
  for (const word of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((word >> i) & 1)
  }
  for (let i = 0; i < remainderBits(version); i++) bits.push(0)

  let index = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // the vertical timing line is not a data column
    for (let step = 0; step < size; step++) {
      for (let lane = 0; lane < 2; lane++) {
        const col = right - lane
        const row = upward ? size - 1 - step : step
        if (reserved[row][col]) continue
        matrix[row][col] = index < bits.length ? bits[index] === 1 : false
        index++
      }
    }
    upward = !upward
  }
}

const MASKS: ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

function applyMask(matrix: Grid, reserved: Grid, mask: number): Grid {
  const out = matrix.map((row) => [...row])
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (!reserved[r][c] && MASKS[mask](r, c)) out[r][c] = !out[r][c]
    }
  }
  return out
}

/** The 15 format bits: two error correction bits, three mask bits, BCH, then a fixed XOR. */
function formatBits(mask: number): number {
  const ecBits = 0b00 // level M
  const data = (ecBits << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

function placeFormat(matrix: Grid, mask: number, version: number): void {
  const size = matrix.length
  const bits = formatBits(mask)
  const bit = (i: number): boolean => ((bits >> i) & 1) === 1

  // The first copy wraps the top left eye: down column 8, then left along row 8.
  for (let i = 0; i <= 5; i++) matrix[i][8] = bit(i)
  matrix[7][8] = bit(6)
  matrix[8][8] = bit(7)
  matrix[8][7] = bit(8)
  for (let i = 9; i < 15; i++) matrix[8][14 - i] = bit(i)

  // The second copy runs along row 8 on the right, then down column 8 at the bottom.
  for (let i = 0; i < 8; i++) matrix[8][size - 1 - i] = bit(i)
  for (let i = 8; i < 15; i++) matrix[size - 15 + i][8] = bit(i)

  matrix[4 * version + 9][8] = true
}

function penalty(matrix: Grid): number {
  const size = matrix.length
  let score = 0

  // Rule 1: runs of five or more of one colour.
  const runScore = (get: (a: number, b: number) => boolean): number => {
    let total = 0
    for (let a = 0; a < size; a++) {
      let run = 1
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) run++
        else {
          if (run >= 5) total += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) total += 3 + (run - 5)
    }
    return total
  }
  score += runScore((r, c) => matrix[r][c])
  score += runScore((c, r) => matrix[r][c])

  // Rule 2: any two by two block of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c]
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3
    }
  }

  // Rule 3: the finder-like pattern, in either direction.
  const A = [true, false, true, true, true, false, true, false, false, false, false]
  const B = [false, false, false, false, true, false, true, true, true, false, true]
  const matches = (get: (i: number) => boolean, start: number, pattern: boolean[]): boolean => {
    for (let i = 0; i < pattern.length; i++) if (get(start + i) !== pattern[i]) return false
    return true
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c + 11 <= size; c++) {
      if (matches((i) => matrix[r][i], c, A) || matches((i) => matrix[r][i], c, B)) score += 40
      if (matches((i) => matrix[i][r], c, A) || matches((i) => matrix[i][r], c, B)) score += 40
    }
  }

  // Rule 4: how far the dark share sits from one half.
  let dark = 0
  for (const row of matrix) for (const v of row) if (v) dark++
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10

  return score
}

/** The finished module grid. True means a dark module. */
export function qrMatrix(text: string): Grid {
  const bytes = new TextEncoder().encode(text)
  const version = chooseVersion(bytes.length)
  const size = 17 + version * 4

  const base = blank(size)
  const reserved = blank(size)
  placeFinder(base, reserved, 0, 0)
  placeFinder(base, reserved, 0, size - 7)
  placeFinder(base, reserved, size - 7, 0)
  placeAlignment(base, reserved, version)
  placeTiming(base, reserved)
  placeVersion(base, reserved, version)
  reserveFormat(reserved, version)
  placeData(base, reserved, buildCodewords(bytes, version), version)

  let best: Grid | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(base, reserved, mask)
    placeFormat(candidate, mask, version)
    const score = penalty(candidate)
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best!
}

export interface QrOptions {
  /** Modules of clear space on every side. Four is the standard minimum. */
  quietZone?: number
  /** Pixel size of the rendered square. */
  pixels?: number
}

/**
 * An SVG element holding the code.
 *
 * A QR code is always dark on light, in either theme. A scanner needs the
 * contrast in that direction, so this never follows the page colours.
 */
export function qrSvg(text: string, options: QrOptions = {}): SVGSVGElement {
  const quiet = options.quietZone ?? 4
  const pixels = options.pixels ?? 240
  const matrix = qrMatrix(text)
  const size = matrix.length
  const span = size + quiet * 2

  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${span} ${span}`)
  svg.setAttribute('width', String(pixels))
  svg.setAttribute('height', String(pixels))
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'A QR code holding the link to this stream')
  svg.setAttribute('shape-rendering', 'crispEdges')

  const background = document.createElementNS(ns, 'rect')
  background.setAttribute('width', String(span))
  background.setAttribute('height', String(span))
  background.setAttribute('fill', '#ffffff')
  svg.append(background)

  // One path for every dark module keeps the element count low.
  let d = ''
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`
    }
  }
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', d)
  path.setAttribute('fill', '#000000')
  svg.append(path)

  return svg
}
