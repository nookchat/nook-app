import { h } from './dom'
import { icon, type IconName } from './icons'

type FitMode = 'fit' | 'fill' | 'actual'

interface SurfaceOptions {
  muted: boolean
  showVolume: boolean
}

function iconButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
  return h('button', { class: 'icon-only', title, ariaLabel: title, on: { click: onClick } }, [icon(name)])
}

function setIcon(button: HTMLButtonElement, name: IconName): void {
  button.replaceChildren(icon(name))
}

const MIN_SCALE = 0.05
const MAX_SCALE = 8
const HIDE_BAR_AFTER_MS = 2800

export class VideoSurface {
  readonly root: HTMLDivElement
  readonly video: HTMLVideoElement

  private readonly bar: HTMLDivElement
  private readonly zoomLabel: HTMLSpanElement
  private readonly modeButton: HTMLButtonElement
  private readonly fullscreenButton: HTMLButtonElement
  private readonly muteButton: HTMLButtonElement | null = null
  private readonly volumeInput: HTMLInputElement | null = null
  private readonly zoomGroup: HTMLDivElement

  private mode: FitMode = 'fit'
  private scale = 1
  private tx = 0
  private ty = 0
  private dragging = false
  private dragId = -1
  private lastX = 0
  private lastY = 0
  private frame = 0
  private drawnSize = ''
  private drawnVolumeIcon: IconName | null = null
  private hideTimer: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private soundPrompt: HTMLButtonElement | null = null
  private unmuting: Promise<boolean> | null = null
  private destroyed = false

  constructor(options: SurfaceOptions) {
    this.video = h('video')
    this.video.autoplay = true
    // Without playsInline, iOS takes the video fullscreen on its own.
    this.video.playsInline = true
    this.video.muted = options.muted
    if (options.muted) this.video.setAttribute('muted', '')

    this.modeButton = iconButton('fit', 'Change how the picture fits (Z)', () => this.cycleMode())

    this.zoomLabel = h('span', { class: 'zoom-label', text: '100%' })
    this.zoomGroup = h('div', { class: 'row hidden', style: { gap: '2px' } }, [
      iconButton('zoom-out', 'Zoom out', () => this.zoomBy(1 / 1.25)),
      this.zoomLabel,
      iconButton('zoom-in', 'Zoom in', () => this.zoomBy(1.25)),
      h('button', {
        class: 'small',
        text: 'Reset',
        title: 'Reset the zoom (0)',
        on: { click: () => this.resetView() },
      }),
    ])

    const controls: HTMLElement[] = []

    if (options.showVolume) {
      this.muteButton = iconButton('volume', 'Mute (M)', () => this.toggleMute())
      this.volumeInput = h('input', {
        type: 'range',
        min: '0',
        max: '100',
        step: '1',
        value: '100',
        ariaLabel: 'Volume',
        on: {
          input: () => {
            const v = Number(this.volumeInput!.value) / 100
            this.video.volume = v
            if (v > 0 && this.video.muted) this.video.muted = false
            this.syncVolumeUi()
          },
        },
      })
      controls.push(h('div', { class: 'vol' }, [this.muteButton, this.volumeInput]), h('div', { class: 'divider' }))
    }

    controls.push(this.zoomGroup)
    controls.push(this.modeButton)

    if ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) {
      controls.push(iconButton('pip', 'Picture in picture', () => void this.togglePip()))
    }

    this.fullscreenButton = iconButton('expand', 'Fullscreen (F)', () => void this.toggleFullscreen())
    controls.push(this.fullscreenButton)

    this.bar = h('div', { class: 'surface-bar' }, controls)

    this.root = h('div', { class: 'surface grow', tabIndex: 0, data: { mode: 'fit' } }, [this.video, this.bar])

