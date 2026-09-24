/**
 * Files, sealed on the way up and opened on the way down.
 *
 * Each file gets a key of its own, made here, and is encrypted with it before
 * a byte leaves the device: twelve bytes of IV, then AES-GCM. The key goes in
 * the message that carries the file, which is sealed with the space's key, so
 * the server keeps a blob it cannot open under a name (the hash of the blob)
 * that says nothing. Somebody who can read the message can fetch and open the
 * file; nobody else can do either.
 *
 * A picture or a video is looked at before it goes, for its size and a tiny
 * blurred likeness, so it can be given its space on everybody's screen before
 * any of it has arrived. A video's first frame is sealed and sent as a file of
 * its own, with the same key, to stand in for it until it is played.
 *
 * What is fetched is kept for the life of the tab, up to a limit, so scrolling
 * back past a picture does not fetch it again.
 */

import type { Attachment } from '../store/log'
import { endpoints } from './cluster'
import { health } from './server-api'

/** Until the server says otherwise. The server's own limit is what counts. */
const DEFAULT_MAX = 100 * 1024 * 1024
/** How much opened file this tab keeps, before the oldest go. */
const KEEP_BYTES = 400 * 1024 * 1024
/** A thumb's longest side, in pixels: a hint of the picture, a few hundred bytes. */
const THUMB_PX = 24
/** A poster's longest side, for a video until it is played. */
const POSTER_PX = 960

function b64url(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(text: string): Uint8Array {
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function sealBytes(key: CryptoKey, plain: ArrayBuffer): Promise<Blob> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain)
  return new Blob([iv, box], { type: 'application/octet-stream' })
}

async function openBytes(keyText: string, sealed: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', unb64url(keyText) as BufferSource, 'AES-GCM', false, ['decrypt'])
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(sealed, 0, 12) }, key, new Uint8Array(sealed, 12))
}

export type Progress = (done: number, total: number) => void

/** What a picture or a video looks like, worked out on this device before it goes. */
interface Look {
  w?: number
  h?: number
  dur?: number
  thumb?: string
  poster?: Blob
}

