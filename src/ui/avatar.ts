import { MAX_AVATAR } from '../store/log'
import { adoptMemoryPref, memoryPref, memoryPrefStamp, setMemoryPref } from '../store/prefs'

const KEY = 'nook.avatar.v1'

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

export function avatarSavedAt(): number {
  return memoryPrefStamp(KEY)
}

export function adoptAvatar(picture: string, at: number): void {
  adoptMemoryPref(KEY, picture || null, at)
}

export async function squareThumb(file: File, side = THUMB_SIDE, most = MAX_AVATAR): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That is not a picture.')
  const bitmap = await loadBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
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
    side,
    side,
  )
  if ('close' in bitmap) bitmap.close()

  for (const quality of [0.7, 0.55, 0.4, 0.3]) {
    const url = canvas.toDataURL('image/webp', quality)
    // A browser without WebP hands back a PNG instead.
    if (!url.startsWith('data:image/webp')) break
    if (url.length <= most) return url
  }
  // WebP and PNG keep a clear background clear. JPEG has none, so it is the last try.
  const png = canvas.toDataURL('image/png')
  if (png.length <= most) return png
  for (const quality of [0.7, 0.55, 0.4, 0.3]) {
    const url = canvas.toDataURL('image/jpeg', quality)
    if (url.length <= most) return url
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
