import { ClipRefused, clipName, longestClip, makeClip } from '../media/clip'
import { saveFile, sizeLabel } from '../net/files'
import { steamPicture } from '../net/playing'
import {
  addRecordingFolder,
  isSteam,
  listRecordings,
  recordingFolders,
  recordingIndex,
  recordingName,
  removeRecordingFolder,
  restoreRecordingFolders,
  showRecording,
  type Recording,
  type RecordingFolder,
  type RecordingIndex,
} from '../net/recordings'
import { clear, h } from './dom'
import { icon } from './icons'
import { toast } from './toast'

/**
 * Your recordings, and a clip from one of them. The list comes from the desktop app: Steam's
 * recordings, NVIDIA's, and any folder you add. Pick one, drag the two ends to the part you
 * want, and Add to message puts the clip in the message box, as a file you dropped would be.
 */

interface RecordingsOptions {
  /** The server's limit for one file, in bytes. */
  max: number
  /** The clip, made. It goes in the message box. */
  onClip: (file: File) => void
}

/** A part longer than this starts as its last this many seconds: what just happened. */
const FIRST_PART_S = 30
/** Always this much of a clip, so the two ends never cross. */
const LEAST_PART_S = 1
/** How far a key moves an end. Shift moves it further. */
const STEP_S = 0.5
const BIG_STEP_S = 5

export function openRecordings(options: RecordingsOptions): void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let editor: ClipEditor | null = null
  const body = h('div', { class: 'recordings-body' })
  const box = h('div', { class: 'modal recordings-modal', role: 'dialog', ariaLabel: 'Your recordings' })
  const scrim = h('div', { class: 'scrim', on: { click: (ev) => ev.target === scrim && close() } }, [box])

  const close = (): void => {
    editor?.stop()
    editor = null
    scrim.remove()
    window.removeEventListener('keydown', onKey, true)
    previous?.focus()
  }
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    ev.stopPropagation()
    // Out of the clip first, then out of the list.
    if (editor) showList()
    else close()
  }

  let all: Recording[] = []
  let only = ''
  const head = h('div', { class: 'recordings-head' })
  const filters = h('div', { class: 'row wrap recordings-filters' })
  const grid = h('div', { class: 'recordings-grid' })
  const folders = h('div', { class: 'recordings-folders hidden' })

  const showList = (): void => {
    editor?.stop()
    editor = null
    clear(head)
    head.append(
      h('div', { class: 'invite-words' }, [
        h('div', { class: 'invite-title', text: 'Your recordings' }),
        h('div', { class: 'tiny faint', text: 'From Steam, NVIDIA and your folders. Pick one to make a clip.' }),
      ]),
      h('button', {
        class: 'ghost icon-only',
        title: 'Look again',
        ariaLabel: 'Look again',
        on: { click: () => void load() },
      }, [icon('refresh', 17)]),
      h('button', {
        class: 'ghost icon-only',
        title: 'Where Nook looks',
        ariaLabel: 'Where Nook looks',
        on: {
          click: () => {
            folders.classList.toggle('hidden')
            if (!folders.classList.contains('hidden')) void paintFolders(folders, () => void load())
          },
        },
      }, [icon('settings', 17)]),
      h('button', { class: 'ghost icon-only', ariaLabel: 'Close', title: 'Close', on: { click: () => close() } }, [icon('close', 18)]),
    )
    body.replaceChildren(folders, filters, grid)
  }

  const paintGrid = (): void => {
    clear(grid)
    const shown = only ? all.filter((r) => r.source === only) : all
    for (const rec of shown) grid.append(card(rec, () => openClip(rec)))
  }

  const paintFilters = (): void => {
    clear(filters)
    const sources = [...new Set(all.map((r) => r.source))]
    if (sources.length < 2) return
    for (const source of ['', ...sources]) {
      const chip = h('button', {
        class: `chip-toggle${only === source ? ' on' : ''}`,
        text: source || 'All',
        on: {
          click: () => {
            only = source
            paintFilters()
            paintGrid()
          },
        },
      })
      chip.setAttribute('aria-pressed', String(only === source))
      filters.append(chip)
    }
  }

  const load = async (): Promise<void> => {
    grid.replaceChildren(h('div', { class: 'recordings-empty faint', text: 'Looking for recordings…' }))
    all = await listRecordings()
    if (only && !all.some((r) => r.source === only)) only = ''
    paintFilters()
    if (all.length === 0) {
      clear(grid)
      grid.append(await emptyState(() => void load()))
      return
    }
    paintGrid()
  }

  const openClip = (rec: Recording): void => {
    editor?.stop()
    clear(head)
    head.append(
      h('button', { class: 'ghost small', on: { click: () => showList() } }, [icon('chevron-left', 15), 'Recordings']),
      h('div', { class: 'invite-words grow' }, [
        h('div', { class: 'invite-title truncate', text: recordingName(rec) }),
        h('div', { class: 'tiny faint truncate', text: `${rec.source} · ${whenLabel(rec.at)}` }),
      ]),
      h('button', { class: 'ghost icon-only', ariaLabel: 'Close', title: 'Close', on: { click: () => close() } }, [icon('close', 18)]),
    )
    editor = new ClipEditor(rec, options.max, (file) => {
      options.onClip(file)
      close()
      toast('The clip is in your message. Send it when you are ready.', 'good')
    })
    body.replaceChildren(editor.root)
    editor.focus()
  }

  box.append(head, body)
  showList()
  window.addEventListener('keydown', onKey, true)
  document.body.append(scrim)
  void load()
}

