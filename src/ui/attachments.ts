import { saveFile, sizeLabel, unwatchStream, UploadRefused, type Progress, type SpaceFiles } from '../net/files'
import { VOICE_NAME } from '../media/voice-note'
import { MAX_FILES, type Attachment } from '../store/log'
import { h } from './dom'
import { closeOnBack } from './gestures'
import { icon, type IconName } from './icons'
import { renderMarkdown } from './markdown'
import { toast } from './toast'
import { videoPlayer } from './video-player'

type Kind = 'image' | 'video' | 'audio' | 'file'

// No SVG: it is a document that can carry script. Opened in a tab of its own, from a blob: address,
// it would run as this page. It comes as a file to save.
const IMAGE = /^image\/(jpeg|png|gif|webp|avif|bmp)$/
const VIDEO = /^video\/(mp4|webm|ogg|quicktime)$/

function kindOf(file: { type: string }): Kind {
  if (IMAGE.test(file.type)) return 'image'
  if (VIDEO.test(file.type)) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'file'
}

const MARKDOWN_NAME = /\.(md|markdown|mdown|mkd)$/i
/** Bigger than this, a markdown file is a file to save: the preview downloads it whole. */
const MOST_MARKDOWN = 2 * 1024 * 1024

function isMarkdown(file: Attachment): boolean {
  return (MARKDOWN_NAME.test(file.name) || file.type === 'text/markdown') && file.size <= MOST_MARKDOWN
}

function iconFor(kind: Kind): IconName {
  return kind === 'audio' ? 'music' : kind === 'video' ? 'play' : 'file'
}

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

function blurredThumb(file: Attachment): HTMLElement | null {
  if (!file.thumb) return null
  const el = h('span', { class: 'att-blur' })
  el.style.backgroundImage = `url("${file.thumb}")`
  return el
}

export function attachmentBlock(files: Attachment[], source: SpaceFiles | null): HTMLElement {
  const pictures: Attachment[] = []
  const media: Attachment[] = []
  const rest: Attachment[] = []
  for (const f of files) {
    const kind = kindOf(f)
    if (kind === 'image') pictures.push(f)
    if (kind === 'image' || kind === 'video') media.push(f)
    else rest.push(f)
  }
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

/**
 * Fetches the whole file and saves it, with how far it has come on the button meanwhile. A second
 * click while it comes does nothing.
 */
async function saveFrom(file: Attachment, source: SpaceFiles, button: HTMLButtonElement): Promise<void> {
  if (button.disabled) return
  const face = [...button.childNodes]
  button.disabled = true
  button.classList.add('saving')
  try {
    const blob = await source.open(file, (done, total) => {
      if (total) button.textContent = `${Math.min(99, Math.floor((done / total) * 100))}%`
    })
    saveFile(blob, file.name)
  } catch {
    toast(`Could not save ${file.name}.`, 'warn')
  } finally {
    button.replaceChildren(...face)
    button.disabled = false
    button.classList.remove('saving')
  }
}

/** Save, in the corner of a picture or a video, so it can be kept without opening it first. */
function cornerSave(file: Attachment, source: SpaceFiles): HTMLButtonElement {
  const save = h('button', { class: 'att-save icon-only', title: 'Save', ariaLabel: `Save ${file.name}` }, [icon('download', 16)])
  // Not a click or a key on the tile under it, which would open or play it.
  save.addEventListener('click', (ev) => {
    ev.stopPropagation()
    void saveFrom(file, source, save)
  })
  save.addEventListener('keydown', (ev) => ev.stopPropagation())
  return save
}

function imageTile(file: Attachment, source: SpaceFiles | null, most: { w: number; h: number }, onOpen: () => void): HTMLElement {
  const size = fit(file, most)
  const img = h('img', { class: 'att-img' })
  img.alt = file.name
  img.decoding = 'async'
  // Not a button, because the Save button sits inside it.
  const tile = h('div', { class: 'att-tile att-image', title: `${file.name}, ${sizeLabel(file.size)}`, on: { click: onOpen } }, [
    blurredThumb(file),
    img,
    source ? cornerSave(file, source) : null,
  ])
  tile.tabIndex = 0
  tile.setAttribute('role', 'button')
  tile.setAttribute('aria-label', `Open ${file.name}`)
  tile.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    onOpen()
  })
  tile.style.width = `${size.w}px`
  tile.style.aspectRatio = `${size.w} / ${size.h}`
  img.addEventListener('load', () => tile.classList.add('ready'))
  // A picture this browser cannot decode (HEIC) falls back to a file card.
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
    blurredThumb(file),
    poster,
    play,
    h('span', { class: 'att-meta' }, [
      h('span', { text: file.dur ? duration(file.dur) : 'Video' }),
      h('span', { text: sizeLabel(file.size) }),
    ]),
    source ? cornerSave(file, source) : null,
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
    const shown: Progress = (done, total) => {
      if (total) progress.textContent = `${Math.min(99, Math.floor((done / total) * 100))}%`
    }
    try {
      // Plays as it arrives when it can; the whole file first when it cannot.
      // The stream counts toward the first part the video needs to start, not the whole file.
      const stream = source.streamUrl(file, shown)
      const player = videoPlayer(file.name, file.dur ?? 0, (button) => saveFrom(file, source, button))
      const video = player.video
      if (stream) {
        video.src = stream
        await new Promise<void>((ok, fail) => {
          video.addEventListener('loadedmetadata', () => ok(), { once: true })
          video.addEventListener('error', () => fail(new Error('the stream did not play')), { once: true })
        })
          .catch(async () => {
            progress.textContent = '0%'
            video.src = await source.url(file, shown)
          })
          .finally(() => unwatchStream(file.id))
      } else {
        video.src = await source.url(file, shown)
      }
      tile.classList.remove('loading')
      tile.classList.add('playing')
      tile.replaceChildren(player.root)
      tile.removeAttribute('role')
      tile.removeAttribute('tabindex')
      tile.removeAttribute('aria-label')
      tile.removeAttribute('title')
      warnIfNoPicture(video, tile, file, source)
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
    if (started) return
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      void start()
    }
  })
  return tile
}

