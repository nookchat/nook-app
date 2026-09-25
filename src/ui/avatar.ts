import { MAX_AVATAR } from '../store/log'
import { memoryPref, setMemoryPref } from '../store/prefs'

const KEY = 'cathode.avatar.v1'

// Avatars are drawn at 44px at most.
const THUMB_SIDE = 48

export function loadAvatar(): string {
  return memoryPref(KEY) ?? ''
}

export function avatarKnown(): boolean {
  return memoryPref(KEY) !== undefined
}

export function saveAvatar(picture: string): void {
  setMemoryPref(KEY, picture || null)
}

export async function squareThumb(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That is not a picture.')
  const bitmap = await loadBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = THUMB_SIDE
  canvas.height = THUMB_SIDE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser will not draw the picture.')

  const crop = Math.min(bitmap.width, bitmap.height)
  ctx.drawImage(
    bitmap,
    (bitmap.width - crop) / 2,
    (bitmap.height - crop) / 2,
    crop,
    crop,
    0,
    0,
    THUMB_SIDE,
    THUMB_SIDE,
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
