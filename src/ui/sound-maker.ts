import { h } from './dom'
import { openEmojiPicker } from './emoji'
import { icon } from './icons'
import { timeLabel } from './recordings'
import { CUSTOM_MAX_S, type SoundGroup } from './soundboard'
import { sharedAudio } from './sounds'

// The dialog that adds a sound to the soundboard. The sound comes from a file, or in the desktop
// app from a YouTube link, and may be longer than a sound may play: you pick the part you want on
// its waveform, hear it, and give it a name, an emoji and a group. The part is cut here, on this
// device, and goes out as a WAV file.

/** A file this big or this long is not opened: its decoded sound would fill too much memory. */
export const SOURCE_MAX_BYTES = 40 * 1024 * 1024
export const SOURCE_MAX_S = 10 * 60
/** The most a sound's file may be, as it goes out. */
export const MAX_SOUND_BYTES = 2 * 1024 * 1024

/** The shortest part, and how far the arrow keys move an end. */
const LEAST_S = 0.2
const STEP_S = 0.1
const BIG_STEP_S = 1
/** How much of a long sound the close waveform shows at once. */
const VIEW_S = 16
/** Waveform points per second of sound. */
const BIN_RATE = 200
/** A short fade at each end, so a cut in the middle of a wave does not click. */
const FADE_S = 0.008
/** 10 seconds of 16-bit stereo at this rate is 1.76 MB, inside MAX_SOUND_BYTES. */
const OUT_RATE = 44100

export interface MadeSound {
  file: File
  name: string
  emoji: string
  /** The group's id, or '' for none. */
  group: string
}

interface Source {
  buffer: AudioBuffer
  name: string
  /** The file as it came, to send as it is when all of it is kept and it is small enough. */
  file: File | null
  /** Where the part starts at first, as a YouTube link's t= says. */
  at: number
}

type YouTubeAnswer = { title: string; bytes: Uint8Array; type: string } | { error: string }

interface DesktopShell {
  youtubeAudio?: (url: string) => Promise<YouTubeAnswer>
}

/** The desktop app's way to get a YouTube video's sound, or null in a browser. */
function youtubeShell(): ((url: string) => Promise<YouTubeAnswer>) | null {
  return (window as Window & { nookDesktop?: DesktopShell }).nookDesktop?.youtubeAudio ?? null
}

/** Whether this app can get the sound of a YouTube link. */
export function canUseYouTube(): boolean {
  return youtubeShell() !== null
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'])

/** The link as a URL when it points at YouTube, else null. */
export function youtubeLink(text: string): URL | null {
  try {
    const url = new URL(text.trim())
    return url.protocol === 'https:' && YOUTUBE_HOSTS.has(url.hostname) ? url : null
  } catch {
    return null
  }
}

/** Seconds from a t= or start= of a YouTube link: "90", "90s" or "1m30s". */
export function youtubeStart(url: URL): number {
  const raw = url.searchParams.get('t') ?? url.searchParams.get('start') ?? ''
  if (/^\d+s?$/.test(raw)) return parseInt(raw, 10)
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw)
  if (!parts || !raw) return 0
  return Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0)
}

/** Decoded at OUT_RATE, so a long sound takes less memory and the cut needs no new rate. */
async function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const Offline = window.OfflineAudioContext
  if (!Offline) throw new Error('This browser cannot open sounds.')
  return new Offline(2, 1, OUT_RATE).decodeAudioData(bytes)
}

async function openSource(bytes: ArrayBuffer, name: string, file: File | null, at: number): Promise<Source> {
  if (bytes.byteLength > SOURCE_MAX_BYTES) {
    throw new Error(`Nook opens a sound of up to ${Math.round(SOURCE_MAX_BYTES / 1024 / 1024)} MB. That one is bigger.`)
  }
  let buffer: AudioBuffer
  try {
    buffer = await decode(bytes)
  } catch {
    throw new Error('That is not a sound this app can play.')
  }
  if (buffer.duration > SOURCE_MAX_S + 1) {
    throw new Error(`Nook opens a sound of up to ${SOURCE_MAX_S / 60} minutes. That one is ${timeLabel(buffer.duration)}.`)
  }
  return { buffer, name: name.replace(/\.[^.]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 24), file, at }
}

