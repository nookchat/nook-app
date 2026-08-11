/**
 * The video surface.
 *
 * A shared screen can be 1280x800 or 5120x2880, and it can change size in the
 * middle of a session. The viewer window can be a 4K monitor or a phone in
 * portrait. Three modes cover every pair:
 *
 *   fit     the whole picture, letterboxed. The default. Never stretched.
 *   fill    crops the edges to remove the letterbox.
 *   actual  one stream pixel per screen pixel, with zoom and pan.
 *
 * The picture is never distorted in any mode.
 */

import { clear, h } from './dom'
import { icon, type IconName } from './icons'

export type FitMode = 'fit' | 'fill' | 'actual'

export interface SurfaceOptions {
  /** A host previews its own screen, so that video stays muted. */
  muted: boolean
  showVolume: boolean
  fullBleed?: boolean
}

function iconButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const button = h('button', {
    class: 'icon-only',
    title,
    ariaLabel: title,
    on: { click: onClick },
  })
  button.append(icon(name))
  return button
}

function setIcon(button: HTMLButtonElement, name: IconName): void {
  clear(button)
  button.append(icon(name))
}

const MIN_SCALE = 0.05
const MAX_SCALE = 8
const HIDE_BAR_AFTER_MS = 2800

export class VideoSurface {
  readonly root: HTMLDivElement
  readonly video: HTMLVideoElement

  onVolumeChange: ((volume: number, muted: boolean) => void) | null = null

  private readonly badges: HTMLDivElement
  private readonly bar: HTMLDivElement
  private readonly overlayHost: HTMLDivElement
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
  private hideTimer: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private destroyed = false

