interface VersionSpec {
  ecPerBlock: number
  /** [block count, data codewords per block] */
  g1: [number, number]
  g2?: [number, number]
}

// ISO/IEC 18004 Table 9, error correction level M, versions 1 to 10.
const SPECS: Record<number, VersionSpec> = {
  1: { ecPerBlock: 10, g1: [1, 16] },
  2: { ecPerBlock: 16, g1: [1, 28] },
  3: { ecPerBlock: 26, g1: [1, 44] },
  4: { ecPerBlock: 18, g1: [2, 32] },
  5: { ecPerBlock: 24, g1: [2, 43] },
  6: { ecPerBlock: 16, g1: [4, 27] },
  7: { ecPerBlock: 18, g1: [4, 31] },
  8: { ecPerBlock: 22, g1: [2, 38], g2: [2, 39] },
  9: { ecPerBlock: 22, g1: [3, 36], g2: [2, 37] },
  10: { ecPerBlock: 26, g1: [4, 43], g2: [1, 44] },
}

const ALIGNMENT_CENTRES: Record<number, number[]> = {
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

function remainderBits(version: number): number {
  return version >= 2 && version <= 6 ? 7 : 0
}

function darkModuleRow(version: number): number {
  return 4 * version + 9
}

// GF(256) with primitive polynomial 0x11d.

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

function generatorPoly(n: number): number[] {
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

function errorCorrection(data: number[], gen: number[]): number[] {
  const ecLength = gen.length - 1
  const buffer = new Array<number>(data.length + ecLength).fill(0)
  for (let i = 0; i < data.length; i++) buffer[i] = data[i]
  for (let i = 0; i < data.length; i++) {
    const factor = buffer[i]
    if (factor === 0) continue
    for (let j = 0; j < gen.length; j++) buffer[i + j] ^= mul(gen[j], factor)
  }
  return buffer.slice(data.length)
}

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

  const terminatorBits = Math.min(4, capacity * 8 - bits.length)
  push(0, terminatorBits)
  while (bits.length % 8 !== 0) bits.push(0)

  const words: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let word = 0
    for (let j = 0; j < 8; j++) word = (word << 1) | bits[i + j]
    words.push(word)
  }
  const PAD_BYTES = [0xec, 0x11]
  while (words.length < capacity) words.push(PAD_BYTES[(words.length - bits.length / 8) % 2])

  const gen = generatorPoly(spec.ecPerBlock)
  const blocks: number[][] = []
  const ecBlocks: number[][] = []
  let offset = 0
  const groups: [number, number][] = spec.g2 ? [spec.g1, spec.g2] : [spec.g1]
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = words.slice(offset, offset + size)
      offset += size
      blocks.push(block)
      ecBlocks.push(errorCorrection(block, gen))
    }
  }

  const result: number[] = []
  const longest = Math.max(...blocks.map((b) => b.length))
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) result.push(block[i])
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i])
  }
  return result
}

type Grid = boolean[][]

function blank(size: number): Grid {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
}

function placeFinder(matrix: Grid, reserved: Grid, row: number, col: number): void {
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
  const centres = ALIGNMENT_CENTRES[version]
  const size = matrix.length
  for (const row of centres) {
    for (const col of centres) {
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
  reserved[darkModuleRow(version)][8] = true
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
        matrix[row][col] = bits[index] === 1
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
  const flips = MASKS[mask]
  const out = matrix.map((row) => [...row])
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (!reserved[r][c] && flips(r, c)) out[r][c] = !out[r][c]
    }
  }
  return out
}

function formatBits(mask: number): number {
  const LEVEL_M = 0b00
  const data = (LEVEL_M << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

function placeFormat(matrix: Grid, mask: number, version: number): void {
  const size = matrix.length
  const bits = formatBits(mask)
  const bit = (i: number): boolean => ((bits >> i) & 1) === 1

  for (let i = 0; i <= 5; i++) matrix[i][8] = bit(i)
  matrix[7][8] = bit(6)
  matrix[8][8] = bit(7)
  matrix[8][7] = bit(8)
  for (let i = 9; i < 15; i++) matrix[8][14 - i] = bit(i)

  for (let i = 0; i < 8; i++) matrix[8][size - 1 - i] = bit(i)
  for (let i = 8; i < 15; i++) matrix[size - 15 + i][8] = bit(i)

  matrix[darkModuleRow(version)][8] = true
}

function runPenalty(size: number, get: (a: number, b: number) => boolean): number {
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

function sameColourBlockPenalty(matrix: Grid): number {
  const size = matrix.length
  let score = 0
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c]
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3
    }
  }
  return score
}

const FINDER_LIKE_A = [true, false, true, true, true, false, true, false, false, false, false]
const FINDER_LIKE_B = [false, false, false, false, true, false, true, true, true, false, true]

function matches(get: (i: number) => boolean, start: number, pattern: boolean[]): boolean {
  for (let i = 0; i < pattern.length; i++) if (get(start + i) !== pattern[i]) return false
  return true
}

function finderLikePenalty(matrix: Grid): number {
  const size = matrix.length
  let score = 0
  for (let r = 0; r < size; r++) {
    const across = (i: number): boolean => matrix[r][i]
    const down = (i: number): boolean => matrix[i][r]
    for (let c = 0; c + 11 <= size; c++) {
      if (matches(across, c, FINDER_LIKE_A) || matches(across, c, FINDER_LIKE_B)) score += 40
      if (matches(down, c, FINDER_LIKE_A) || matches(down, c, FINDER_LIKE_B)) score += 40
    }
  }
  return score
}

function darkBalancePenalty(matrix: Grid): number {
  const size = matrix.length
  let dark = 0
  for (const row of matrix) for (const v of row) if (v) dark++
  const percent = (dark * 100) / (size * size)
  return Math.floor(Math.abs(percent - 50) / 5) * 10
}

function penalty(matrix: Grid): number {
  const size = matrix.length
  return (
    runPenalty(size, (r, c) => matrix[r][c]) +
    runPenalty(size, (c, r) => matrix[r][c]) +
    sameColourBlockPenalty(matrix) +
    finderLikePenalty(matrix) +
    darkBalancePenalty(matrix)
  )
}

/** True means a dark module. */
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

interface QrOptions {
  quietZone?: number
  pixels?: number
}

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
  svg.setAttribute('aria-label', 'QR code of the link')
  svg.setAttribute('shape-rendering', 'crispEdges')

  const background = document.createElementNS(ns, 'rect')
  background.setAttribute('width', String(span))
  background.setAttribute('height', String(span))
  background.setAttribute('fill', '#ffffff')
  svg.append(background)

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