// Most browsers outside Safari play the sound of an HEVC video but show no picture.
function warnIfNoPicture(video: HTMLVideoElement, tile: HTMLElement, file: Attachment, source: SpaceFiles): void {
  const check = (): void => {
    if (video.currentTime < 0.8) return
    video.removeEventListener('timeupdate', check)
    const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 1
    if (video.videoWidth > 0 && frames > 0) return
    const save = h('button', { class: 'small' }, [icon('download', 14), 'Save'])
    save.addEventListener('click', () => void saveFrom(file, source, save))
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

function pauseOtherPlayers(ev: Event): void {
  const started = ev.target
  if (!(started instanceof HTMLMediaElement) || !started.matches('.att-player, .att-audio')) return
  for (const other of document.querySelectorAll<HTMLMediaElement>('.att-player, .att-audio')) {
    if (other !== started && !other.paused) other.pause()
  }
}

document.addEventListener('play', pauseOtherPlayers, true)

/** A voice message: a play button, how far it has played, and how long it is. */
function voiceCard(file: Attachment, source: SpaceFiles | null): HTMLElement {
  const total = file.dur ?? 0
  const time = h('span', { class: 'note-time tiny', text: total ? duration(total) : '' })
  const fill = h('i')
  const play = h('button', { class: 'note-play', title: 'Play', ariaLabel: 'Play the voice message' }, [icon('play', 17)])
  const track = h('span', { class: 'note-track', role: 'progressbar', ariaLabel: 'Voice message' }, [fill])
  const card = h('div', { class: 'att-voice' }, [play, track, time])
  let audio: HTMLAudioElement | null = null
  const rest = (): void => {
    play.replaceChildren(icon('play', 17))
    play.title = 'Play'
    play.setAttribute('aria-label', 'Play the voice message')
    fill.style.transform = 'scaleX(0)'
    time.textContent = total ? duration(total) : ''
  }
  play.addEventListener('click', async () => {
    if (!source) return
    if (audio && !audio.paused) {
      audio.pause()
      return
    }
    if (!audio) {
      play.disabled = true
      try {
        const el = h('audio', { class: 'att-audio hidden' })
        el.src = await source.url(file)
        el.addEventListener('play', () => {
          play.replaceChildren(icon('pause', 17))
          play.title = 'Pause'
          play.setAttribute('aria-label', 'Pause the voice message')
        })
        el.addEventListener('pause', () => {
          if (!el.ended) {
            play.replaceChildren(icon('play', 17))
            play.title = 'Play'
            play.setAttribute('aria-label', 'Play the voice message')
          }
        })
        el.addEventListener('ended', rest)
        el.addEventListener('timeupdate', () => {
          if (!total) return
          const at = Math.min(total, el.currentTime)
          fill.style.transform = `scaleX(${at / total})`
          time.textContent = duration(at)
        })
        card.append(el)
        audio = el
      } catch {
        toast('Could not open the voice message.', 'warn')
        return
      } finally {
        play.disabled = false
      }
    }
    await audio.play().catch(() => undefined)
  })
  return card
}

function fileCard(file: Attachment, source: SpaceFiles | null): HTMLElement {
  const kind = kindOf(file)
  if (kind === 'audio' && VOICE_NAME.test(file.name)) return voiceCard(file, source)
  if (isMarkdown(file)) return markdownCard(file, source)
  const extension = /\.([a-z0-9]{1,6})$/i.exec(file.name)?.[1]?.toUpperCase() ?? ''
  const label = [sizeLabel(file.size), extension].filter(Boolean).join(' · ')
  const detail = h('span', { class: 'tiny faint', text: label })
  const save = h('button', { class: 'ghost icon-only', title: 'Save', ariaLabel: `Save ${file.name}` }, [icon('download', 19)])
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
      detail.textContent = label
    }
  }
  save.addEventListener('click', async () => {
    const blob = await fetching()
    if (blob) saveFile(blob, file.name)
  })
  if (kind === 'audio') {
    const play = h('button', { class: 'ghost icon-only', title: 'Play', ariaLabel: `Play ${file.name}` }, [icon('play', 17)])
    save.before(play)
    play.addEventListener('click', async () => {
      play.disabled = true
      const stream = source?.streamUrl(file) ?? null
      const blob = stream ? null : await fetching()
      if ((!stream && !blob) || !source) {
        play.disabled = false
        return
      }
      const audio = h('audio', { class: 'att-audio' })
      audio.controls = true
      audio.src = stream ?? (await source.url(file))
      play.remove()
      card.after(audio)
      await audio.play().catch(() => undefined)
    })
  }
  return card
}