/** The loudest point of each 1/BIN_RATE of a second, over every channel. */
function peaksOf(buffer: AudioBuffer): Float32Array {
  const per = buffer.sampleRate / BIN_RATE
  const peaks = new Float32Array(Math.ceil(buffer.length / per))
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) {
      const bin = Math.floor(i / per)
      const v = Math.abs(data[i])
      if (v > peaks[bin]) peaks[bin] = v
    }
  }
  return peaks
}

function drawWave(canvas: HTMLCanvasElement, peaks: Float32Array, from: number, to: number): void {
  const scale = window.devicePixelRatio || 1
  const width = Math.round(canvas.clientWidth * scale)
  const height = Math.round(canvas.clientHeight * scale)
  if (!width || !height) return
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const g = canvas.getContext('2d')
  if (!g) return
  g.clearRect(0, 0, width, height)
  g.fillStyle = getComputedStyle(canvas).color
  // Scaled up to the loudest point, so a quiet sound still shows its shape.
  let top = 0
  for (const p of peaks) if (p > top) top = p
  const lift = top > 0 ? 1 / top : 1
  const middle = height / 2
  const bar = Math.max(1, Math.round(scale))
  for (let x = 0; x < width; x += bar + Math.max(1, Math.round(scale / 2))) {
    const a = Math.floor((from + ((to - from) * x) / width) * BIN_RATE)
    const b = Math.max(a + 1, Math.floor((from + ((to - from) * (x + bar)) / width) * BIN_RATE))
    let most = 0
    for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > most) most = peaks[i]
    const half = Math.max(scale / 2, most * lift * (middle - scale))
    g.fillRect(x, middle - half, bar, half * 2)
  }
}

/** Plain 16-bit PCM. */
function wavOf(buffer: AudioBuffer): ArrayBuffer {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const bytes = frames * channels * 2
  const out = new ArrayBuffer(44 + bytes)
  const view = new DataView(out)
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, bytes, true)
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let at = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]))
      view.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      at += 2
    }
  }
  return out
}

/** The part from `start` to `end`, faded in and out, as a WAV file. */
export async function cutPart(buffer: AudioBuffer, start: number, end: number, name: string): Promise<File> {
  const seconds = end - start
  const channels = Math.min(2, buffer.numberOfChannels)
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.ceil(seconds * OUT_RATE)), OUT_RATE)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const fade = ctx.createGain()
  fade.gain.setValueAtTime(0, 0)
  fade.gain.linearRampToValueAtTime(1, FADE_S)
  fade.gain.setValueAtTime(1, Math.max(FADE_S, seconds - FADE_S))
  fade.gain.linearRampToValueAtTime(0, seconds)
  src.connect(fade)
  fade.connect(ctx.destination)
  src.start(0, start, seconds)
  const out = await ctx.startRendering()
  return new File([wavOf(out)], `${name || 'sound'}.wav`, { type: 'audio/wav' })
}

/**
 * The waveform of a sound, with the part to keep between two handles, and a play button to hear
 * it. A sound longer than VIEW_S also gets a small waveform of all of it, to move the part along.
 */
class Trimmer {
  readonly root: HTMLElement
  private readonly peaks: Float32Array
  private readonly duration: number
  private readonly track = h('div', { class: 'clip-track sound-wave' })
  private readonly wave = h('canvas', { class: 'sound-wave-canvas' })
  private readonly chosen = h('div', { class: 'clip-chosen' })
  private readonly startHandle = h('div', { class: 'clip-handle start', tabIndex: 0, role: 'slider', ariaLabel: 'Start of the sound' })
  private readonly endHandle = h('div', { class: 'clip-handle end', tabIndex: 0, role: 'slider', ariaLabel: 'End of the sound' })
  private readonly head = h('div', { class: 'clip-playhead' })
  private readonly overview = h('div', { class: 'sound-overview' })
  private readonly overviewWave = h('canvas', { class: 'sound-wave-canvas' })
  private readonly window = h('div', { class: 'sound-overview-window' })
  private readonly playButton = h('button', { class: 'ghost icon-only', title: 'Play this part (Space)', ariaLabel: 'Play this part' }, [
    icon('play', 18),
  ])
  private readonly clock = h('span', { class: 'clip-clock tiny' })
  private readonly about = h('span', { class: 'tiny faint' })
  private start = 0
  private end = 0
  private at = 0
  private viewFrom = 0
  private playing: { src: AudioBufferSourceNode; from: number; began: number; ctx: AudioContext } | null = null
  private frame = 0
  private readonly resize = new ResizeObserver(() => this.paint())

