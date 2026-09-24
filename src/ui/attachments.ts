/**
 * Files in the conversation: drawn in a message, opened full screen, and
 * waiting in the tray under the box while they upload.
 *
 * A picture is given its shape and a blurred likeness at once, from what the
 * message says about it, and is fetched and opened when it scrolls near the
 * screen, so a channel full of pictures costs what is looked at. A video
 * shows its first frame and is fetched when it is played. Anything else is a
 * card with its name, its size and a way to save it.
 *
 * Every byte arrives sealed and is opened here, on this device: see
 * net/files.ts. A picture is shown through an img with an address made on
 * this page, never as markup, so what somebody uploads can only ever be a
 * picture.
 */

import { saveFile, sizeLabel, UploadRefused, type SpaceFiles } from '../net/files'
import { MAX_FILES, type Attachment } from '../store/log'
import { h } from './dom'
import { icon, type IconName } from './icons'
import { toast } from './toast'

type Kind = 'image' | 'video' | 'audio' | 'file'

const IMAGE = /^image\/(jpeg|png|gif|webp|avif|bmp|svg\+xml)$/
const VIDEO = /^video\/(mp4|webm|ogg|quicktime)$/

export function kindOf(file: { type: string }): Kind {
  if (IMAGE.test(file.type)) return 'image'
  if (VIDEO.test(file.type)) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'file'
}

function iconFor(kind: Kind): IconName {
  return kind === 'audio' ? 'music' : kind === 'video' ? 'play' : 'file'
}

/** A picture's size in a message: the shape kept, inside a box of at most `most`. */
function fit(file: Attachment, most: { w: number; h: number }): { w: number; h: number } {
  if (!file.w || !file.h) return { w: Math.min(most.w, 320), h: Math.min(most.h, 240) }
  const scale = Math.min(1, most.w / file.w, most.h / file.h)
  return { w: Math.max(48, Math.round(file.w * scale)), h: Math.max(48, Math.round(file.h * scale)) }
}

function duration(seconds: number): string {
  const s = Math.round(seconds)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** Fetched when close to the screen, and not before. */
const waiting = new WeakMap<Element, () => void>()
const nearby =
  typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            nearby?.unobserve(entry.target)
            waiting.get(entry.target)?.()
            waiting.delete(entry.target)
          }
        },
        { rootMargin: '600px 0px' },
      )

function whenNear(el: Element, work: () => void): void {
  if (!nearby) return work()
  waiting.set(el, work)
  nearby.observe(el)
}

/** A blurred likeness, for the moment before the real thing. */
function blur(file: Attachment): HTMLElement | null {
  if (!file.thumb) return null
  const el = h('span', { class: 'att-blur' })
  el.style.backgroundImage = `url("${file.thumb}")`
  return el
}

/** Everything a message carries, drawn. */
export function attachmentBlock(files: Attachment[], source: SpaceFiles | null): HTMLElement {
  const media = files.filter((f) => kindOf(f) === 'image' || kindOf(f) === 'video')
  const pictures = files.filter((f) => kindOf(f) === 'image')
  const rest = files.filter((f) => !media.includes(f))
  // One picture gets room to be seen. Several share it.
  const most = media.length === 1 ? { w: 440, h: 340 } : { w: 260, h: 220 }
  const block = h('div', { class: 'att-block' })
  if (media.length) {
    block.append(
      h(
        'div',
        { class: 'att-media' },
        media.map((f) =>
          kindOf(f) === 'image'
            ? imageTile(f, source, most, () => source && openViewer(pictures, pictures.indexOf(f), source))
            : videoTile(f, source, most),
        ),
      ),
    )
  }
  for (const f of rest) block.append(fileCard(f, source))
  return block
}

function imageTile(file: Attachment, source: SpaceFiles | null, most: { w: number; h: number }, onOpen: () => void): HTMLElement {
  const size = fit(file, most)
  const img = h('img', { class: 'att-img' })
  img.alt = file.name
  img.decoding = 'async'
  const tile = h(
    'button',
    { class: 'att-tile att-image', title: `${file.name}, ${sizeLabel(file.size)}`, ariaLabel: `Open ${file.name}`, on: { click: onOpen } },
    [blur(file), img],
  )
  tile.style.width = `${size.w}px`
  tile.style.aspectRatio = `${size.w} / ${size.h}`
  img.addEventListener('load', () => tile.classList.add('ready'))
  // A picture this browser cannot draw (HEIC, say) is still a file.
  img.addEventListener('error', () => tile.replaceWith(fileCard(file, source)))
  if (source) {
    whenNear(tile, () => {
      source.url(file).then(
        (url) => (img.src = url),
        () => tile.classList.add('failed'),
      )
    })
  }
  return tile
}