/**
 * A markdown file, drawn as notes draw markdown: the top of it in the message, and the whole of
 * it a click away. It is read once it is near the screen, and the renderer builds elements, never
 * HTML, so a file cannot put script or styles in the page, or load a picture from elsewhere.
 */
function markdownCard(file: Attachment, source: SpaceFiles | null): HTMLElement {
  const label = `${sizeLabel(file.size)} · MD`
  const detail = h('span', { class: 'tiny faint', text: label })
  const save = h('button', { class: 'ghost icon-only', title: 'Save', ariaLabel: `Save ${file.name}` }, [icon('download', 19)])
  const open = h('button', { class: 'ghost icon-only', title: 'Open', ariaLabel: `Open ${file.name}` }, [icon('expand', 18)])
  const body = h('div', { class: 'att-doc-body md' }, [h('p', { class: 'faint', text: 'Opening…' })])
  // A div, not a button: a button may not hold the links and blocks of a document.
  const page = h('div', { class: 'att-doc-page', role: 'button', tabIndex: 0, ariaLabel: `Read ${file.name}` }, [body])
  const card = h('div', { class: 'att-doc' }, [
    h('div', { class: 'att-file att-doc-head' }, [
      h('span', { class: 'att-file-icon' }, [icon('file', 20)]),
      h('span', { class: 'att-file-words' }, [h('span', { class: 'att-file-name truncate', text: file.name }), detail]),
      open,
      save,
    ]),
    page,
  ])

  let text: Promise<string | null> | null = null
  const read = (): Promise<string | null> =>
    (text ??= (async () => {
      if (!source) return null
      try {
        const blob = await source.open(file, (done, total) => {
          if (total) detail.textContent = `${Math.floor((done / total) * 100)}% of ${sizeLabel(file.size)}`
        })
        return await blob.text()
      } catch {
        text = null
        return null
      } finally {
        detail.textContent = label
      }
    })())

  const show = async (): Promise<void> => {
    const words = await read()
    if (words === null) {
      body.replaceChildren(h('p', { class: 'faint', text: 'Could not open it. Save it to read it.' }))
      return
    }
    body.replaceChildren(words.trim() ? renderMarkdown(words) : h('p', { class: 'faint', text: 'It is empty.' }))
    // Only a preview that is cut short fades out at the foot.
    page.classList.toggle('cut', body.scrollHeight > page.clientHeight + 4)
  }
  whenNear(card, () => void show())

  const reader = async (): Promise<void> => {
    const words = await read()
    if (words === null) {
      toast(`Could not open ${file.name}.`, 'warn')
      return
    }
    openReader(file, words, () => save.click())
  }
  open.addEventListener('click', () => void reader())
  page.addEventListener('click', (ev) => {
    // A link in the preview opens the link, not the reader.
    if ((ev.target as Element).closest('a')) return
    void reader()
  })
  page.addEventListener('keydown', (ev) => {
    if (ev.target !== page || (ev.key !== 'Enter' && ev.key !== ' ')) return
    ev.preventDefault()
    void reader()
  })
  save.addEventListener('click', async () => {
    if (!source) return
    try {
      saveFile(await source.open(file), file.name)
    } catch {
      toast(`Could not open ${file.name}.`, 'warn')
    }
  })
  return card
}

