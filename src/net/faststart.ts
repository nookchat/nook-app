/**
 * Moves an MP4's index (the moov box) in front of its media (the mdat box), as
 * qt-faststart does. A phone or a screen recorder often writes the index last,
 * so a player has to fetch the end of the file before it can show a frame.
 * With the index first, it plays from the first pieces that arrive.
 *
 * Only the index is read into memory; the media is sliced from the file as it is.
 * Anything this does not understand comes back unchanged.
 */

interface Box {
  type: string
  start: number
  size: number
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])
const MAX_INDEX_BYTES = 64 * 1024 * 1024

async function topBoxes(file: Blob): Promise<Box[] | null> {
  const out: Box[] = []
  let at = 0
  while (at < file.size) {
    const head = new DataView(await file.slice(at, at + 16).arrayBuffer())
    if (head.byteLength < 8) return null
    let size = head.getUint32(0)
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7))
    if (size === 1) {
      if (head.byteLength < 16) return null
      size = Number(head.getBigUint64(8))
    } else if (size === 0) {
      size = file.size - at
    }
    if (size < 8 || at + size > file.size) return null
    out.push({ type, start: at, size })
    at += size
  }
  return out
}

/** Adds `shift` to every chunk offset in the index. False when an offset would not fit. */
function shiftOffsets(view: DataView, from: number, to: number, shift: number): boolean {
  let at = from
  while (at + 8 <= to) {
    let size = view.getUint32(at)
    const type = String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7))
    let body = at + 8
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8))
      body = at + 16
    } else if (size === 0) {
      size = to - at
    }
    if (size < 8 || at + size > to) return false
    if (CONTAINERS.has(type)) {
      if (!shiftOffsets(view, body, at + size, shift)) return false
    } else if (type === 'stco') {
      const count = view.getUint32(body + 4)
      if (body + 8 + count * 4 > at + size) return false
      for (let i = 0; i < count; i++) {
        const spot = body + 8 + i * 4
        const moved = view.getUint32(spot) + shift
        if (moved > 0xffffffff) return false
        view.setUint32(spot, moved)
      }
    } else if (type === 'co64') {
      const count = view.getUint32(body + 4)
      if (body + 8 + count * 8 > at + size) return false
      for (let i = 0; i < count; i++) {
        const spot = body + 8 + i * 8
        view.setBigUint64(spot, view.getBigUint64(spot) + BigInt(shift))
      }
    }
    at += size
  }
  return true
}

export async function faststart(file: File): Promise<File> {
  try {
    const boxes = await topBoxes(file)
    if (!boxes) return file
    const moovAt = boxes.findIndex((b) => b.type === 'moov')
    const mdatAt = boxes.findIndex((b) => b.type === 'mdat')
    // Already first, or fragmented, which plays as it arrives anyway.
    if (moovAt < 0 || mdatAt < 0 || moovAt < mdatAt || boxes.some((b) => b.type === 'moof')) return file
    const moov = boxes[moovAt]
    if (moov.size > MAX_INDEX_BYTES) return file

    const index = await file.slice(moov.start, moov.start + moov.size).arrayBuffer()
    const view = new DataView(index)
    const headBytes = view.getUint32(0) === 1 ? 16 : 8
    // Everything from the first mdat to the old index moves down by the size of the index.
    if (!shiftOffsets(view, headBytes, index.byteLength, moov.size)) return file

    const parts: BlobPart[] = []
    boxes.forEach((box, i) => {
      if (i === moovAt) return
      if (i === mdatAt) parts.push(index)
      parts.push(file.slice(box.start, box.start + box.size))
    })
    return new File(parts, file.name, { type: file.type, lastModified: file.lastModified })
  } catch {
    return file
  }
}