function drawn(source: CanvasImageSource, w: number, h: number, most: number): HTMLCanvasElement {
  const scale = Math.min(1, most / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

async function lookAtImage(file: File): Promise<Look> {
  const bitmap = await createImageBitmap(file)
  try {
    const { width: w, height: h } = bitmap
    return { w, h, thumb: drawn(bitmap, w, h, THUMB_PX).toDataURL('image/jpeg', 0.6) }
  } finally {
    bitmap.close()
  }
}

async function lookAtVideo(file: File): Promise<Look> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  try {
    video.src = url
    await new Promise<void>((ok, fail) => {
      video.onloadeddata = () => ok()
      video.onerror = () => fail(new Error('not a video this browser plays'))
    })
    const dur = Number.isFinite(video.duration) ? video.duration : undefined
    // A frame a little way in, which is more often the picture than the black the first one is.
    const at = dur ? Math.min(1, dur / 4) : 0
    if (at > 0) {
      await new Promise<void>((ok) => {
        video.onseeked = () => ok()
        video.currentTime = at
      })
    }
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return { dur }
    const poster = await new Promise<Blob | null>((ok) =>
      drawn(video, w, h, POSTER_PX).toBlob((b) => ok(b), 'image/jpeg', 0.8),
    )
    return { w, h, dur, thumb: drawn(video, w, h, THUMB_PX).toDataURL('image/jpeg', 0.6), poster: poster ?? undefined }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

/*
 * HEVC, which is what an iPhone records. Safari and a Mac play it; Chrome on
 * Windows or Linux, and Firefox, play its sound over a black picture. The
 * sample entry names it, near the start of the file or near the end, where
 * the index is: hvc1 or hev1, or dvh1 or dvhe for Dolby Vision.
 */
const HEVC = ['hvc1', 'hev1', 'dvh1', 'dvhe'].map((tag) => [...tag].map((c) => c.charCodeAt(0)))

function namesHevc(bytes: Uint8Array): boolean {
  for (let i = 0; i + 4 <= bytes.length; i++) {
    for (const tag of HEVC) {
      if (bytes[i] === tag[0] && bytes[i + 1] === tag[1] && bytes[i + 2] === tag[2] && bytes[i + 3] === tag[3]) return true
    }
  }
  return false
}

/** Whether a video is one only some browsers can show the picture of. */
export async function isHevc(file: Blob): Promise<boolean> {
  const SPAN = 4 * 1024 * 1024
  const head = new Uint8Array(await file.slice(0, SPAN).arrayBuffer())
  if (namesHevc(head)) return true
  if (file.size <= SPAN) return false
  return namesHevc(new Uint8Array(await file.slice(Math.max(SPAN, file.size - SPAN)).arrayBuffer()))
}

/**
 * Play a video through this browser and record it again, as H.264 where the
 * browser records that and VP9 or VP8 where it does not, which every browser
 * plays. It takes as long as the video lasts, which is the price of doing it
 * here rather than on a server that would then see it. Null when this
 * browser cannot play it either, or cannot record.
 */
export async function reencode(file: File, onPart: (part: number) => void): Promise<File | null> {
  if (typeof MediaRecorder === 'undefined') return null
  const type = [
    'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ].find((t) => MediaRecorder.isTypeSupported(t))
  if (!type) return null
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.playsInline = true
  video.preload = 'auto'
  video.src = url
  const ctx = new AudioContext()
  try {
    await new Promise<void>((ok, fail) => {
      video.onloadeddata = () => ok()
      video.onerror = () => fail(new Error('not playable here'))
    })
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return null
    const scale = Math.min(1, 1920 / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round((w * scale) / 2) * 2
    canvas.height = Math.round((h * scale) / 2) * 2
    const draw = canvas.getContext('2d')
    if (!draw) return null
    // The sound goes into the recording and nowhere else: not out of the speakers.
    const sound = ctx.createMediaStreamDestination()
    ctx.createMediaElementSource(video).connect(sound)
    await ctx.resume().catch(() => undefined)
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...sound.stream.getAudioTracks()])
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 })
    const parts: Blob[] = []
    recorder.ondataavailable = (ev) => ev.data.size && parts.push(ev.data)
    const done = new Promise<void>((ok) => (recorder.onstop = () => ok()))
    let running = true
    const frame = (): void => {
      if (!running) return
      draw.drawImage(video, 0, 0, canvas.width, canvas.height)
      if (Number.isFinite(video.duration) && video.duration > 0) onPart(Math.min(1, video.currentTime / video.duration))
      const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(frame)
      else requestAnimationFrame(frame)
    }
    recorder.start(1000)
    frame()
    await video.play()
    await new Promise<void>((ok) => (video.onended = () => ok()))
    running = false
    recorder.stop()
    await done
    stream.getTracks().forEach((t) => t.stop())
    const blob = new Blob(parts, { type: type.split(';')[0] })
    if (blob.size === 0) return null
    const name = file.name.replace(/\.[^.]+$/, '') + (type.startsWith('video/mp4') ? '.mp4' : '.webm')
    return new File([blob], name, { type: blob.type })
  } catch {
    return null
  } finally {
    video.pause()
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
    void ctx.close().catch(() => undefined)
  }
}

async function lookAt(file: File): Promise<Look> {
  // Within a few seconds or not at all: a file that will not say is still a file.
  const within = <T>(work: Promise<T>): Promise<T | Look> =>
    Promise.race([work, new Promise<Look>((ok) => setTimeout(() => ok({}), 8000))])
  try {
    if (file.type.startsWith('image/')) return (await within(lookAtImage(file))) as Look
    if (file.type.startsWith('video/')) return (await within(lookAtVideo(file))) as Look
  } catch {
    /* the browser cannot draw it; it goes as a plain file */
  }
  return {}
}

/** Opened files, newest last, and how much of the limit they use. */
const opened = new Map<string, Promise<Blob>>()
const sizes = new Map<string, number>()
let held = 0

function remember(id: string, blob: Promise<Blob>): void {
  opened.set(id, blob)
  void blob.then(
    (b) => {
      sizes.set(id, b.size)
      held += b.size
      for (const [old] of opened) {
        if (held <= KEEP_BYTES || old === id) break
        held -= sizes.get(old) ?? 0
        sizes.delete(old)
        opened.delete(old)
        const url = urls.get(old)
        if (url) URL.revokeObjectURL(url)
        urls.delete(old)
      }
    },
    () => opened.delete(id),
  )
}

const urls = new Map<string, string>()

/** Everything one space does with files. One per space, so one per server and room. */
export class SpaceFiles {
  /** The largest file the server takes, once it has said. */
  max = DEFAULT_MAX

  constructor(
    private readonly server: string,
    private readonly room: string,
    private readonly write: string,
    private readonly serving: () => string = () => server,
  ) {
    void health(server).then((h) => {
      if (h.files?.max) this.max = h.files.max
    })
  }

  /** Servers to try, the one this space is talking to first. */
  private bases(): string[] {
    const now = this.serving()
    const all = endpoints(this.server)
    return now && all.includes(now) ? [now, ...all.filter((b) => b !== now)] : all
  }

  /**
   * Look at a file, seal it, send it, and say how to find it again. A video
   * only some browsers can show is made into one they all can first.
   */
  async send(file: File, onProgress: Progress, signal: AbortSignal, onStage?: (words: string) => void): Promise<Attachment> {
    if (file.type.startsWith('video/') && (await isHevc(file))) {
      onStage?.('Converting so everyone can watch it')
      const converted = await reencode(file, (part) => onStage?.(`Converting so everyone can watch it · ${Math.floor(part * 100)}%`))
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError')
      if (converted) file = converted
    }
    const look = await lookAt(file)
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key))
    const sealed = await sealBytes(key, await file.arrayBuffer())
    const posterSealed = look.poster ? await sealBytes(key, await look.poster.arrayBuffer()) : null
    const total = sealed.size + (posterSealed?.size ?? 0)
    const id = await this.upload(sealed, (done) => onProgress(done, total), signal)
    const poster = posterSealed
      ? await this.upload(posterSealed, (done) => onProgress(sealed.size + done, total), signal).catch(() => undefined)
      : undefined
    const attachment: Attachment = {
      id,
      name: file.name || 'file',
      type: file.type || 'application/octet-stream',
      size: file.size,
      key: b64url(raw),
    }
    if (look.w && look.h) {
      attachment.w = look.w
      attachment.h = look.h
    }
    if (look.dur) attachment.dur = Math.round(look.dur * 10) / 10
    if (look.thumb && look.thumb.length <= 4000) attachment.thumb = look.thumb
    if (poster) attachment.poster = poster
    // What was just sent is already open here, so drawing it costs nothing.
    remember(id, Promise.resolve(new Blob([file], { type: attachment.type })))
    return attachment
  }

  private async upload(blob: Blob, onProgress: Progress, signal: AbortSignal): Promise<string> {
    let last: unknown = null
    for (const base of this.bases()) {
      try {
        return await this.uploadTo(base, blob, onProgress, signal)
      } catch (err) {
        if (signal.aborted || (err instanceof UploadRefused)) throw err
        last = err
      }
    }
    throw last ?? new Error('No server answered.')
  }

  /** XMLHttpRequest rather than fetch, because only it says how far an upload has got. */
  private uploadTo(base: string, blob: Blob, onProgress: Progress, signal: AbortSignal): Promise<string> {
    return new Promise((ok, fail) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${base}/api/v1/spaces/${this.room}/files`)
      xhr.setRequestHeader('content-type', 'application/octet-stream')
      xhr.setRequestHeader('x-cathode-write', this.write)
      xhr.upload.onprogress = (ev) => onProgress(ev.loaded, ev.total)
      xhr.onload = () => {
        let body: { id?: string; error?: { message?: string } } = {}
        try {
          body = JSON.parse(xhr.responseText) as typeof body
        } catch {
          /* said nothing useful */
        }
        if (xhr.status === 200 && typeof body.id === 'string') ok(body.id)
        else if ((xhr.status >= 400 && xhr.status < 500) || xhr.status === 507) {
          fail(new UploadRefused(body.error?.message ?? 'The server would not take that file.'))
        } else fail(new Error(`The server said ${xhr.status}.`))
      }
      xhr.onerror = () => fail(new Error('The server could not be reached.'))
      xhr.onabort = () => fail(new DOMException('Stopped', 'AbortError'))
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
      xhr.send(blob)
    })
  }

  /** A file, opened. Fetched once per tab. */
  open(file: Attachment, onProgress?: Progress): Promise<Blob> {
    const held = opened.get(file.id)
    if (held) return held
    const work = this.fetchOpen(file.id, file.key, file.type, onProgress)
    remember(file.id, work)
    return work
  }

  /** A video's first frame, opened, or null when it has none. */
  poster(file: Attachment): Promise<Blob | null> {
    if (!file.poster) return Promise.resolve(null)
    const held = opened.get(file.poster)
    if (held) return held
    const work = this.fetchOpen(file.poster, file.key, 'image/jpeg')
    remember(file.poster, work)
    return work.catch(() => null)
  }

  /** An address the page can show, for as long as the file is kept. */
  async url(file: Attachment, onProgress?: Progress): Promise<string> {
    const blob = await this.open(file, onProgress)
    let url = urls.get(file.id)
    if (!url) {
      url = URL.createObjectURL(blob)
      urls.set(file.id, url)
    }
    return url
  }

  private async fetchOpen(id: string, key: string, type: string, onProgress?: Progress): Promise<Blob> {
    let last: unknown = null
    for (const base of this.bases()) {
      try {
        const res = await fetch(`${base}/api/v1/spaces/${this.room}/files/${id}`, { mode: 'cors' })
        if (res.status === 404) {
          last = new Error('That file is not on the server.')
          continue
        }
        if (!res.ok || !res.body) throw new Error(`The server said ${res.status}.`)
        const total = Number(res.headers.get('content-length') ?? 0)
        const reader = res.body.getReader()
        const parts: Uint8Array[] = []
        let done = 0
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          parts.push(chunk.value)
          done += chunk.value.length
          onProgress?.(done, total)
        }
        const sealed = await new Blob(parts as BlobPart[]).arrayBuffer()
        return new Blob([await openBytes(key, sealed)], { type })
      } catch (err) {
        last = err
      }
    }
    throw last ?? new Error('No server had that file.')
  }
}

/** A refusal that trying another server of the cluster will not change: too big, or the space is full. */
export class UploadRefused extends Error {}

/** Save an opened file to the device, under its own name. */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** A size a person reads: 1.4 MB, 820 KB. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