/** The whole of a markdown file, over everything, as a picture opens. */
function openReader(file: Attachment, words: string, onSave: () => void): void {
  const close = h('button', { class: 'ghost icon-only', ariaLabel: 'Close', title: 'Close (Esc)' }, [icon('close', 20)])
  const save = h('button', { class: 'ghost', title: 'Save' }, [icon('download', 16), 'Save'])
  const article = h('article', { class: 'doc-reader-page md' }, [renderMarkdown(words)])
  const stage = h('div', { class: 'doc-reader-stage' }, [article])
  const root = h('div', { class: 'doc-reader', role: 'dialog', ariaLabel: file.name }, [
    h('div', { class: 'doc-reader-bar' }, [
      h('div', { class: 'viewer-words' }, [
        h('span', { class: 'viewer-name truncate', text: file.name }),
        h('span', { class: 'tiny faint', text: `${sizeLabel(file.size)} · Markdown` }),
      ]),
      save,
      close,
    ]),
    stage,
  ])
  const shut = (): void => {
    root.remove()
    window.removeEventListener('keydown', onKey, true)
    leaveHistory()
  }
  const leaveHistory = closeOnBack(shut)
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopPropagation()
    shut()
  }
  close.addEventListener('click', shut)
  save.addEventListener('click', onSave)
  stage.addEventListener('click', (ev) => {
    if (ev.target === stage) shut()
  })
  window.addEventListener('keydown', onKey, true)
  document.body.append(root)
  close.focus()
}