/** Nothing found: where Nook looked, and how to add a folder. */
async function emptyState(reload: () => void): Promise<HTMLElement> {
  const found = await recordingFolders()
  const steam = found.some((f) => f.kind === 'steam' && f.exists)
  return h('div', { class: 'recordings-empty stack tight' }, [
    icon('video', 28),
    h('strong', { text: 'No recordings yet' }),
    h('span', {
      class: 'tiny faint',
      text: steam
        ? 'Nook looks in your Steam recordings. Turn on Game Recording in Steam, Settings, or add the folder where your clips go.'
        : 'Add the folder where your recordings go: Steam, NVIDIA, OBS, or any folder of videos.',
    }),
    h('button', {
      class: 'primary',
      on: {
        click: async () => {
          if (await addRecordingFolder()) reload()
        },
      },
    }, [icon('plus', 15), 'Add a folder']),
  ])
}

/** The folders Nook looks in, with Remove, Add a folder, and Bring back the found ones. */
export async function paintFolders(into: HTMLElement, changed?: () => void): Promise<void> {
  const draw = (list: RecordingFolder[], hiddenSome: boolean): void => {
    clear(into)
    if (list.length === 0) into.append(h('div', { class: 'tiny faint', text: 'Nook looks in no folder yet.' }))
    for (const folder of list) {
      const sub = folder.exists ? folder.path : `${folder.path} (not there now)`
      into.append(
        h('div', { class: 'recording-folder row' }, [
          h('span', { class: `folder-kind ${folder.kind}`, text: folder.label }),
          h('span', { class: 'grow truncate tiny faint', text: sub, title: folder.path }),
          folder.found ? h('span', { class: 'pill', text: 'Found', title: 'Nook found this one by itself' }) : null,
          h('button', {
            class: 'ghost tiny-btn',
            text: 'Remove',
            on: {
              click: async () => {
                draw(await removeRecordingFolder(folder.path), hiddenSome || folder.found)
                changed?.()
              },
            },
          }),
        ]),
      )
    }
    into.append(
      h('div', { class: 'row wrap' }, [
        h('button', {
          class: 'ghost small start',
          on: {
            click: async () => {
              const next = await addRecordingFolder()
              if (!next) return
              draw(next, hiddenSome)
              changed?.()
            },
          },
        }, [icon('plus', 14), 'Add a folder']),
        hiddenSome
          ? h('button', {
              class: 'ghost small',
              text: 'Bring back the found ones',
              on: {
                click: async () => {
                  draw(await restoreRecordingFolders(), false)
                  changed?.()
                },
              },
            })
          : null,
      ]),
    )
  }
  into.replaceChildren(h('div', { class: 'tiny faint', text: 'Looking…' }))
  draw(await recordingFolders(), false)
}