function videoTile(file: Attachment, source: SpaceFiles | null, most: { w: number; h: number }): HTMLElement {
  const size = fit(file, most)
  const poster = h('img', { class: 'att-img' })
  poster.alt = ''
  const progress = h('span', { class: 'att-progress hidden' })
  const play = h('span', { class: 'att-play' }, [icon('play', 22), progress])
  const tile = h('div', { class: 'att-tile att-video', title: `${file.name}, ${sizeLabel(file.size)}` }, [
    blur(file),
    poster,
    play,
    h('span', { class: 'att-meta' }, [
      h('span', { text: file.dur ? duration(file.dur) : 'Video' }),
      h('span', { text: sizeLabel(file.size) }),
    ]),
  ])
  tile.tabIndex = 0
  tile.setAttribute('role', 'button')
  tile.setAttribute('aria-label', `Play ${file.name}`)
  tile.style.width = `${size.w}px`
  tile.style.aspectRatio = `${size.w} / ${size.h}`
  poster.addEventListener('load', () => tile.classList.add('ready'))
  if (source) {
    whenNear(tile, () => {
      void source.poster(file).then((blob) => {
        if (blob) poster.src = URL.createObjectURL(blob)
      })
    })
  }

  let started = false
  const start = async (): Promise<void> => {
    if (!source || started) return
    started = true
    tile.classList.add('loading')
    progress.classList.remove('hidden')
    progress.textContent = '0%'
    try {
      const url = await source.url(file, (done, total) => {
        if (total) progress.textContent = `${Math.min(99, Math.floor((done / total) * 100))}%`
      })
      const video = h('video', { class: 'att-player' })
      video.controls = true
      video.playsInline = true
      video.src = url
      tile.classList.add('playing')
      tile.replaceChildren(video)
      tile.removeAttribute('role')
      tile.removeAttribute('tabindex')
      watchPicture(video, tile, file, source)
      await video.play().catch(() => undefined)
    } catch {
      started = false
      tile.classList.remove('loading')
      progress.classList.add('hidden')
      toast(`Could not open ${file.name}.`, 'warn')
    }
  }
  tile.addEventListener('click', () => void start())
  tile.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      void start()
    }
  })
  return tile
}

/**
 * A video whose sound plays and whose picture does not: this browser cannot
 * decode the picture (HEVC, most often, on anything but Safari or a Mac). Said
 * over the black, with a way to save it, rather than left as a black box.
 */
function watchPicture(video: HTMLVideoElement, tile: HTMLElement, file: Attachment, source: SpaceFiles): void {
  const check = (): void => {
    if (video.currentTime < 0.8) return
    video.removeEventListener('timeupdate', check)
    const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 1
    if (video.videoWidth > 0 && frames > 0) return
    const save = h('button', { class: 'small' }, [icon('download', 14), 'Save'])
    save.addEventListener('click', async () => saveFile(await source.open(file), file.name))
    tile.append(
      h('div', { class: 'att-cant' }, [
        h('span', { text: 'This browser can play the sound but not the picture of this video.' }),
        h('span', { class: 'tiny faint', text: 'Save it to watch it in another app, or open it in Safari.' }),
        save,
      ]),
    )
  }
  video.addEventListener('timeupdate', check)
}

/*
 * One at a time. Starting a video or a sound here stops whichever other one
 * was playing, the way two people talking at once is nobody talking.
 */
document.addEventListener(
  'play',
  (ev) => {
    const started = ev.target
    if (!(started instanceof HTMLMediaElement) || !started.matches('.att-player, .att-audio')) return
    for (const other of document.querySelectorAll<HTMLMediaElement>('.att-player, .att-audio')) {
      if (other !== started && !other.paused) other.pause()
    }
  },
  true,
)

