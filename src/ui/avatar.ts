/**
 * A picture of you, small enough to travel inside one signed event.
 *
 * It is the picture itself, carried in the profile event next to the name in
 * every space, and an event has a size limit that every device enforces. So
 * the picture is shrunk here, on the way in, until it fits with room to spare:
 * a square thumbnail, WebP where the browser has it, JPEG where it does not.
 *
 * Yours is kept in your record on your servers, sealed, and in this page's
 * memory while it is open, not in the browser. See store/prefs.ts.
 */

import { MAX_AVATAR } from '../store/log'
import { memoryPref, setMemoryPref } from '../store/prefs'

const KEY = 'cathode.avatar.v1'

/** How wide the thumbnail is. Drawn at 44 pixels at the most, so this is plenty. */
const SIDE = 48

/** Your picture, from your record on the server, or empty when there is none or it has not arrived yet. */
export function loadAvatar(): string {
  return memoryPref(KEY) ?? ''
}

/** Whether your picture is known yet: arrived from your record, or set here. */
export function avatarKnown(): boolean {
  return memoryPref(KEY) !== undefined
}

/** Your picture, kept in your record on your servers. See store/prefs.ts. */
export function saveAvatar(picture: string): void {
  setMemoryPref(KEY, picture || null)
}

/**
 * Take whatever was chosen and give back a small square data URI.
 *
 * Cropped to the middle rather than squashed, because a squashed face is worse
 * than a cropped one. The quality is stepped down until it fits the limit, and
 * if it still does not fit at the bottom of the range it is refused with a
 * sentence rather than written and silently dropped by everybody's validator.
 */
export async function squareThumb(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That is not a picture.')
  const bitmap = await loadBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = SIDE
  canvas.height = SIDE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser will not draw the picture.')

  const side = Math.min(bitmap.width, bitmap.height)
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIDE,
    SIDE,
  )
  if ('close' in bitmap) bitmap.close()

  for (const type of ['image/webp', 'image/jpeg']) {
    for (const quality of [0.7, 0.55, 0.4, 0.3]) {
      const url = canvas.toDataURL(type, quality)
      // A browser without WebP hands back a PNG, which is far too big here.
      if (!url.startsWith(`data:${type}`)) break
      if (url.length <= MAX_AVATAR) return url
    }
  }
  throw new Error('That picture will not shrink small enough. Try a simpler one.')
}

function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file)
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('That picture could not be read.'))
    }
    img.src = url
  })
}