function card(rec: Recording, open: () => void): HTMLElement {
  const face = h('div', { class: 'recording-face' })
  if (rec.thumb) {
    const img = h('img', { class: 'recording-picture' })
    img.src = rec.thumb
    img.alt = ''
    face.append(img)
  } else if (rec.appId) {
    const img = h('img', { class: 'recording-picture steam' })
    img.src = steamPicture(rec.appId)
    img.alt = ''
    img.onerror = () => img.remove()
    face.append(img)
  } else if (!isSteam(rec)) {
    face.append(frameOf(rec.url))
  }
  face.append(icon('play', 26))
  if (rec.duration) face.append(h('span', { class: 'recording-length', text: timeLabel(rec.duration) }))
  face.append(h('span', { class: 'recording-source', text: rec.live ? `${rec.source} · recording` : sourceWords(rec) }))
  const button = h('button', { class: 'recording-card', title: `Make a clip of ${recordingName(rec)}`, on: { click: open } }, [
    face,
    h('span', { class: 'recording-words' }, [
      h('span', { class: 'recording-title truncate', text: recordingName(rec) }),
      h('span', { class: 'tiny faint truncate', text: `${whenLabel(rec.at)} · ${sizeLabel(rec.size)}` }),
    ]),
  ])
  return button
}

function sourceWords(rec: Recording): string {
  if (rec.kind === 'steam-clip') return 'Steam clip'
  if (rec.kind === 'steam-background') return 'Steam'
  return rec.source
}

/** A frame from a plain video, loaded only once its card is in view. */
function frameOf(url: string): HTMLElement {
  const video = h('video', { class: 'recording-picture' })
  video.muted = true
  video.preload = 'none'
  video.playsInline = true
  const seen = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return
    seen.disconnect()
    video.preload = 'metadata'
    // A little way in: the first frame is often black.
    video.src = `${url}#t=2`
  })
  seen.observe(video)
  return video
}

/**
 * Picks a part of one recording, and makes the clip. The picture plays through a video element:
 * a plain file as it is, and a Steam recording a piece at a time through a MediaSource.
 */
class ClipEditor {
  readonly root: HTMLElement
  private readonly video = h('video', { class: 'clip-video' })
  private readonly track = h('div', { class: 'clip-track' })
  private readonly chosen = h('div', { class: 'clip-chosen' })
  private readonly startHandle = h('div', { class: 'clip-handle start', tabIndex: 0, role: 'slider', ariaLabel: 'Start of the clip' })
  private readonly endHandle = h('div', { class: 'clip-handle end', tabIndex: 0, role: 'slider', ariaLabel: 'End of the clip' })
  private readonly head = h('div', { class: 'clip-playhead' })
  private readonly playButton = h('button', { class: 'ghost icon-only', title: 'Play the clip (Space)', ariaLabel: 'Play the clip' }, [icon('play', 18)])
  private readonly clock = h('span', { class: 'clip-clock tiny', text: '0:00' })
  private readonly about = h('span', { class: 'tiny faint clip-about' })
  private readonly shareButton = h('button', { class: 'primary' }, [icon('send', 15), 'Add to message'])
  private readonly saveButton = h('button', { class: 'ghost' }, [icon('download', 15), 'Save clip'])
  private readonly bar = h('span', { class: 'attach-bar clip-progress hidden', role: 'progressbar' }, [h('i')])
  private readonly note = h('div', { class: 'tiny faint clip-note' })
  private player: PiecePlayer | null = null
  private duration = 0
  /** Where nought is in the video element's own time. */
  private base = 0
  private start = 0
  private end = 0
  private working: AbortController | null = null
  private stopped = false

  constructor(
    private readonly rec: Recording,
    private readonly max: number,
    private readonly done: (file: File) => void,
  ) {
    this.video.playsInline = true
    this.video.preload = 'auto'
    this.track.append(this.chosen, this.head, this.startHandle, this.endHandle)
    this.root = h('div', { class: 'clip-editor stack' }, [
      h('div', { class: 'clip-stage' }, [this.video]),
      h('div', { class: 'row clip-controls' }, [
        this.playButton,
        this.clock,
        h('span', { class: 'grow' }),
        h('button', { class: 'ghost small', title: 'The start is here (I)', on: { click: () => this.setStart(this.now()) } }, ['Start here']),
        h('button', { class: 'ghost small', title: 'The end is here (O)', on: { click: () => this.setEnd(this.now()) } }, ['End here']),
      ]),
      this.track,
      h('div', { class: 'row wrap clip-foot' }, [
        this.about,
        h('span', { class: 'grow' }),
        h('button', {
          class: 'ghost small',
          title: 'Open the folder that holds it',
          on: { click: () => showRecording(this.rec.id) },
        }, ['Show in folder']),
        this.saveButton,
        this.shareButton,
      ]),
      this.bar,
      this.note,
    ])
    this.playButton.addEventListener('click', () => this.togglePlay())
    this.shareButton.addEventListener('click', () => void this.make(true))
    this.saveButton.addEventListener('click', () => void this.make(false))
    this.bindTrack()
    this.bindKeys()
    this.video.addEventListener('timeupdate', () => this.onTime())
    this.video.addEventListener('play', () => this.paintPlay())
    this.video.addEventListener('pause', () => this.paintPlay())
    void this.load()
  }

