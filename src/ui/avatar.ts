/**
 * A picture of you, small enough to travel inside one signed event.
 *
 * There is nowhere to upload anything to, which is the whole design, so an
 * avatar cannot be a link to a file on a server. It is the picture itself,
 * carried in the profile event next to the name, and an event has a size limit
 * that every device enforces. So the picture is shrunk here, on the way in,
 * until it fits with room to spare: a square thumbnail, WebP where the browser
 * has it, JPEG where it does not.
 *
 * Kept on this device as well as in the log, so settings can show it before any
 * space is open.
 */

import { MAX_AVATAR } from '../store/log'

const KEY = 'cathode.avatar.v1'

/** How wide the thumbnail is. Drawn at 44 pixels at the most, so this is plenty. */
const SIDE = 48

export function loadAvatar(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveAvatar(picture: string): void {
  try {
    if (picture) localStorage.setItem(KEY, picture)
    else localStorage.removeItem(KEY)
  } catch {
    /* the picture lasts for this session only */
  }
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