function fileCard(file: Attachment, source: SpaceFiles | null): HTMLElement {
  const kind = kindOf(file)
  const extension = /\.([a-z0-9]{1,6})$/i.exec(file.name)?.[1]?.toUpperCase() ?? ''
  const detail = h('span', { class: 'tiny faint', text: [sizeLabel(file.size), extension].filter(Boolean).join(' · ') })
  const save = h('button', { class: 'ghost icon-only', title: 'Save', ariaLabel: `Save ${file.name}` }, [icon('download', 17)])
  const card = h('div', { class: 'att-file' }, [
    h('span', { class: `att-file-icon ${kind}` }, [icon(iconFor(kind), 20)]),
    h('span', { class: 'att-file-words' }, [h('span', { class: 'att-file-name truncate', text: file.name }), detail]),
    save,
  ])
  const fetching = async (): Promise<Blob | null> => {
    if (!source) return null
    try {
      return await source.open(file, (done, total) => {
        if (total) detail.textContent = `${Math.floor((done / total) * 100)}% of ${sizeLabel(file.size)}`
      })
    } catch {
      toast(`Could not open ${file.name}.`, 'warn')
      return null
    } finally {
      detail.textContent = [sizeLabel(file.size), extension].filter(Boolean).join(' · ')
    }
  }
  save.addEventListener('click', async () => {
    const blob = await fetching()
    if (blob) saveFile(blob, file.name)
  })
  // A sound plays where it is.
  if (kind === 'audio') {
    const play = h('button', { class: 'ghost icon-only', title: 'Play', ariaLabel: `Play ${file.name}` }, [icon('play', 15)])
    save.before(play)
    play.addEventListener('click', async () => {
      play.disabled = true
      const blob = await fetching()
      if (!blob || !source) {
        play.disabled = false
        return
      }
      const audio = h('audio', { class: 'att-audio' })
      audio.controls = true
      audio.src = await source.url(file)
      play.remove()
      card.after(audio)
      await audio.play().catch(() => undefined)
    })
  }
  return card
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

/** The pictures of a message, full screen, one at a time. */
export function openViewer(list: Attachment[], start: number, source: SpaceFiles): void {
  if (list.length === 0) return
  let at = Math.max(0, start)
  const img = h('img', { class: 'viewer-img' })
  const name = h('span', { class: 'viewer-name truncate' })
  const detail = h('span', { class: 'tiny faint' })
  const stage = h('div', { class: 'viewer-stage' }, [img])
  const close = h('button', { class: 'ghost icon-only', ariaLabel: 'Close', title: 'Close (Esc)' }, [icon('close', 18)])
  const save = h('button', { class: 'ghost', title: 'Save' }, [icon('download', 16), 'Save'])
  const back = h('button', { class: 'viewer-step back', ariaLabel: 'Previous picture' }, [icon('chevron-left', 22)])
  const next = h('button', { class: 'viewer-step next', ariaLabel: 'Next picture' }, [icon('chevron-right', 22)])
  const root = h('div', { class: 'viewer', role: 'dialog', ariaLabel: 'Picture' }, [
    h('div', { class: 'viewer-bar' }, [h('div', { class: 'viewer-words' }, [name, detail]), save, close]),
    stage,
    list.length > 1 ? back : null,
    list.length > 1 ? next : null,
  ])

  const show = (): void => {
    const file = list[at]
    root.classList.remove('zoomed')
    name.textContent = file.name
    detail.textContent = `${sizeLabel(file.size)}${file.w && file.h ? ` · ${file.w} × ${file.h}` : ''}${list.length > 1 ? ` · ${at + 1} of ${list.length}` : ''}`
    img.src = file.thumb ?? ''
    img.classList.add('soft')
    void source.url(file).then((url) => {
      if (list[at] !== file) return
      img.src = url
      img.classList.remove('soft')
    })
  }
  const step = (by: number): void => {
    at = (at + by + list.length) % list.length
    show()
  }
  const shut = (): void => {
    root.remove()
    window.removeEventListener('keydown', onKey, true)
  }
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') shut()
    else if (ev.key === 'ArrowLeft' && list.length > 1) step(-1)
    else if (ev.key === 'ArrowRight' && list.length > 1) step(1)
    else return
    ev.preventDefault()
    ev.stopPropagation()
  }
  close.addEventListener('click', shut)
  back.addEventListener('click', () => step(-1))
  next.addEventListener('click', () => step(1))
  save.addEventListener('click', async () => {
    const file = list[at]
    saveFile(await source.open(file), file.name)
  })
  // A click on the picture looks closer, and again goes back. Anywhere else closes.
  img.addEventListener('click', (ev) => {
    ev.stopPropagation()
    root.classList.toggle('zoomed')
  })
  stage.addEventListener('click', (ev) => {
    if (ev.target === stage) shut()
  })
  window.addEventListener('keydown', onKey, true)
  document.body.append(root)
  show()
  close.focus()
}