  focus(): void {
    this.playButton.focus()
  }

  stop(): void {
    this.stopped = true
    this.working?.abort()
    this.player?.stop()
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
  }

  private async load(): Promise<void> {
    this.note.textContent = 'Opening…'
    if (isSteam(this.rec)) {
      const index = await recordingIndex(this.rec.id)
      if (this.stopped) return
      if (!index || index.fragments.length === 0) {
        this.note.textContent = 'Nook could not read this recording. Steam may still be writing it.'
        this.shareButton.disabled = true
        this.saveButton.disabled = true
        return
      }
      this.base = index.base
      this.duration = index.duration
      if (PiecePlayer.plays(index)) {
        this.player = new PiecePlayer(this.video, this.rec.url, index)
      } else {
        this.note.textContent = 'This computer cannot show this recording, but Nook can still make a clip of it.'
      }
    } else {
      this.video.src = this.rec.url
      await new Promise<void>((ok) => {
        this.video.addEventListener('loadedmetadata', () => ok(), { once: true })
        this.video.addEventListener('error', () => ok(), { once: true })
      })
      if (this.stopped) return
      this.duration = Number.isFinite(this.video.duration) ? this.video.duration : (this.rec.duration ?? 0)
      if (this.video.error) this.note.textContent = 'This computer cannot show this video, but Nook can still make a clip of it.'
    }
    if (!this.duration) this.duration = this.rec.duration ?? 0
    if (this.note.textContent === 'Opening…') this.note.textContent = ''
    // What just happened: the end of a long recording, or all of a short one.
    this.end = this.duration
    this.start = this.duration > FIRST_PART_S * 2 ? this.duration - FIRST_PART_S : 0
    this.seek(this.start)
    this.paint()
  }

  private now(): number {
    return Math.max(0, Math.min(this.duration, this.video.currentTime - this.base))
  }

  private seek(t: number): void {
    const at = Math.max(0, Math.min(this.duration, t))
    this.video.currentTime = this.base + at
    this.player?.seek(at)
    this.paintHead(at)
  }

  private setStart(t: number): void {
    this.start = Math.max(0, Math.min(t, this.end - LEAST_PART_S))
    this.seek(this.start)
    this.paint()
  }

  private setEnd(t: number): void {
    this.end = Math.min(this.duration, Math.max(t, this.start + LEAST_PART_S))
    this.seek(Math.max(this.start, this.end - 3))
    this.paint()
  }

  private togglePlay(): void {
    if (!this.video.paused) {
      this.video.pause()
      return
    }
    // From the start when the head is outside the clip, as a clip player does.
    const t = this.now()
    if (t < this.start || t >= this.end - 0.05) this.seek(this.start)
    void this.video.play().catch(() => undefined)
  }

  private onTime(): void {
    const t = this.now()
    this.player?.pump(t)
    if (!this.video.paused && t >= this.end) {
      this.video.pause()
      this.seek(this.start)
    }
    this.paintHead(t)
  }

  private paintPlay(): void {
    const playing = !this.video.paused
    this.playButton.replaceChildren(icon(playing ? 'pause' : 'play', 18))
    this.playButton.title = playing ? 'Pause (Space)' : 'Play the clip (Space)'
    this.playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play the clip')
  }

  private place(t: number): string {
    return `${this.duration ? (t / this.duration) * 100 : 0}%`
  }

  private paintHead(t: number): void {
    this.head.style.left = this.place(t)
    this.clock.textContent = `${timeLabel(t)} / ${timeLabel(this.duration)}`
  }