  constructor(private readonly source: Source) {
    this.duration = source.buffer.duration
    this.peaks = peaksOf(source.buffer)
    this.start = Math.max(0, Math.min(source.at, this.duration - LEAST_S))
    this.end = Math.min(this.duration, this.start + CUSTOM_MAX_S)
    this.at = this.start
    this.viewFrom = this.fitView()
    this.track.append(this.wave, this.chosen, this.head, this.startHandle, this.endHandle)
    this.overview.append(this.overviewWave, this.window)
    const long = this.duration > VIEW_S
    this.root = h('div', { class: 'stack sound-trimmer' }, [
      long ? this.overview : null,
      this.track,
      h('div', { class: 'row clip-controls' }, [
        this.playButton,
        this.clock,
        h('span', { class: 'grow' }),
        this.about,
      ]),
    ])
    this.playButton.addEventListener('click', () => this.togglePlay())
    this.bindTrack()
    this.bindOverview()
    this.root.addEventListener('keydown', (ev) => {
      if (ev.key !== ' ' || ev.target instanceof HTMLInputElement || ev.target instanceof HTMLButtonElement) return
      ev.preventDefault()
      this.togglePlay()
    })
    this.resize.observe(this.track)
  }

  get part(): { start: number; end: number; all: boolean } {
    return { start: this.start, end: this.end, all: this.start < 0.01 && this.end > this.duration - 0.01 }
  }

  stop(): void {
    this.stopPlay()
    this.resize.disconnect()
  }

  private fitView(): number {
    if (this.duration <= VIEW_S) return 0
    const middle = (this.start + this.end) / 2
    return Math.max(0, Math.min(this.duration - VIEW_S, middle - VIEW_S / 2))
  }

  private get viewTo(): number {
    return Math.min(this.duration, this.viewFrom + VIEW_S)
  }

  private place(t: number): string {
    return `${((t - this.viewFrom) / Math.max(0.001, this.viewTo - this.viewFrom)) * 100}%`
  }

  private timeAt(clientX: number): number {
    const box = this.track.getBoundingClientRect()
    const part = Math.max(0, Math.min(1, (clientX - box.left) / Math.max(1, box.width)))
    return this.viewFrom + part * (this.viewTo - this.viewFrom)
  }

  /** The part keeps to CUSTOM_MAX_S: pulling one end past that brings the other with it. */
  private setStart(t: number): void {
    this.stopPlay()
    this.start = Math.max(0, Math.min(t, this.end - LEAST_S))
    if (this.end - this.start > CUSTOM_MAX_S) this.end = this.start + CUSTOM_MAX_S
    this.at = this.start
    this.paint()
  }

  private setEnd(t: number): void {
    this.stopPlay()
    this.end = Math.min(this.duration, Math.max(t, this.start + LEAST_S))
    if (this.end - this.start > CUSTOM_MAX_S) this.start = this.end - CUSTOM_MAX_S
    this.at = Math.max(this.start, this.end - 2)
    this.paint()
  }

  /** Moves the whole part, so its middle is at `t`. */
  private moveTo(t: number): void {
    this.stopPlay()
    const length = this.end - this.start
    this.start = Math.max(0, Math.min(this.duration - length, t - length / 2))
    this.end = this.start + length
    this.at = this.start
    this.viewFrom = this.fitView()
    this.paint()
  }

  private togglePlay(): void {
    if (this.playing) {
      this.stopPlay()
      return
    }
    const ctx = sharedAudio()
    if (!ctx) return
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    // From the head when it is inside the part, else from the start of the part.
    const from = this.at >= this.start && this.at < this.end - 0.05 ? this.at : this.start
    const src = ctx.createBufferSource()
    src.buffer = this.source.buffer
    src.connect(ctx.destination)
    src.start(0, from, this.end - from)
    src.onended = () => {
      if (this.playing?.src !== src) return
      this.stopPlay()
      this.at = this.start
      this.paint()
    }
    this.playing = { src, from, began: ctx.currentTime, ctx }
    this.paintPlay()
    const tick = (): void => {
      if (!this.playing) return
      this.at = Math.min(this.end, this.playing.from + this.playing.ctx.currentTime - this.playing.began)
      this.paintHead()
      this.frame = requestAnimationFrame(tick)
    }
    this.frame = requestAnimationFrame(tick)
  }