function openViewer(list: Attachment[], start: number, source: SpaceFiles): void {
  if (list.length === 0) return
  let at = Math.max(0, start)
  const img = h('img', { class: 'viewer-img' })
  const name = h('span', { class: 'viewer-name truncate' })
  const detail = h('span', { class: 'tiny faint' })
  const stage = h('div', { class: 'viewer-stage' }, [img])
  const close = h('button', { class: 'ghost icon-only', ariaLabel: 'Close', title: 'Close (Esc)' }, [icon('close', 20)])
  const save = h('button', { class: 'ghost', title: 'Save' }, [icon('download', 16), 'Save'])
  const back = h('button', { class: 'viewer-step back', ariaLabel: 'Previous picture' }, [icon('chevron-left', 22)])
  const next = h('button', { class: 'viewer-step next', ariaLabel: 'Next picture' }, [icon('chevron-right', 22)])
  const root = h('div', { class: 'viewer', role: 'dialog', ariaLabel: 'Picture' }, [
    h('div', { class: 'viewer-bar' }, [h('div', { class: 'viewer-words' }, [name, detail]), save, close]),
    stage,
    list.length > 1 ? back : null,
    list.length > 1 ? next : null,
  ])

  let touch: TouchViewer | null = null
  const show = (): void => {
    const file = list[at]
    root.classList.remove('zoomed')
    touch?.reset()
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
    leaveHistory()
  }
  const leaveHistory = closeOnBack(shut)
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
  img.addEventListener('click', (ev) => {
    ev.stopPropagation()
    // A finger zooms with two of them, or a double tap: the tap that follows a touch is not a click.
    if (touch?.touchedLately()) return
    root.classList.toggle('zoomed')
  })
  touch = touchViewer(root, stage, img, { step: list.length > 1 ? step : null, shut })
  stage.addEventListener('click', (ev) => {
    if (ev.target === stage) shut()
  })
  window.addEventListener('keydown', onKey, true)
  document.body.append(root)
  show()
  close.focus()
}

interface TouchViewer {
  reset(): void
  touchedLately(): boolean
}

/** How far a picture may be zoomed with the fingers. */
const MOST_ZOOM = 5
const DOUBLE_TAP_ZOOM = 2.5

/**
 * The picture under a finger, as a phone's photos do: pull it down to close it, push it to the
 * side for the next one, pinch or double tap to zoom in, and drag it about while zoomed in.
 */
