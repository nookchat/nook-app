import { h } from './dom'
import { icon, type IconName } from './icons'

const HIDE_AFTER_MS = 2200
const STEP_SECONDS = 5

// One volume for every player, so a second video starts as loud as the last one was left.
let volume = 1
let muted = false

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const s = Math.floor(seconds)
  const hours = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = String(s % 60).padStart(2, '0')
  return hours ? `${hours}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`
}

function iconButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
  return h('button', { class: 'icon-only', title, ariaLabel: title, on: { click: onClick } }, [icon(name, 18)])
}

function setIcon(button: HTMLButtonElement, name: IconName, title: string): void {
  if (button.dataset.icon !== name) {
    button.dataset.icon = name
    button.replaceChildren(icon(name, 18))
  }
  button.title = title
  button.setAttribute('aria-label', title)
}

export interface VideoPlayer {
  root: HTMLDivElement
  video: HTMLVideoElement
}

// A video with controls drawn in the style of the app, in place of the browser's own.
// knownDuration covers a stream that does not say how long it is.
export function videoPlayer(label: string, knownDuration = 0): VideoPlayer {
  const video = h('video', { class: 'att-player' })
  video.playsInline = true
  video.preload = 'auto'
  video.volume = volume
  video.muted = muted

  const playButton = iconButton('play', 'Play (K)', () => toggle())
  const time = h('span', { class: 'vp-time', text: `0:00 / ${clock(knownDuration)}` })

  const buffered = h('span', { class: 'vp-buffered' })
  const played = h('span', { class: 'vp-played' })
  const thumb = h('span', { class: 'vp-thumb' })
  const hoverTime = h('span', { class: 'vp-hover-time' })
  const track = h('div', { class: 'vp-track', role: 'slider', tabIndex: 0, ariaLabel: 'Seek' }, [
    h('span', { class: 'vp-rail' }, [buffered, played]),
    thumb,
    hoverTime,
  ])

  const muteButton = iconButton('volume', 'Mute (M)', () => {
    video.muted = !video.muted
    if (!video.muted && video.volume === 0) video.volume = 1
  })
  const volumeInput = h('input', {
    class: 'vp-volume',
    type: 'range',
    min: '0',
    max: '100',
    step: '1',
    ariaLabel: 'Volume',
    on: {
      input: () => {
        video.volume = Number(volumeInput.value) / 100
        video.muted = video.volume === 0
      },
    },
  })

  const extras: HTMLElement[] = []
  if ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) {
    const pip = iconButton('pip', 'Picture in picture', () => {
      const leave = document.pictureInPictureElement === video
      void (leave ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(() => undefined)
    })
    pip.classList.add('vp-pip')
    extras.push(pip)
  }
  const fullButton = iconButton('expand', 'Fullscreen (F)', () => void toggleFullscreen())
  extras.push(fullButton)

  const bar = h('div', { class: 'vp-bar' }, [
    playButton,
    time,
    track,
    h('div', { class: 'vp-sound' }, [muteButton, volumeInput]),
    ...extras,
  ])
  const bigPlay = h('span', { class: 'att-play vp-big' }, [icon('play', 22)])
  const spinner = h('span', { class: 'vp-spinner' })
  const root = h('div', { class: 'vp paused', tabIndex: 0, role: 'group', ariaLabel: label }, [video, bigPlay, spinner, bar])

  const duration = (): number => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : knownDuration)

  function toggle(): void {
    if (video.paused || video.ended) void video.play().catch(() => undefined)
    else video.pause()
  }

  function seekTo(seconds: number): void {
    const total = duration()
    if (!total) return
    video.currentTime = Math.max(0, Math.min(total, seconds))
    drawTime()
  }

  function drawTime(): void {
    const total = duration()
    const at = video.currentTime
    const part = total ? Math.min(1, at / total) : 0
    played.style.transform = `scaleX(${part})`
    thumb.style.left = `${part * 100}%`
    time.textContent = `${clock(at)} / ${clock(total)}`
    track.setAttribute('aria-valuemin', '0')
    track.setAttribute('aria-valuemax', String(Math.round(total)))
    track.setAttribute('aria-valuenow', String(Math.round(at)))
    track.setAttribute('aria-valuetext', `${clock(at)} of ${clock(total)}`)
  }

  function drawBuffered(): void {
    const total = duration()
    const ranges = video.buffered
    if (!total || ranges.length === 0) return
    // The range that holds the play head is the one worth showing.
    let end = ranges.end(ranges.length - 1)
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= video.currentTime && video.currentTime <= ranges.end(i)) end = ranges.end(i)
    }
    buffered.style.transform = `scaleX(${Math.min(1, end / total)})`
  }

  function drawSound(): void {
    const silent = video.muted || video.volume === 0
    setIcon(muteButton, silent ? 'mute' : video.volume < 0.5 ? 'volume-low' : 'volume', silent ? 'Unmute (M)' : 'Mute (M)')
    if (document.activeElement !== volumeInput) volumeInput.value = String(Math.round((silent ? 0 : video.volume) * 100))
  }

  function drawPlaying(): void {
    const paused = video.paused || video.ended
    root.classList.toggle('paused', paused)
    setIcon(playButton, paused ? 'play' : 'pause', paused ? 'Play (K)' : 'Pause (K)')
    if (paused) wake()
    else armHide()
  }

  video.addEventListener('play', drawPlaying)
  video.addEventListener('pause', drawPlaying)
  video.addEventListener('ended', drawPlaying)
  video.addEventListener('timeupdate', drawTime)
  video.addEventListener('durationchange', drawTime)
  video.addEventListener('loadedmetadata', drawTime)
  video.addEventListener('progress', drawBuffered)
  video.addEventListener('timeupdate', drawBuffered)
  video.addEventListener('waiting', () => root.classList.add('waiting'))
  for (const name of ['playing', 'canplay', 'seeked', 'pause'] as const) {
    video.addEventListener(name, () => root.classList.remove('waiting'))
  }
  video.addEventListener('volumechange', () => {
    volume = video.volume
    muted = video.muted
    drawSound()
  })

  // Seek by click or drag on the track.
  let dragging = false
  const partAt = (clientX: number): number => {
    const box = track.getBoundingClientRect()
    return box.width ? Math.max(0, Math.min(1, (clientX - box.left) / box.width)) : 0
  }
  track.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return
    dragging = true
    root.classList.add('seeking')
    track.setPointerCapture(ev.pointerId)
    seekTo(partAt(ev.clientX) * duration())
  })
  track.addEventListener('pointermove', (ev) => {
    const part = partAt(ev.clientX)
    hoverTime.textContent = clock(part * duration())
    hoverTime.style.left = `${part * 100}%`
    if (dragging) seekTo(part * duration())
  })
  const endDrag = (): void => {
    dragging = false
    root.classList.remove('seeking')
  }
  track.addEventListener('pointerup', endDrag)
  track.addEventListener('pointercancel', endDrag)

  // A click on the picture plays or pauses, the same as most players.
  video.addEventListener('click', toggle)
  bigPlay.addEventListener('click', toggle)
  video.addEventListener('dblclick', () => void toggleFullscreen())

  root.addEventListener('keydown', (ev) => {
    const onControl = ev.target instanceof HTMLButtonElement || ev.target instanceof HTMLInputElement
    switch (ev.key.toLowerCase()) {
      case ' ':
        if (onControl) return
        toggle()
        break
      case 'k':
        toggle()
        break
      case 'arrowleft':
        if (ev.target === volumeInput) return
        seekTo(video.currentTime - STEP_SECONDS)
        break
      case 'arrowright':
        if (ev.target === volumeInput) return
        seekTo(video.currentTime + STEP_SECONDS)
        break
      case 'home':
        seekTo(0)
        break
      case 'end':
        seekTo(duration())
        break
      case 'm':
        video.muted = !video.muted
        break
      case 'f':
        void toggleFullscreen()
        break
      default:
        return
    }
    ev.preventDefault()
    ev.stopPropagation()
    wake()
  })

  // The bar hides while the video plays and the pointer rests.
  let hideTimer: number | null = null
  function armHide(): void {
    if (hideTimer !== null) window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      if (video.paused || dragging || bar.contains(document.activeElement) || bar.matches(':hover')) return
      root.classList.add('idle')
    }, HIDE_AFTER_MS)
  }
  function wake(): void {
    root.classList.remove('idle')
    if (!video.paused) armHide()
  }
  root.addEventListener('pointermove', wake)
  root.addEventListener('pointerdown', wake)
  root.addEventListener('pointerleave', () => {
    if (!video.paused && !dragging) root.classList.add('idle')
  })

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' })
      // iPhone Safari can only take the video element itself fullscreen.
      else (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.()
    } catch {
      /* refused */
    }
  }
  root.addEventListener('fullscreenchange', () => {
    const full = document.fullscreenElement === root
    root.classList.toggle('full', full)
    setIcon(fullButton, full ? 'collapse' : 'expand', full ? 'Leave fullscreen (F)' : 'Fullscreen (F)')
  })

  drawSound()
  drawTime()
  return { root, video }
}