  private stopPlay(): void {
    if (!this.playing) return
    const { src } = this.playing
    this.playing = null
    cancelAnimationFrame(this.frame)
    try {
      src.stop()
    } catch {
      /* it had ended */
    }
    src.disconnect()
    this.paintPlay()
  }

  private paintPlay(): void {
    const on = !!this.playing
    this.playButton.replaceChildren(icon(on ? 'pause' : 'play', 18))
    this.playButton.title = on ? 'Stop (Space)' : 'Play this part (Space)'
    this.playButton.setAttribute('aria-label', on ? 'Stop' : 'Play this part')
  }

  private paintHead(): void {
    this.head.style.left = this.place(this.at)
    this.clock.textContent = `${timeLabel(this.at)} / ${timeLabel(this.duration)}`
  }

  paint(): void {
    drawWave(this.wave, this.peaks, this.viewFrom, this.viewTo)
    this.chosen.style.left = this.place(this.start)
    this.chosen.style.right = `${100 - parseFloat(this.place(this.end))}%`
    this.startHandle.style.left = this.place(this.start)
    this.endHandle.style.left = this.place(this.end)
    for (const [handle, t] of [
      [this.startHandle, this.start],
      [this.endHandle, this.end],
    ] as const) {
      handle.setAttribute('aria-valuemin', '0')
      handle.setAttribute('aria-valuemax', String(Math.round(this.duration * 10) / 10))
      handle.setAttribute('aria-valuenow', String(Math.round(t * 10) / 10))
      handle.setAttribute('aria-valuetext', `${timeLabel(t)}.${Math.floor((t % 1) * 10)}`)
    }
    if (this.duration > VIEW_S) {
      drawWave(this.overviewWave, this.peaks, 0, this.duration)
      this.window.style.left = `${(this.start / this.duration) * 100}%`
      this.window.style.width = `${Math.max(0.6, ((this.end - this.start) / this.duration) * 100)}%`
    }
    this.about.textContent = `${(this.end - this.start).toFixed(1)} s of ${CUSTOM_MAX_S} s`
    this.paintHead()
  }

  private bindTrack(): void {
    const drag = (handle: HTMLElement, move: (t: number) => void): void => {
      handle.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return
        ev.preventDefault()
        ev.stopPropagation()
        handle.setPointerCapture(ev.pointerId)
        handle.focus()
        const onMove = (e: PointerEvent): void => move(this.timeAt(e.clientX))
        const onUp = (): void => {
          handle.removeEventListener('pointermove', onMove)
          handle.removeEventListener('pointerup', onUp)
          handle.removeEventListener('pointercancel', onUp)
          // A handle pulled to the edge of the close view brings the view along.
          this.viewFrom = this.fitView()
          this.paint()
        }
        handle.addEventListener('pointermove', onMove)
        handle.addEventListener('pointerup', onUp)
        handle.addEventListener('pointercancel', onUp)
      })
    }
    drag(this.startHandle, (t) => this.setStart(t))
    drag(this.endHandle, (t) => this.setEnd(t))
    // A press on the waveform plays from there.
    this.track.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target === this.startHandle || ev.target === this.endHandle) return
      const t = this.timeAt(ev.clientX)
      this.stopPlay()
      if (t < this.start) this.setStart(t)
      else if (t > this.end) this.setEnd(t)
      this.at = t
      this.paintHead()
      this.togglePlay()
    })
    for (const [handle, set, get] of [
      [this.startHandle, (t: number) => this.setStart(t), () => this.start],
      [this.endHandle, (t: number) => this.setEnd(t), () => this.end],
    ] as const) {
      handle.addEventListener('keydown', (ev) => {
        const step = ev.shiftKey ? BIG_STEP_S : STEP_S
        const by = ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -step : ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? step : 0
        if (!by) return
        ev.preventDefault()
        ev.stopPropagation()
        set(get() + by)
        this.viewFrom = this.fitView()
        this.paint()
      })
    }
  }

  private bindOverview(): void {
    this.overview.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return
      this.overview.setPointerCapture(ev.pointerId)
      const at = (clientX: number): number => {
        const box = this.overview.getBoundingClientRect()
        return Math.max(0, Math.min(1, (clientX - box.left) / Math.max(1, box.width))) * this.duration
      }
      this.moveTo(at(ev.clientX))
      const onMove = (e: PointerEvent): void => this.moveTo(at(e.clientX))
      const onUp = (): void => {
        this.overview.removeEventListener('pointermove', onMove)
        this.overview.removeEventListener('pointerup', onUp)
        this.overview.removeEventListener('pointercancel', onUp)
      }
      this.overview.addEventListener('pointermove', onMove)
      this.overview.addEventListener('pointerup', onUp)
      this.overview.addEventListener('pointercancel', onUp)
    })
  }
}