function touchViewer(
  root: HTMLElement,
  stage: HTMLElement,
  img: HTMLImageElement,
  to: { step: ((by: number) => void) | null; shut: () => void },
): TouchViewer {
  let scale = 1
  let x = 0
  let y = 0
  let mode: 'none' | 'tap' | 'pan' | 'down' | 'side' | 'pinch' = 'none'
  let from = { x: 0, y: 0, scale: 1, tx: 0, ty: 0, gap: 1, t: 0 }
  /** The point of the picture under the fingers when a pinch started, in its own pixels from its middle. */
  let held = { x: 0, y: 0 }
  let lastTouch = 0
  let lastTap = { t: 0, x: 0, y: 0 }
  let speed = { x: 0, y: 0, t: 0, px: 0, py: 0 }

  const paint = (glide = false): void => {
    img.style.transition = glide ? 'transform 220ms var(--ease-out)' : 'none'
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }
  const fade = (by: number | null): void => {
    if (by === null) root.style.removeProperty('--viewer-fade')
    else root.style.setProperty('--viewer-fade', String(by))
  }
  const reset = (): void => {
    scale = 1
    x = 0
    y = 0
    mode = 'none'
    img.style.transition = ''
    img.style.transform = ''
    root.classList.remove('dragging')
    fade(null)
  }
  /** The middle of the picture as it is laid out, before any zoom or drag. */
  const middle = (): { x: number; y: number } => {
    const box = stage.getBoundingClientRect()
    return { x: box.left + img.offsetLeft + img.offsetWidth / 2, y: box.top + img.offsetTop + img.offsetHeight / 2 }
  }
  /** Zoomed in, the picture's edges stay at or past the stage's. */
  const keepInside = (): void => {
    const roomX = Math.max(0, (img.offsetWidth * scale - stage.clientWidth) / 2)
    const roomY = Math.max(0, (img.offsetHeight * scale - stage.clientHeight) / 2)
    const c = middle()
    const box = stage.getBoundingClientRect()
    // Measured from the stage's middle, which the picture may not sit right on.
    const offX = box.left + box.width / 2 - c.x
    const offY = box.top + box.height / 2 - c.y
    x = Math.min(offX + roomX, Math.max(offX - roomX, x))
    y = Math.min(offY + roomY, Math.max(offY - roomY, y))
    if (scale <= 1) {
      x = 0
      y = 0
    }
  }
  const zoomAt = (to: number, px: number, py: number): void => {
    const c = middle()
    const qx = (px - c.x - x) / scale
    const qy = (py - c.y - y) / scale
    scale = to
    x = px - c.x - scale * qx
    y = py - c.y - scale * qy
  }
  const pair = (ev: TouchEvent): { x: number; y: number; gap: number } => {
    const [a, b] = [ev.touches[0], ev.touches[1]]
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, gap: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1 }
  }
  const startOne = (t: Touch, at: number): void => {
    from = { ...from, x: t.clientX, y: t.clientY, tx: x, ty: y, t: at }
    speed = { x: 0, y: 0, t: at, px: t.clientX, py: t.clientY }
    mode = scale > 1 ? 'pan' : 'tap'
  }

  stage.addEventListener(
    'touchstart',
    (ev) => {
      lastTouch = Date.now()
      if (ev.touches.length >= 2) {
        const p = pair(ev)
        const c = middle()
        held = { x: (p.x - c.x - x) / scale, y: (p.y - c.y - y) / scale }
        from = { ...from, scale, gap: p.gap }
        mode = 'pinch'
        root.classList.remove('dragging')
        fade(null)
        return
      }
      startOne(ev.touches[0], ev.timeStamp)
    },
    { passive: true },
  )
  stage.addEventListener(
    'touchmove',
    (ev) => {
      if (ev.cancelable) ev.preventDefault()
      if (mode === 'pinch' && ev.touches.length >= 2) {
        const p = pair(ev)
        // A little past the ends while the fingers are on it; it springs back once they let go.
        scale = Math.min(MOST_ZOOM * 1.2, Math.max(0.6, (from.scale * p.gap) / from.gap))
        const c = middle()
        x = p.x - c.x - scale * held.x
        y = p.y - c.y - scale * held.y
        paint()
        return
      }
      const t = ev.touches[0]
      if (!t) return
      const dx = t.clientX - from.x
      const dy = t.clientY - from.y
      const dt = Math.max(1, ev.timeStamp - speed.t)
      speed = { x: (t.clientX - speed.px) / dt, y: (t.clientY - speed.py) / dt, t: ev.timeStamp, px: t.clientX, py: t.clientY }
      if (mode === 'tap') {
        if (Math.hypot(dx, dy) < 10) return
        if (Math.abs(dx) > Math.abs(dy) && to.step) mode = 'side'
        else if (dy > 0) mode = 'down'
        else {
          mode = 'none'
          return
        }
        root.classList.add('dragging')
      }
      if (mode === 'pan') {
        x = from.tx + dx
        y = from.ty + dy
        paint()
      } else if (mode === 'down') {
        x = dx * 0.5
        y = Math.max(0, dy)
        scale = Math.max(0.75, 1 - y / 1600)
        paint()
        fade(Math.max(0, 1 - y / 360))
      } else if (mode === 'side') {
        x = dx
        paint()
      }
    },
    { passive: false },
  )
  const end = (ev: TouchEvent): void => {
    lastTouch = Date.now()
    const t = ev.changedTouches[0]
    if (mode === 'pinch') {
      if (ev.touches.length >= 2) return
      scale = Math.min(MOST_ZOOM, Math.max(1, scale))
      keepInside()
      paint(true)
      // One finger still on it carries on as a drag.
      if (ev.touches.length === 1 && scale > 1) startOne(ev.touches[0], ev.timeStamp)
      else mode = 'none'
      return
    }
    if (ev.touches.length > 0) return
    const quick = ev.timeStamp - speed.t < 90
    const dx = t ? t.clientX - from.x : 0
    const dy = t ? t.clientY - from.y : 0
    const tapped = mode === 'tap' || (mode === 'pan' && Math.hypot(dx, dy) < 10)
    if (tapped && ev.type === 'touchend' && t) {
      const second = Date.now() - lastTap.t < 300 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 30
      lastTap = second ? { t: 0, x: 0, y: 0 } : { t: Date.now(), x: t.clientX, y: t.clientY }
      if (second && img.contains(ev.target as Node)) {
        if (scale > 1) {
          scale = 1
          x = 0
          y = 0
        } else {
          zoomAt(DOUBLE_TAP_ZOOM, t.clientX, t.clientY)
          keepInside()
        }
        paint(true)
      }
    } else if (mode === 'pan') {
      keepInside()
      paint(true)
    } else if (mode === 'down') {
      root.classList.remove('dragging')
      if (ev.type === 'touchend' && (dy > 120 || (quick && speed.y > 0.5))) {
        y = window.innerHeight
        paint(true)
        fade(0)
        window.setTimeout(to.shut, 200)
      } else {
        x = 0
        y = 0
        scale = 1
        paint(true)
        fade(null)
      }
    } else if (mode === 'side' && to.step) {
      root.classList.remove('dragging')
      const width = stage.clientWidth
      const flicked = quick && Math.abs(speed.x) > 0.4
      if (ev.type === 'touchend' && (Math.abs(dx) > width * 0.25 || flicked)) {
        const by = dx < 0 ? 1 : -1
        x = -by * width
        paint(true)
        window.setTimeout(() => {
          to.step?.(by)
          // The next one comes in from the other side.
          x = by * width
          paint()
          void img.offsetWidth
          x = 0
          paint(true)
        }, 180)
      } else {
        x = 0
        paint(true)
      }
    }
    mode = 'none'
  }
  stage.addEventListener('touchend', end)
  stage.addEventListener('touchcancel', end)

  return { reset, touchedLately: () => Date.now() - lastTouch < 800 }
}

