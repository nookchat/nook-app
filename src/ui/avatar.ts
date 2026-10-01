import { MAX_AVATAR, MAX_COVER } from '../store/log'
import { adoptMemoryPref, memoryPref, memoryPrefStamp, setMemoryPref } from '../store/prefs'

const KEY = 'nook.avatar.v1'
const COVER_KEY = 'nook.cover.v1'

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

export function loadCover(): string {
  return memoryPref(COVER_KEY) ?? ''
}

export function coverKnown(): boolean {
  return memoryPref(COVER_KEY) !== undefined
}

export function saveCover(picture: string): void {
  setMemoryPref(COVER_KEY, picture || null)
}

export function coverSavedAt(): number {
  return memoryPrefStamp(COVER_KEY)
}

export function adoptCover(picture: string, at: number): void {
  adoptMemoryPref(COVER_KEY, picture || null, at)
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

  return shrink(canvas, most)
}

/** The cover's shape: a wide strip, the same as the band at the top of a profile card. */
const COVER_W = 480
const COVER_H = 108

/** The part of the picture that fills a 480 x 108 strip, cut from its middle. */
export async function coverThumb(file: File, most = MAX_COVER): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That is not a picture.')
  const bitmap = await loadBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = COVER_W
  canvas.height = COVER_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser will not draw the picture.')

  const fit = Math.max(COVER_W / bitmap.width, COVER_H / bitmap.height)
  const w = COVER_W / fit
  const h = COVER_H / fit
  ctx.drawImage(bitmap, (bitmap.width - w) / 2, (bitmap.height - h) / 2, w, h, 0, 0, COVER_W, COVER_H)
  if ('close' in bitmap) bitmap.close()
  return shrink(canvas, most)
}

function shrink(canvas: HTMLCanvasElement, most: number): string {
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