  private paint(): void {
    this.chosen.style.left = this.place(this.start)
    this.chosen.style.right = `${100 - parseFloat(this.place(this.end))}%`
    this.startHandle.style.left = this.place(this.start)
    this.endHandle.style.left = this.place(this.end)
    for (const [handle, t] of [
      [this.startHandle, this.start],
      [this.endHandle, this.end],
    ] as const) {
      handle.setAttribute('aria-valuemin', '0')
      handle.setAttribute('aria-valuemax', String(Math.round(this.duration)))
      handle.setAttribute('aria-valuenow', String(Math.round(t)))
      handle.setAttribute('aria-valuetext', timeLabel(t))
    }
    const seconds = this.end - this.start
    const guess = this.duration ? (this.rec.size * seconds) / this.duration : this.rec.size
    const tooLong = seconds > longestClip(this.max)
    const fits = guess <= this.max * 0.9
    this.about.textContent = tooLong
      ? `${timeLabel(seconds)} is too long for this server. Pick ${longestClip(this.max)} seconds or less.`
      : `Clip ${timeLabel(this.start)} to ${timeLabel(this.end)} · ${timeLabel(seconds)} · ${
          fits ? `about ${sizeLabel(guess)}` : `made smaller to fit ${sizeLabel(this.max)}`
        }`
    this.about.classList.toggle('bad', tooLong)
    this.shareButton.disabled = tooLong || !this.duration
    this.saveButton.disabled = tooLong || !this.duration
  }

  private timeAt(clientX: number): number {
    const box = this.track.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - box.left) / Math.max(1, box.width))) * this.duration
  }

  private bindTrack(): void {
    const drag = (handle: HTMLElement, move: (t: number) => void): void => {
      handle.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return
        ev.preventDefault()
        ev.stopPropagation()
        handle.setPointerCapture(ev.pointerId)
        handle.focus()
        this.video.pause()
        const onMove = (e: PointerEvent): void => move(this.timeAt(e.clientX))
        const onUp = (): void => {
          handle.removeEventListener('pointermove', onMove)
          handle.removeEventListener('pointerup', onUp)
          handle.removeEventListener('pointercancel', onUp)
        }
        handle.addEventListener('pointermove', onMove)
        handle.addEventListener('pointerup', onUp)
        handle.addEventListener('pointercancel', onUp)
      })
    }
    drag(this.startHandle, (t) => this.setStart(t))
    drag(this.endHandle, (t) => this.setEnd(t))
    // A press on the track moves the head there, and a drag scrubs.
    this.track.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target !== this.track && ev.target !== this.chosen && ev.target !== this.head) return
      this.track.setPointerCapture(ev.pointerId)
      this.seek(this.timeAt(ev.clientX))
      const onMove = (e: PointerEvent): void => this.seek(this.timeAt(e.clientX))
      const onUp = (): void => {
        this.track.removeEventListener('pointermove', onMove)
        this.track.removeEventListener('pointerup', onUp)
      }
      this.track.addEventListener('pointermove', onMove)
      this.track.addEventListener('pointerup', onUp)
    })
    for (const [handle, set, get] of [
      [this.startHandle, (t: number) => this.setStart(t), () => this.start],
      [this.endHandle, (t: number) => this.setEnd(t), () => this.end],
    ] as const) {
      handle.addEventListener('keydown', (ev) => {
        const step = ev.shiftKey ? BIG_STEP_S : STEP_S
        const by = ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -step : ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? step : 0
        if (by) {
          ev.preventDefault()
          ev.stopPropagation()
          set(get() + by)
        } else if (ev.key === 'Home') {
          ev.preventDefault()
          set(0)
        } else if (ev.key === 'End') {
          ev.preventDefault()
          set(this.duration)
        }
      })
    }
  }

  private bindKeys(): void {
    this.root.addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.ctrlKey || ev.metaKey || ev.altKey) return
      const key = ev.key.toLowerCase()
      if (key === ' ' && !(ev.target instanceof HTMLButtonElement)) {
        ev.preventDefault()
        this.togglePlay()
      } else if (key === 'i') {
        ev.preventDefault()
        this.setStart(this.now())
      } else if (key === 'o') {
        ev.preventDefault()
        this.setEnd(this.now())
      }
    })
  }

  private async make(share: boolean): Promise<void> {
    if (this.working) return
    this.video.pause()
    const stop = new AbortController()
    this.working = stop
    this.shareButton.disabled = true
    this.saveButton.disabled = true
    const fill = this.bar.firstElementChild as HTMLElement
    this.bar.classList.remove('hidden')
    fill.style.transform = 'scaleX(0)'
    const source = { url: this.rec.url, title: recordingName(this.rec), size: this.rec.size, duration: this.duration || null, at: this.rec.at }
    try {
      const file = await makeClip(
        source,
        { start: this.base + this.start, end: this.base + this.end },
        {
          max: this.max,
          signal: stop.signal,
          onPart: (part, doing) => {
            fill.style.transform = `scaleX(${Math.min(1, part)})`
            this.note.textContent = `${doing} · ${Math.floor(part * 100)}%`
          },
        },
      )
      if (this.stopped) return
      this.note.textContent = `${file.name} · ${sizeLabel(file.size)}`
      if (share) this.done(file)
      else saveFile(file, clipName(source))
    } catch (err) {
      if (this.stopped || stop.signal.aborted) return
      console.warn('[nook] a clip was not made', err)
      this.note.textContent = ''
      toast(err instanceof ClipRefused ? err.message : 'Nook could not make that clip.', 'bad', 8000)
    } finally {
      this.working = null
      this.bar.classList.add('hidden')
      if (!this.stopped) this.paint()
    }
  }
}