interface Pending {
  chip: HTMLElement
  state: 'sending' | 'done' | 'failed'
  attachment?: Attachment
  stop: AbortController
  settled: Promise<void>
  preview?: string
}

/** A small ? that says why, on hover or when it has the keyboard. */
function whyMark(why: string): HTMLElement {
  return h('span', { class: 'why-mark', text: '?', title: why, ariaLabel: why, role: 'img', tabIndex: 0 })
}

export class AttachTray {
  readonly root = h('div', { class: 'attach-tray hidden' })
  private items: Pending[] = []
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
    const fill = h('i')
    const bar = h('span', { class: 'attach-bar', role: 'progressbar', ariaLabel: `Sending ${file.name}` }, [fill])
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', '100')
    const detail = h('span', { class: 'tiny faint truncate', text: 'Encrypting' })
    // The speed is worked out from the first byte sent, so the time spent encrypting does not count.
    let firstAt = 0
    const kind = kindOf(file)
    const item: Pending = {
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
    item.chip.append(
      face,
      h('span', { class: 'attach-words' }, [h('span', { class: 'attach-name truncate', text: file.name }), bar, detail]),
      remove,
    )
    item.settled = source
      .send(
        file,
        (done, total) => {
          const part = total ? Math.min(1, done / total) : 0
          fill.style.transform = `scaleX(${part})`
          bar.setAttribute('aria-valuenow', String(Math.floor(part * 100)))
          const now = performance.now()
          if (!firstAt && done > 0) firstAt = now
          const seconds = firstAt ? (now - firstAt) / 1000 : 0
          const speed = seconds > 0.5 ? ` · ${sizeLabel(Math.round((done / seconds) * (file.size / (total || file.size))))}/s` : ''
          detail.textContent = `${Math.floor(part * 100)}% · ${sizeLabel(Math.round(part * file.size))} of ${sizeLabel(file.size)}${speed}`
        },
        item.stop.signal,
        (words, why, part) => {
          detail.replaceChildren(words)
          if (why) detail.append(' ', whyMark(why))
          // The same bar shows the converting, then starts again from nothing for the sending.
          if (part !== undefined) fill.style.transform = `scaleX(${Math.min(1, part)})`
        },
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

  clear(): void {
    for (const item of [...this.items]) this.remove(item)
  }

  private paint(): void {
    this.root.replaceChildren(...this.items.map((i) => i.chip))
    this.root.classList.toggle('hidden', this.items.length === 0)
    this.onChange?.()
  }
}