  constructor(options: SurfaceOptions) {
    this.video = h('video', {
      // playsInline keeps iOS from taking the video fullscreen on its own.
    })
    this.video.autoplay = true
    this.video.playsInline = true
    this.video.muted = options.muted
    this.video.controls = false
    this.video.disablePictureInPicture = false
    if (options.muted) this.video.setAttribute('muted', '')

    this.badges = h('div', { class: 'surface-badges' })
    this.overlayHost = h('div', { class: 'hidden' })

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
            this.onVolumeChange?.(v, this.video.muted)
          },
        },
      })
      controls.push(h('div', { class: 'vol' }, [this.muteButton, this.volumeInput]))
    }

    if (options.showVolume) controls.push(h('div', { class: 'divider' }))
    controls.push(this.zoomGroup)
    controls.push(this.modeButton)

    if ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) {
      controls.push(iconButton('pip', 'Picture in picture', () => void this.togglePip()))
    }

    this.fullscreenButton = iconButton('expand', 'Fullscreen (F)', () => void this.toggleFullscreen())
    controls.push(this.fullscreenButton)

    this.bar = h('div', { class: 'surface-bar' }, controls)

    this.root = h(
      'div',
      {
        class: `surface${options.fullBleed ? ' fullbleed' : ''} grow`,
        tabIndex: 0,
        data: { mode: 'fit' },
      },
      [this.video, this.badges, this.overlayHost, this.bar],
    )

    this.bindPointer()
    this.bindKeys()
    this.bindVideo()
    this.armAutoHide()
  }

  // ---- public API ----

  setStream(stream: MediaStream | null): void {
    this.video.srcObject = stream
    if (stream) void this.video.play().catch(() => undefined)
  }

  /**
   * Unmute needs a user gesture. Call this from a click handler.
   *
   * Never call play() while the element has no source. Chrome keeps that promise
   * pending for ever, and anything that awaits it stops.
   */
  async playWithSound(): Promise<void> {
    this.video.muted = false
    this.syncVolumeUi()
    if (!this.video.srcObject) return
    await this.video.play().catch(() => undefined)
  }

  /** Hide the floating bar and the badges while there is nothing to control. */
  setControlsVisible(visible: boolean): void {
    this.root.classList.toggle('no-controls', !visible)
  }

  setMode(mode: FitMode): void {
    this.mode = mode
    this.root.dataset.mode = mode
    this.zoomGroup.classList.toggle('hidden', mode !== 'actual')
    this.modeButton.title =
      mode === 'fit'
        ? 'Fit. Click for Fill (F)'
        : mode === 'fill'
          ? 'Fill. Click for actual size (F)'
          : 'Actual size. Click for Fit (F)'
    if (mode === 'actual') {
      this.resetView()
    } else {
      this.video.style.transform = ''
      this.video.style.width = ''
      this.video.style.height = ''
    }
    this.showBar()
  }

  cycleMode(): void {
    this.setMode(this.mode === 'fit' ? 'fill' : this.mode === 'fill' ? 'actual' : 'fit')
  }

  setBadges(items: { text: string; tone?: 'good' | 'warn' | 'bad' }[]): void {
    clear(this.badges)
    for (const item of items) {
      this.badges.append(h('span', { class: `pill ${item.tone ?? ''}`.trim(), text: item.text }))
    }
  }

  /** Cover the picture with a message. Pass null to clear it. */
  setOverlay(node: HTMLElement | null): void {
    clear(this.overlayHost)
    if (!node) {
      this.overlayHost.className = 'hidden'
      return
    }
    this.overlayHost.className = 'surface-overlay'
    this.overlayHost.append(node)
  }

  get volume(): number {
    return this.video.volume
  }

  destroy(): void {
    this.destroyed = true
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer)
    this.resizeObserver?.disconnect()
    this.video.srcObject = null
    this.root.remove()
  }

  // ---- internals ----

  private bindVideo(): void {
    // The host can change resolution mid session. Recentre when that happens.
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
    // A touch has no hover, so a tap is the only way back to the controls.
    this.root.addEventListener('pointerdown', () => this.showBar())

    this.root.addEventListener('dblclick', () => {
      this.setMode(this.mode === 'actual' ? 'fit' : 'actual')
    })

    this.root.addEventListener(
      'wheel',
      (ev) => {
        // Ctrl plus wheel is the standard zoom gesture, and a trackpad pinch
        // arrives the same way. Plain wheel zooms only in actual mode.
        if (!ev.ctrlKey && this.mode !== 'actual') return
        ev.preventDefault()
        if (this.mode !== 'actual') this.setMode('actual')
        const factor = Math.exp(-ev.deltaY * 0.0018)
        this.zoomAt(factor, ev.clientX, ev.clientY)
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
    this.onVolumeChange?.(this.video.volume, this.video.muted)
  }

  private syncVolumeUi(): void {
    if (!this.muteButton || !this.volumeInput) return
    const muted = this.video.muted || this.video.volume === 0
    setIcon(this.muteButton, muted ? 'mute' : this.video.volume < 0.5 ? 'volume-low' : 'volume')
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
      /* the browser refused, nothing else to do */
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

  // ---- zoom and pan ----

  private naturalSize(): { w: number; h: number } {
    return { w: this.video.videoWidth || 1280, h: this.video.videoHeight || 720 }
  }

  private resetView(): void {
    const box = this.root.getBoundingClientRect()
    const { w, h: vh } = this.naturalSize()
    // Start at one to one, unless the picture does not fit. Then start at fit.
    const fitScale = Math.min(box.width / w, box.height / vh)
    this.scale = Math.min(1, fitScale > 0 ? fitScale : 1)
    this.tx = (box.width - w * this.scale) / 2
    this.ty = (box.height - vh * this.scale) / 2
    this.applyTransform()
  }

  private zoomBy(factor: number): void {
    const box = this.root.getBoundingClientRect()
    this.zoomAt(factor, box.left + box.width / 2, box.top + box.height / 2)
  }

  private zoomAt(factor: number, clientX: number, clientY: number): void {
    if (this.mode !== 'actual') return
    const box = this.root.getBoundingClientRect()
    const cx = clientX - box.left
    const cy = clientY - box.top
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor))
    if (next === this.scale) return
    // Keep the point under the cursor fixed.
    this.tx = cx - (cx - this.tx) * (next / this.scale)
    this.ty = cy - (cy - this.ty) * (next / this.scale)
    this.scale = next
    this.clampPan()
  }

  private clampPan(): void {
    const box = this.root.getBoundingClientRect()
    const { w, h: vh } = this.naturalSize()
    const sw = w * this.scale
    const sh = vh * this.scale
    this.tx = sw <= box.width ? (box.width - sw) / 2 : Math.min(0, Math.max(box.width - sw, this.tx))
    this.ty = sh <= box.height ? (box.height - sh) / 2 : Math.min(0, Math.max(box.height - sh, this.ty))
    this.applyTransform()
  }

  private applyTransform(): void {
    const { w, h: vh } = this.naturalSize()
    this.video.style.width = `${w}px`
    this.video.style.height = `${vh}px`
    this.video.style.transform = `translate(${Math.round(this.tx)}px, ${Math.round(this.ty)}px) scale(${this.scale})`
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`
  }

  // ---- control bar auto hide ----

  private showBar(): void {
    this.root.classList.remove('hide-bar')
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