/**
 * Plays a Steam recording a piece at a time, the way Steam wrote it: the pieces near the play
 * head go into a MediaSource, and the ones long behind it come out, so an hour of recording
 * never sits in memory.
 */
class PiecePlayer {
  /** Pieces this far ahead of the head are loaded before they are needed. */
  private static readonly AHEAD_S = 25
  /** Pieces this far behind the head are let go. */
  private static readonly BEHIND_S = 30
  /** One read carries pieces up to this size. */
  private static readonly READ_BYTES = 6 * 1024 * 1024

  private readonly source = new MediaSource()
  private readonly objectUrl: string
  private buffer: SourceBuffer | null = null
  /** The next piece to load, by its place in the index. */
  private next = 0
  private busy = false
  private stopped = false
  private generation = 0
  private wanted = 0

  static plays(index: RecordingIndex): boolean {
    return typeof MediaSource !== 'undefined' && !!index.codecs && MediaSource.isTypeSupported(mime(index))
  }

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly url: string,
    private readonly index: RecordingIndex,
  ) {
    this.objectUrl = URL.createObjectURL(this.source)
    this.video.src = this.objectUrl
    this.source.addEventListener('sourceopen', () => void this.open(), { once: true })
  }

  private async open(): Promise<void> {
    if (this.stopped) return
    const buffer = this.source.addSourceBuffer(mime(this.index))
    this.buffer = buffer
    this.source.duration = this.index.base + this.index.duration
    const { offset, size } = this.index.init
    await this.append(await this.read(offset, offset + size))
    this.pump(this.wanted)
  }

  stop(): void {
    this.stopped = true
    URL.revokeObjectURL(this.objectUrl)
  }

  /** Goes to `t`: the pieces from the key frame before it, if they are not in already. */
  seek(t: number): void {
    this.wanted = t
    if (!this.buffer || this.has(t)) {
      this.pump(t)
      return
    }
    this.next = this.startFor(t)
    this.generation++
    this.pump(t)
  }

  /** Loads what is needed ahead of `t`, one read at a time. */
  pump(t: number): void {
    this.wanted = t
    if (this.stopped || this.busy || !this.buffer) return
    const frags = this.index.fragments
    if (this.next >= frags.length || frags[this.next].t > t + PiecePlayer.AHEAD_S) return
    void this.loadMore(t)
  }

  private has(t: number): boolean {
    const at = this.index.base + t
    const ranges = this.buffer?.buffered
    if (!ranges) return false
    for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= at + 0.05 && at < ranges.end(i) - 0.5) return true
    return false
  }

  /** The place of the key piece at or before `t`, with any sound piece that starts just before it. */
  private startFor(t: number): number {
    const frags = this.index.fragments
    let at = 0
    for (let i = 0; i < frags.length; i++) {
      if (frags[i].t > t) break
      if (frags[i].video && frags[i].key) at = i
    }
    const keyT = frags[at]?.t ?? 0
    while (at > 0 && !frags[at - 1].video && frags[at - 1].t > keyT - 2.5) at--
    return at
  }

  /** The next key piece after the one at `from`, where the picture can go on. */
  private skipFrom(from: number): number {
    const frags = this.index.fragments
    let at = from + 1
    while (at < frags.length && !(frags[at].video && frags[at].key)) at++
    return at
  }

  private async loadMore(t: number): Promise<void> {
    this.busy = true
    const generation = this.generation
    try {
      const frags = this.index.fragments
      const first = frags[this.next]
      let last = this.next
      while (last + 1 < frags.length && frags[last + 1].offset + frags[last + 1].size - first.offset <= PiecePlayer.READ_BYTES) last++
      const end = frags[last].offset + frags[last].size
      const bytes = await this.read(first.offset, end)
      if (this.stopped || generation !== this.generation) return
      await this.letGo(t)
      await this.append(bytes)
      if (generation !== this.generation) return
      this.next = last + 1
      if (this.next >= frags.length && this.source.readyState === 'open') this.source.endOfStream()
    } catch (err) {
      // Steam took those pieces away, as it does with the oldest of a background recording: past them.
      if (!this.stopped) console.warn('[nook] a piece of the recording did not load', err)
      if (generation === this.generation) this.next = Math.min(this.index.fragments.length, this.skipFrom(this.next))
    } finally {
      this.busy = false
    }
    if (!this.stopped) this.pump(this.wanted)
  }

  /** Takes out what is long behind the head, so a long recording does not fill the memory. */
  private async letGo(t: number): Promise<void> {
    const buffer = this.buffer
    if (!buffer || buffer.buffered.length === 0) return
    const at = this.index.base + t
    const ranges = buffer.buffered
    if (ranges.start(0) < at - PiecePlayer.BEHIND_S) await this.whenDone(() => buffer.remove(0, at - PiecePlayer.BEHIND_S))
    // Far ahead is left over from before a jump back. It loads again when the head gets there.
    const far = at + PiecePlayer.AHEAD_S * 2
    if (ranges.length && ranges.end(ranges.length - 1) > far + 10) await this.whenDone(() => buffer.remove(far, Infinity))
  }

  private async append(bytes: ArrayBuffer): Promise<void> {
    const buffer = this.buffer
    if (!buffer) return
    try {
      await this.whenDone(() => buffer.appendBuffer(bytes))
    } catch (err) {
      // Full: take out everything but what is round the head, and try once more.
      if (!(err instanceof DOMException) || err.name !== 'QuotaExceededError') throw err
      const at = this.index.base + this.wanted
      await this.whenDone(() => buffer.remove(0, Math.max(0, at - 2)))
      const ahead = at + PiecePlayer.AHEAD_S
      if (ahead < this.source.duration) await this.whenDone(() => buffer.remove(ahead, Infinity))
      await this.whenDone(() => buffer.appendBuffer(bytes))
    }
  }

  private whenDone(work: () => void): Promise<void> {
    const buffer = this.buffer!
    return new Promise((ok, fail) => {
      const done = (): void => {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', failed)
        ok()
      }
      const failed = (): void => {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', failed)
        fail(new Error('The browser would not take that piece.'))
      }
      buffer.addEventListener('updateend', done)
      buffer.addEventListener('error', failed)
      try {
        work()
      } catch (err) {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', failed)
        fail(err)
      }
    })
  }

  private async read(from: number, to: number): Promise<ArrayBuffer> {
    const res = await fetch(this.url, { headers: { range: `bytes=${from}-${to - 1}` } })
    if (!res.ok) throw new Error(`The desktop app said ${res.status}.`)
    const bytes = await res.arrayBuffer()
    // A server that sends the whole file for a range: the part asked for.
    return res.status === 200 && bytes.byteLength > to - from ? bytes.slice(from, to) : bytes
  }
}

function mime(index: RecordingIndex): string {
  return `video/mp4; codecs="${index.codecs}"`
}

export function timeLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const rest = String(s % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

function whenLabel(at: number): string {
  const when = new Date(at)
  const today = new Date()
  const sameDay = when.toDateString() === today.toDateString()
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today, ${time}`
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (when.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`
  return `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: when.getFullYear() === today.getFullYear() ? undefined : 'numeric' })}, ${time}`
}