    this.bindPointer()
    this.bindKeys()
    this.bindVideo()
    this.armAutoHide()
  }

  setStream(stream: MediaStream | null): void {
    this.video.srcObject = stream
    if (stream) void this.video.play().catch(() => undefined)
  }

  async tryUnmute(): Promise<boolean> {
    if (!this.video.srcObject) return false
    // Single flight: ontrack fires once per track, and an interrupted play() would put the mute back.
    if (this.unmuting) return this.unmuting
    this.unmuting = (async () => {
      this.video.muted = false
      try {
        await this.video.play()
        this.clearSoundPrompt()
        this.syncVolumeUi()
        return true
      } catch {
        // Autoplay policy refused sound; muted playback is still allowed.
        this.video.muted = true
        void this.video.play().catch(() => undefined)
        this.syncVolumeUi()
        return false
      } finally {
        this.unmuting = null
      }
    })()
    return this.unmuting
  }

  clearSoundPrompt(): void {
    this.soundPrompt?.remove()
    this.soundPrompt = null
  }

  setSoundPrompt(onClick: () => void): void {
    if (this.soundPrompt) return
    const button = h('button', {
      class: 'sound-prompt primary',
      text: 'Sound is off. Click for sound',
      on: {
        click: () => {
          onClick()
          this.clearSoundPrompt()
        },
      },
    })
    this.soundPrompt = button
    this.root.append(button)

    document.addEventListener(
      'pointerdown',
      () => {
        if (this.soundPrompt) onClick()
      },
      { once: true },
    )
  }

  requestFullscreen(): void {
    void this.toggleFullscreen()
  }

  setMode(mode: FitMode): void {
    this.mode = mode
    this.root.dataset.mode = mode
    this.zoomGroup.classList.toggle('hidden', mode !== 'actual')
    this.modeButton.title =
      mode === 'fit'
        ? 'Fit. Click for Fill (Z)'
        : mode === 'fill'
          ? 'Fill. Click for actual size (Z)'
          : 'Actual size. Click for Fit (Z)'
    if (mode === 'actual') {
      this.resetView()
    } else {
      this.drawnSize = ''
      this.video.style.transform = ''
      this.video.style.width = ''
      this.video.style.height = ''
    }
    this.showBar()
  }

  cycleMode(): void {
    this.setMode(this.mode === 'fit' ? 'fill' : this.mode === 'fill' ? 'actual' : 'fit')
  }

  destroy(): void {
    this.destroyed = true
    cancelAnimationFrame(this.frame)
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer)
    this.resizeObserver?.disconnect()
    this.video.srcObject = null
    this.root.remove()
  }

  private bindVideo(): void {
    this.video.addEventListener('resize', () => {
      if (this.mode === 'actual') this.resetView()
    })
    this.video.addEventListener('volumechange', () => this.syncVolumeUi())

    this.resizeObserver = new ResizeObserver(() => {
      if (this.mode === 'actual') this.clampPan()
    })
    this.resizeObserver.observe(this.root)
  }

  private bindPointer(): void {
    this.root.addEventListener('pointermove', () => this.showBar())
    this.root.addEventListener('pointerleave', () => this.armAutoHide(600))
    this.root.addEventListener('pointerdown', () => this.showBar())

    this.root.addEventListener('dblclick', () => {
      this.setMode(this.mode === 'actual' ? 'fit' : 'actual')
    })

    this.root.addEventListener(
      'wheel',
      (ev) => {
        // A trackpad pinch arrives as a wheel event with ctrlKey set.
        if (!ev.ctrlKey && this.mode !== 'actual') return
        ev.preventDefault()
        if (this.mode !== 'actual') this.setMode('actual')
        this.zoomAt(Math.exp(-ev.deltaY * 0.0018), ev.clientX, ev.clientY)
      },
      { passive: false },
    )

    this.root.addEventListener('pointerdown', (ev) => {
      if (this.mode !== 'actual' || ev.button !== 0) return
      this.dragging = true
      this.dragId = ev.pointerId
      this.lastX = ev.clientX
      this.lastY = ev.clientY
      this.root.classList.add('grabbing')
      this.root.setPointerCapture(ev.pointerId)
    })

    this.root.addEventListener('pointermove', (ev) => {
      if (!this.dragging || ev.pointerId !== this.dragId) return
      this.tx += ev.clientX - this.lastX
      this.ty += ev.clientY - this.lastY
      this.lastX = ev.clientX
      this.lastY = ev.clientY
      this.clampPan()
    })

    const endDrag = (ev: PointerEvent): void => {
      if (ev.pointerId !== this.dragId) return
      this.dragging = false
      this.dragId = -1
      this.root.classList.remove('grabbing')
    }
    this.root.addEventListener('pointerup', endDrag)
    this.root.addEventListener('pointercancel', endDrag)
  }

  private bindKeys(): void {
    this.root.addEventListener('keydown', (ev) => {
      switch (ev.key.toLowerCase()) {
        case 'f':
          ev.preventDefault()
          void this.toggleFullscreen()
          return
        case 'm':
          if (this.muteButton) {
            ev.preventDefault()
            this.toggleMute()
          }
          return
        case 'z':
          ev.preventDefault()
          this.cycleMode()
          return
        case '0':
          ev.preventDefault()
          this.resetView()
          return
        case '+':
        case '=':
          ev.preventDefault()
          this.zoomBy(1.25)
          return
        case '-':
          ev.preventDefault()
          this.zoomBy(1 / 1.25)
          return
        default:
          return
      }
    })
  }

  private toggleMute(): void {
    this.video.muted = !this.video.muted
    if (!this.video.muted && this.video.volume === 0) this.video.volume = 1
    this.syncVolumeUi()
  }

  private syncVolumeUi(): void {
    if (!this.muteButton || !this.volumeInput) return
    const muted = this.video.muted || this.video.volume === 0
    const name: IconName = muted ? 'mute' : this.video.volume < 0.5 ? 'volume-low' : 'volume'
    if (name !== this.drawnVolumeIcon) {
      this.drawnVolumeIcon = name
      setIcon(this.muteButton, name)
    }
    this.muteButton.title = muted ? 'Unmute (M)' : 'Mute (M)'
    if (document.activeElement !== this.volumeInput) {
      this.volumeInput.value = String(Math.round((muted ? 0 : this.video.volume) * 100))
    }
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await this.root.requestFullscreen({ navigationUI: 'hide' })
    } catch {
      /* refused */
    }
    const full = document.fullscreenElement === this.root
    setIcon(this.fullscreenButton, full ? 'collapse' : 'expand')
    this.fullscreenButton.title = full ? 'Leave fullscreen (F)' : 'Fullscreen (F)'
  }

  private async togglePip(): Promise<void> {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await this.video.requestPictureInPicture()
    } catch {
      /* not allowed before the video has data */
    }
  }

  private naturalSize(): { w: number; h: number } {
    return { w: this.video.videoWidth || 1280, h: this.video.videoHeight || 720 }
  }

  private resetView(): void {
    const box = this.root.getBoundingClientRect()
    const { w, h: vh } = this.naturalSize()
    const fitScale = Math.min(box.width / w, box.height / vh)
    this.scale = Math.min(1, fitScale > 0 ? fitScale : 1)
    this.tx = (box.width - w * this.scale) / 2
    this.ty = (box.height - vh * this.scale) / 2
    this.scheduleTransform()
  }

  private zoomBy(factor: number): void {
    const box = this.root.getBoundingClientRect()
    this.zoomAt(factor, box.left + box.width / 2, box.top + box.height / 2, box)
  }

  private zoomAt(factor: number, clientX: number, clientY: number, box = this.root.getBoundingClientRect()): void {
    if (this.mode !== 'actual') return
    const cx = clientX - box.left
    const cy = clientY - box.top
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor))
    if (next === this.scale) return
    this.tx = cx - (cx - this.tx) * (next / this.scale)
    this.ty = cy - (cy - this.ty) * (next / this.scale)
    this.scale = next
    this.clampPan(box)
  }

  private clampPan(box = this.root.getBoundingClientRect()): void {
    const { w, h: vh } = this.naturalSize()
    const sw = w * this.scale
    const sh = vh * this.scale
    this.tx = sw <= box.width ? (box.width - sw) / 2 : Math.min(0, Math.max(box.width - sw, this.tx))
    this.ty = sh <= box.height ? (box.height - sh) / 2 : Math.min(0, Math.max(box.height - sh, this.ty))
    this.scheduleTransform()
  }

  private scheduleTransform(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (this.destroyed || this.mode !== 'actual') return
      const { w, h: vh } = this.naturalSize()
      const size = `${w}x${vh}`
      if (size !== this.drawnSize) {
        this.drawnSize = size
        this.video.style.width = `${w}px`
        this.video.style.height = `${vh}px`
      }
      this.video.style.transform = `translate(${Math.round(this.tx)}px, ${Math.round(this.ty)}px) scale(${this.scale})`
      this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`
    })
  }

  private showBar(): void {
    if (this.root.classList.contains('hide-bar')) this.root.classList.remove('hide-bar')
    this.armAutoHide()
  }

  private armAutoHide(delay = HIDE_BAR_AFTER_MS): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer)
    this.hideTimer = window.setTimeout(() => {
      if (this.destroyed || this.dragging) return
      if (this.root.contains(document.activeElement)) return
      this.root.classList.add('hide-bar')
    }, delay)
  }
}