// ---------------------------------------------------------------------------
// The tray: what is attached, while it uploads
// ---------------------------------------------------------------------------

interface Pending {
  file: File
  chip: HTMLElement
  state: 'sending' | 'done' | 'failed'
  attachment?: Attachment
  stop: AbortController
  settled: Promise<void>
  preview?: string
}

export class AttachTray {
  readonly root = h('div', { class: 'attach-tray hidden' })
  private items: Pending[] = []
  /** Told when anything changes, so the box can say whether it can send. */
  onChange: (() => void) | null = null

  constructor(private readonly source: () => SpaceFiles | null) {}

  get count(): number {
    return this.items.length
  }

  get busy(): boolean {
    return this.items.some((i) => i.state === 'sending')
  }

  get failed(): boolean {
    return this.items.some((i) => i.state === 'failed')
  }

  /** What is ready to go with the message, in the order it was attached. */
  get ready(): Attachment[] {
    return this.items.flatMap((i) => (i.attachment ? [i.attachment] : []))
  }

  whenSettled(): Promise<void> {
    return Promise.all(this.items.map((i) => i.settled)).then(() => undefined)
  }

  add(files: File[]): void {
    const source = this.source()
    if (!source) {
      toast('This server does not take files.', 'warn')
      return
    }
    for (const file of files) {
      if (this.items.length >= MAX_FILES) {
        toast(`A message can carry ${MAX_FILES} files at most.`, 'warn')
        break
      }
      if (file.size > source.max) {
        toast(`${file.name} is ${sizeLabel(file.size)}. This server takes files up to ${sizeLabel(source.max)}.`, 'warn', 6000)
        continue
      }
      if (file.size === 0) {
        toast(`${file.name} is empty.`, 'warn')
        continue
      }
      this.start(file, source)
    }
    this.paint()
  }

  private start(file: File, source: SpaceFiles): void {
    const bar = h('span', { class: 'attach-bar' })
    const detail = h('span', { class: 'tiny faint truncate', text: 'Encrypting' })
    const kind = kindOf(file)
    const item: Pending = {
      file,
      chip: h('div', { class: 'attach-chip' }),
      state: 'sending',
      stop: new AbortController(),
      settled: Promise.resolve(),
    }
    if (kind === 'image') item.preview = URL.createObjectURL(file)
    const face = item.preview
      ? h('img', { class: 'attach-face' })
      : h('span', { class: `attach-face ${kind}` }, [icon(iconFor(kind), 18)])
    if (item.preview && face instanceof HTMLImageElement) face.src = item.preview
    const remove = h('button', {
      class: 'ghost icon-only attach-remove',
      ariaLabel: `Take off ${file.name}`,
      title: 'Take it off',
      on: { click: () => this.remove(item) },
    }, [icon('close', 13)])
    item.chip.append(face, h('span', { class: 'attach-words' }, [h('span', { class: 'attach-name truncate', text: file.name }), detail]), remove, bar)
    item.settled = source
      .send(
        file,
        (done, total) => {
          const part = total ? done / total : 0
          bar.style.transform = `scaleX(${part})`
          detail.textContent = `${Math.floor(part * 100)}% of ${sizeLabel(file.size)}`
        },
        item.stop.signal,
        (words) => (detail.textContent = words),
      )
      .then(
        (attachment) => {
          item.attachment = attachment
          item.state = 'done'
          item.chip.classList.add('done')
          detail.textContent = sizeLabel(file.size)
        },
        (err: unknown) => {
          if (item.stop.signal.aborted) return
          item.state = 'failed'
          item.chip.classList.add('failed')
          detail.textContent = err instanceof UploadRefused ? err.message : 'Did not upload'
          detail.title = detail.textContent
        },
      )
      .finally(() => this.onChange?.())
    this.items.push(item)
  }

  private remove(item: Pending): void {
    item.stop.abort()
    if (item.preview) URL.revokeObjectURL(item.preview)
    this.items = this.items.filter((i) => i !== item)
    this.paint()
  }

  /** Empty it: after sending, or on moving somewhere else. Anything still going is stopped. */
  clear(): void {
    for (const item of [...this.items]) this.remove(item)
  }

  private paint(): void {
    this.root.replaceChildren(...this.items.map((i) => i.chip))
    this.root.classList.toggle('hidden', this.items.length === 0)
    this.onChange?.()
  }
}