interface MakeOptions {
  /** A file already picked. Without it, the dialog asks for a file or a YouTube link. */
  file: File | null
  groups: SoundGroup[]
  /** The group it goes in at first, or ''. */
  group: string
}

/** The sound to add, cut and named, or null when the dialog is closed. */
export function makeSound(options: MakeOptions): Promise<MadeSound | null> {
  return new Promise((resolve) => {
    const was = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let trimmer: Trimmer | null = null
    let source: Source | null = null
    let chosen = '🔊'
    let busy = false
    let closed = false

    const status = h('div', { class: 'tiny faint sound-status', role: 'status' })
    const body = h('div', { class: 'stack sound-maker-body' })
    // Shown once there is a sound to add.
    const addButton = h('button', { class: 'primary', text: 'Add', disabled: true })
    addButton.style.display = 'none'
    const name = h('input', { type: 'text', class: 'ask-input grow', ariaLabel: 'The sound\'s name', placeholder: 'Its name' })
    name.autocomplete = 'off'
    const face = h('button', { class: 'sound-face', ariaLabel: 'Its emoji', title: 'Pick its emoji', text: chosen })
    face.addEventListener('click', () =>
      openEmojiPicker({
        anchor: face,
        title: 'The sound\'s emoji',
        onPick: (picked) => {
          chosen = picked
          face.textContent = picked
          name.focus()
        },
      }),
    )
    const group = h('select', { class: 'sound-group-pick', ariaLabel: 'Its group' }, [
      h('option', { value: '', text: 'No group' }),
      ...options.groups.map((g) => h('option', { value: g.id, text: `${g.emoji} ${g.label}` })),
    ])
    group.value = options.groups.some((g) => g.id === options.group) ? options.group : ''

    const say = (text: string, bad = false): void => {
      status.textContent = text
      status.classList.toggle('bad', bad)
    }

    const show = (opened: Source): void => {
      source = opened
      trimmer?.stop()
      trimmer = new Trimmer(opened)
      if (!name.value.trim()) name.value = opened.name
      body.replaceChildren(trimmer.root, h('div', { class: 'row sound-fields' }, [face, name]))
      if (options.groups.length) body.append(h('label', { class: 'row sound-group-row tiny' }, [h('span', { class: 'faint', text: 'Group' }), group]))
      addButton.style.display = ''
      addButton.disabled = false
      say(
        opened.buffer.duration > CUSTOM_MAX_S
          ? `Pick up to ${CUSTOM_MAX_S} seconds: pull the ends, or move the part along the top.`
          : 'Pull the ends to cut it shorter.',
      )
      trimmer.paint()
      name.focus()
      name.select()
    }

    const fromFile = async (file: File): Promise<void> => {
      busy = true
      say('Opening…')
      try {
        const opened = await openSource(await file.arrayBuffer(), file.name, file, 0)
        if (!closed) show(opened)
      } catch (err) {
        say(err instanceof Error ? err.message : 'That file could not be opened.', true)
      } finally {
        busy = false
      }
    }

    const pickFile = (): void => {
      const pick = h('input', { type: 'file' })
      pick.accept = 'audio/*,video/*'
      pick.addEventListener('change', () => {
        const file = pick.files?.[0]
        if (file) void fromFile(file)
      }, { once: true })
      pick.click()
    }

    const link = h('input', { type: 'text', class: 'grow sound-link', ariaLabel: 'A YouTube link', placeholder: 'https://youtube.com/watch?v=…' })
    link.autocomplete = 'off'
    link.inputMode = 'url'
    link.spellcheck = false
    const getButton = h('button', { class: 'ghost', text: 'Get the sound' })
    const fromYouTube = async (): Promise<void> => {
      const get = youtubeShell()
      const url = youtubeLink(link.value)
      if (!get || busy) return
      if (!url) {
        say('That is not a YouTube link.', true)
        return
      }
      busy = true
      getButton.disabled = true
      say('Getting the sound from YouTube… The first time takes longer: Nook also gets yt-dlp, which does the work.')
      try {
        const answer = await get(url.href)
        if (closed) return
        if ('error' in answer) throw new Error(answer.error)
        const bytes = answer.bytes.buffer.slice(answer.bytes.byteOffset, answer.bytes.byteOffset + answer.bytes.byteLength) as ArrayBuffer
        show(await openSource(bytes, answer.title, null, youtubeStart(url)))
      } catch (err) {
        say(err instanceof Error ? err.message : 'Nook could not get that sound.', true)
      } finally {
        busy = false
        getButton.disabled = false
      }
    }
    getButton.addEventListener('click', () => void fromYouTube())
    link.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing) return
      ev.preventDefault()
      void fromYouTube()
    })

    const done = async (): Promise<void> => {
      if (!source || !trimmer || busy) return
      const label = name.value.trim()
      if (!label) {
        say('Give it a name.', true)
        name.focus()
        return
      }
      busy = true
      addButton.disabled = true
      try {
        const part = trimmer.part
        // All of a small file goes as it is; anything else is cut, and goes as WAV.
        const file =
          part.all && source.file && source.file.size <= MAX_SOUND_BYTES && source.buffer.duration <= CUSTOM_MAX_S + 0.5
            ? source.file
            : await cutPart(source.buffer, part.start, part.end, label)
        finish({ file, name: label, emoji: chosen, group: group.value })
      } catch {
        say('Nook could not cut that sound.', true)
        busy = false
        addButton.disabled = false
      }
    }
    addButton.addEventListener('click', () => void done())

    const finish = (answer: MadeSound | null): void => {
      if (document.querySelector('.emoji-pop')) return
      closed = true
      trimmer?.stop()
      scrim.remove()
      window.removeEventListener('keydown', onKey, true)
      was?.focus()
      resolve(answer)
    }
    const onKey = (ev: KeyboardEvent): void => {
      // The emoji picker takes its own Escape and Enter while it is open.
      if (document.querySelector('.emoji-pop')) return
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        finish(null)
      } else if (ev.key === 'Enter' && !ev.isComposing && document.activeElement === name) {
        ev.preventDefault()
        void done()
      }
    }

    if (!options.file) {
      body.append(
        h('div', { class: 'stack sound-source' }, [
          h('button', { class: 'ghost sound-source-file', on: { click: pickFile } }, [icon('file', 16), 'Choose a sound or video file']),
          youtubeShell()
            ? h('div', { class: 'stack sound-source-link' }, [
                h('span', { class: 'tiny faint', text: 'Or take it from a YouTube video, of up to 10 minutes' }),
                h('div', { class: 'row sound-link-row' }, [link, getButton]),
              ])
            : null,
        ]),
      )
    }

    const scrim = h('div', { class: 'scrim', on: { click: (ev) => ev.target === scrim && finish(null) } }, [
      h('div', { class: 'modal ask-modal sound-maker', role: 'dialog', ariaLabel: 'Add a sound' }, [
        h('div', { class: 'invite-head' }, [
          h('div', { class: 'invite-words' }, [h('div', { class: 'invite-title', text: 'Add a sound' })]),
          h('button', { class: 'ghost icon-only', ariaLabel: 'Close', on: { click: () => finish(null) } }, [icon('close', 18)]),
        ]),
        body,
        status,
        h('div', { class: 'row ask-buttons' }, [
          h('button', { class: 'ghost', text: 'Cancel', on: { click: () => finish(null) } }),
          addButton,
        ]),
      ]),
    ])
    window.addEventListener('keydown', onKey, true)
    document.body.append(scrim)
    if (options.file) void fromFile(options.file)
    else (youtubeShell() ? link : scrim.querySelector<HTMLElement>('.sound-source-file'))?.focus()
  })
}
