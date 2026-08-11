/**
 * The host screen.
 *
 * It owns the capture, the mixer, one HostPeer per viewer, and the quality
 * budget. Everything a viewer needs travels over the signal bus until the peer
 * connection stands up, and after that the bus only waits for new arrivals.
 */

import { hostBlocker, hostNotes, checkSupport } from '../diagnostics'
import { AudioMixer } from '../media/mixer'
import { captureMicrophone, captureScreen, CaptureError, type ScreenCapture } from '../media/capture'
import { deriveRoom, newPeerId, newSecret, roomLink, type Room } from '../room'
import { SignalBus, type RelayHealth } from '../signal/bus'
import type { Envelope } from '../signal/envelope'
import { HostPeer } from '../rtc/host-peer'
import {
  FPS_CHOICES,
  PRESETS,
  RESOLUTION_CHOICES,
  availableCodecs,
  idealBitrateKbps,
  planFor,
  presetById,
  type CodecChoice,
  type PresetId,
  type QualityPlan,
} from '../rtc/quality'
import { gradeOf } from '../rtc/stats'
import { UplinkMeter } from '../net/uplink'
import { NO_HARDWARE, probeHardwareEncoders, type HardwareProbe } from '../rtc/hardware'
import { loadSettings, saveSettings, type HostSettings } from '../settings'
import { clear, copyText, fmtDuration, fmtKbps, h, labelled } from './dom'
import { brandMark, icon } from './icons'
import { qrSvg } from './qr'
import { aboutCard, summaryCard, type SessionSummary } from './shell'
import { toast } from './toast'
import { VideoSurface } from './video-surface'

const ANNOUNCE_MS = 4000
const STATS_MS = 2000
const REAP_MS = 10_000
const PENDING_TTL_MS = 120_000
/** How long a broken connection stays in the list before Beam clears it away. */
const DEAD_PEER_MS = 20_000

export class HostView {
  private readonly root: HTMLElement
  private readonly selfId = newPeerId()
  private settings: HostSettings = loadSettings()

  private room: Room | null = null
  private bus: SignalBus | null = null
  private capture: ScreenCapture | null = null
  private mixer: AudioMixer | null = null
  private outStream: MediaStream | null = null
  private surface: VideoSurface | null = null

  private readonly peers = new Map<string, HostPeer>()
  private readonly pending = new Map<string, number>()
  private startedAt = 0
  private peakViewers = 0
  private bytesSent = 0

  /** Idle means the page is up and waiting for a source to be picked. */
  private phase: 'idle' | 'live' = 'idle'
  private lastSummary: SessionSummary | null = null

  /** What Beam believes this connection will carry upward. */
  private readonly uplink = new UplinkMeter()
  /** Which codecs this machine can encode on the GPU. */
  private gpu: HardwareProbe = NO_HARDWARE

  private timers: number[] = []

  // Elements we update in place.
  private sidePanel!: HTMLDivElement
  private linkInput!: HTMLInputElement
  private statusPills!: HTMLDivElement
  private viewerList!: HTMLDivElement
  private planLine!: HTMLDivElement
  private uploadLine!: HTMLDivElement
  private presetList!: HTMLDivElement
  private resolutionRow!: HTMLDivElement
  private fpsRow!: HTMLDivElement
  private sysMeter!: HTMLElement
  private micMeter!: HTMLElement
  private micButton!: HTMLButtonElement
  private sysNote!: HTMLDivElement
  private relayLine!: HTMLDivElement
  private elapsed!: HTMLSpanElement

  private codecNote!: HTMLDivElement
  private budgetLabel!: HTMLSpanElement
  private budgetNote!: HTMLDivElement
  private budgetInput!: HTMLInputElement
  private autoButton!: HTMLButtonElement

  constructor(root: HTMLElement) {
    this.root = root
  }

  /** The budget in force: measured while automatic, otherwise the slider. */
  private budgetKbps(): number {
    return this.settings.budgetAuto ? this.uplink.estimateKbps : this.settings.budgetKbps
  }

  get isLive(): boolean {
    return this.phase === 'live'
  }

  /** Draw the sharing page straight away. Beam has no welcome screen. */
  mount(): void {
    this.renderShell()
    this.renderIdle()
    // Ask the browser what it can encode on the GPU. It takes a moment and
    // nothing waits on it, so the answer arrives before the first viewer does.
    void probeHardwareEncoders(availableCodecs()).then((probe) => {
      this.gpu = probe
      this.renderCodecNote()
    })
  }

  /**
   * Open the picker and go live.
   *
   * This has to run inside a click. A browser shows the screen picker for a
   * real gesture and for nothing else, which is why the page cannot start
   * sharing on its own the moment it loads.
   */
  async beginShare(): Promise<void> {
    if (this.phase === 'live') return
    try {
      this.capture = await captureScreen({
        maxHeight: this.settings.maxHeight,
        fps: this.settings.fps,
        wantSystemAudio: this.settings.shareSystemAudio,
      })
    } catch (err) {
      // A cancelled picker is an ordinary answer, so say nothing and wait.
      if (!(err instanceof CaptureError) || err.kind !== 'denied') {
        const message =
          err instanceof CaptureError ? err.message : `The screen share failed: ${String(err)}`
        toast(message, 'bad', 8000)
      }
      return
    }

    this.phase = 'live'
    this.startedAt = Date.now()
    this.peakViewers = 0
    this.bytesSent = 0

    this.mixer = new AudioMixer()
    await this.mixer.resume()
    this.mixer.attachSystem(
      this.capture.systemAudio ? new MediaStream([this.capture.systemAudio]) : null,
    )

    this.outStream = new MediaStream([this.capture.video, this.mixer.track])
    this.watchCaptureEnd(this.capture.video)

    const secret = newSecret()
    this.room = await deriveRoom(secret)
    this.renderLive(secret)
    this.openBus()
    this.startLoops()
  }

  /** End the stream and return to the picker, without leaving the page. */
  stop(): void {
    if (this.phase !== 'live') return
    this.phase = 'idle'
    this.lastSummary = {
      seconds: Math.round((Date.now() - this.startedAt) / 1000),
      peakViewers: this.peakViewers,
      bytesSent: this.bytesSent,
    }
    this.teardownSession()
    this.renderIdle()
  }

  /** Full teardown, for leaving the page. */
  destroy(): void {
    this.phase = 'idle'
    this.teardownSession()
    this.surface?.destroy()
    this.surface = null
  }

  private teardownSession(): void {
    for (const t of this.timers) window.clearInterval(t)
    this.timers = []
    document.title = 'Beam · peer to peer screen share'
    void this.bus?.send({ type: 'bye' }).catch(() => undefined)
    for (const peer of this.peers.values()) peer.close()
    this.peers.clear()
    this.pending.clear()
    const bus = this.bus
    this.bus = null
    if (bus) window.setTimeout(() => bus.stop(), 250)
    this.capture?.stream.getTracks().forEach((t) => t.stop())
    this.capture = null
    this.mixer?.close()
    this.mixer = null
    this.outStream = null
  }

  // ---- signal ----

  private openBus(): void {
    if (!this.room) return
    this.bus?.stop()
    const bus = new SignalBus(this.room, this.selfId)
    bus.onMessage = (env) => void this.onMessage(env)
    bus.onHealth = (health) => this.renderRelays(health)
    bus.start()
    this.bus = bus
    this.renderRelays(bus.healthList)
  }

  private async onMessage(env: Envelope): Promise<void> {
    switch (env.type) {
      case 'hello': {
        if (this.peers.size >= this.settings.maxViewers) {
          void this.bus?.send({
            type: 'deny',
            to: env.from,
            data: {
              reason: `This stream is full. The host allows ${this.settings.maxViewers} viewers.`,
            },
          })
          return
        }
        // A viewer that reloads sends hello again. Rebuild from scratch.
        this.peers.get(env.from)?.close()
        this.peers.delete(env.from)

        if (this.settings.approve) {
          if (!this.pending.has(env.from)) {
            this.pending.set(env.from, Date.now())
            toast('Someone wants to watch. Approve them in the viewer list.', 'info', 7000)
          }
          this.renderViewers()
          return
        }
        this.admit(env.from)
        return
      }
      case 'answer': {
        await this.peers.get(env.from)?.onAnswer(env.data as RTCSessionDescriptionInit)
        return
      }
      case 'ice': {
        await this.peers.get(env.from)?.onIce(env.data as RTCIceCandidateInit)
        return
      }
      case 'bye': {
        this.drop(env.from)
        return
      }
      default:
        return
    }
  }

  private admit(viewerId: string): void {
    if (!this.outStream) return
    this.pending.delete(viewerId)
    const peer = new HostPeer({
      viewerId,
      stream: this.outStream,
      mode: this.settings.mode,
      codec: this.settings.codec,
      hardware: this.gpu.hardware,
      send: (type, data) => void this.bus?.send({ type, to: viewerId, data }),
      onChange: () => this.renderViewers(),
      onFailed: (reason) => toast(reason, 'bad', 8000),
    })
    this.peers.set(viewerId, peer)
    this.peakViewers = Math.max(this.peakViewers, this.peers.size)
    void peer.setPlan(this.currentPlan(this.peers.size))
    this.renderViewers()
  }

  private drop(viewerId: string, tellThem = false): void {
    const peer = this.peers.get(viewerId)
    if (peer) {
      peer.close()
      this.peers.delete(viewerId)
    }
    this.pending.delete(viewerId)
    if (tellThem) {
      void this.bus?.send({
        type: 'deny',
        to: viewerId,
        data: { reason: 'The host removed you from this stream.' },
      })
    }
    this.renderViewers()
  }

  // ---- loops ----

  private startLoops(): void {
    this.timers.push(
      window.setInterval(() => {
        void this.bus?.send({
          type: 'announce',
          data: { viewers: this.peers.size, max: this.settings.maxViewers },
        })
      }, ANNOUNCE_MS),
    )
    void this.bus?.send({ type: 'announce', data: { viewers: 0, max: this.settings.maxViewers } })

    this.timers.push(window.setInterval(() => void this.tickStats(), STATS_MS))
    this.timers.push(window.setInterval(() => this.reap(), REAP_MS))
    this.timers.push(window.setInterval(() => this.tickMeters(), 90))
    this.timers.push(
      window.setInterval(() => {
        this.elapsed.textContent = fmtDuration(Date.now() - this.startedAt)
      }, 1000),
    )
  }

  private async tickStats(): Promise<void> {
    const peers = [...this.peers.values()]
    await Promise.all(peers.map((p) => p.sample()))

    for (const peer of peers) {
      this.bytesSent += ((peer.stats.kbps + peer.stats.audioKbps) * 1000 * (STATS_MS / 1000)) / 8
    }

    this.measureUplink(peers)

    const plan = this.currentPlan(Math.max(1, peers.length))
    for (const peer of peers) await peer.setPlan(plan)

    this.renderViewers()
    this.renderPlan(plan, peers.length)
    this.renderPreviewBadges()
  }

  /**
   * Fold this round of statistics into the uplink estimate.
   *
   * Two things are real measurements of the upload path: what the viewers
   * report losing, and what the bandwidth estimator inside WebRTC says the path
   * will carry. Both come from bytes that actually travelled.
   */
  private measureUplink(peers: HostPeer[]): void {
    const live = peers.filter((p) => p.state === 'connected' && p.stats.kbps > 0)
    if (live.length === 0) return

    const sendingKbps = live.reduce((sum, p) => sum + p.stats.kbps + p.stats.audioKbps, 0)
    const availableKbps = live.reduce((sum, p) => sum + p.stats.availableOutKbps, 0)
    const lossPct = live.reduce((sum, p) => sum + p.stats.lossPct, 0) / live.length
    const { width, height } = this.sourceSize()
    const demandKbps =
      idealBitrateKbps(
        this.settings.mode,
        width,
        height,
        this.settings.bitrateScale,
        this.settings.fps,
      ) * live.length

    if (this.uplink.observe({ demandKbps, sendingKbps, availableKbps, lossPct })) {
      this.renderBudget()
    }
  }

  private sourceSize(): { width: number; height: number } {
    const s = this.capture?.video.getSettings()
    if (s?.width && s?.height) return { width: s.width, height: s.height }
    // Nothing is captured yet, so preview the plan against the chosen cap.
    const height = this.settings.maxHeight || 1080
    return { width: Math.round((height * 16) / 9), height }
  }

  private currentPlan(viewerCount: number): QualityPlan {
    const { width, height } = this.sourceSize()
    return planFor({
      mode: this.settings.mode,
      budgetKbps: this.budgetKbps(),
      viewerCount,
      width,
      height,
      fps: this.settings.fps,
      bitrateScale: this.settings.bitrateScale,
    })
  }

  private reap(): void {
    const now = Date.now()
    for (const [id, at] of this.pending) {
      if (now - at > PENDING_TTL_MS) this.pending.delete(id)
    }
    for (const [id, peer] of this.peers) {
      if (peer.state === 'closed') {
        this.peers.delete(id)
        continue
      }
      // A viewer that shut the tab without a goodbye leaves a stuck row. Give
      // the connection time to come back on its own, then clear it away.
      const dead = peer.state === 'failed' || peer.state === 'disconnected'
      if (dead && now - peer.stateSince > DEAD_PEER_MS) {
        peer.close()
        this.peers.delete(id)
      }
    }
    this.renderViewers()
  }

  private tickMeters(): void {
    if (!this.sysMeter || !this.micMeter) return
    const levels = this.mixer?.levels() ?? { system: 0, mic: 0 }
    this.sysMeter.style.width = `${Math.round(levels.system * 100)}%`
    this.micMeter.style.width = `${Math.round(levels.mic * 100)}%`
  }

  private watchCaptureEnd(track: MediaStreamTrack): void {
    // The browser puts its own "Stop sharing" bar on screen. Respect it.
    track.addEventListener('ended', () => {
      if (this.phase !== 'live' || this.capture?.video !== track) return
      toast('You stopped the screen share, so the stream ended.', 'warn')
      this.stop()
    })
  }

  // ---- render ----

  /** The frame that both states live in: the picture on the left, panels right. */
  private renderShell(): void {
    clear(this.root)
    this.surface = new VideoSurface({ muted: true, showVolume: false })
    this.surface.setMode('fit')
    this.sidePanel = h('div', { class: 'host-side' })
    this.root.append(
      h('div', { class: 'host-grid' }, [
        h('div', { class: 'stack', style: { minHeight: '0' } }, [this.surface.root]),
        this.sidePanel,
      ]),
    )
  }

  /** Waiting for a source. The quality is set here, before anything goes out. */
  private renderIdle(): void {
    const support = checkSupport()
    const blocker = hostBlocker(support)

    this.surface?.setStream(null)
    this.surface?.setBadges([])
    this.surface?.setControlsVisible(false)
    this.surface?.setOverlay(
      h('div', { class: 'pick' }, [
        brandMark(46),
        h('h2', { text: blocker ? 'Beam cannot share from this browser' : 'Choose what to share' }),
        h('p', {
          class: 'dim',
          style: { margin: '0', maxWidth: '38ch' },
          text:
            blocker ??
            'A window, a browser tab, or your whole screen. You get a link to send the moment you pick.',
        }),
        blocker
          ? null
          : h(
              'button',
              { class: 'primary big', on: { click: () => void this.beginShare() } },
              [icon('monitor', 20), 'Choose what to share'],
            ),
      ]),
    )

    clear(this.sidePanel)
    const cards: (HTMLElement | null)[] = [
      this.lastSummary ? summaryCard(this.lastSummary) : null,
      this.qualityCard(),
      aboutCard(),
    ]
    for (const card of cards) if (card) this.sidePanel.append(card)

    this.renderPresets()
    this.renderResolutions()
    this.renderFps()
    this.renderBudget()
    this.renderCodecNote()
    this.renderPlan(this.currentPlan(1), 0)
  }

  /** Sharing. The link, the viewers, and everything that only exists live. */
  private renderLive(secret: string): void {
    const support = checkSupport()

    this.surface?.setOverlay(null)
    this.surface?.setControlsVisible(true)
    this.surface?.setStream(this.outStream)

    this.linkInput = h('input', {
      type: 'text',
      readOnly: true,
      value: roomLink(secret),
      ariaLabel: 'The link to share',
      on: { focus: (ev) => (ev.target as HTMLInputElement).select() },
    })

    clear(this.sidePanel)
    this.sidePanel.append(
      this.linkCard(),
      this.viewersCard(),
      this.qualityCard(),
      this.audioCard(support.systemAudio),
      this.sessionCard(),
      ...hostNotes(support).map((n) => h('div', { class: 'card tiny dim', text: n })),
    )

    this.renderPresets()
    this.renderResolutions()
    this.renderFps()
    this.renderBudget()
    this.renderCodecNote()
    this.renderViewers()
    this.renderPlan(this.currentPlan(1), 0)
    this.renderPreviewBadges()
  }

  private linkCard(): HTMLElement {
    const copyLabel = h('span', { text: 'Copy link' })
    const copyButton = h('button', { class: 'primary grow' }, [icon('copy'), copyLabel])
    copyButton.addEventListener('click', async () => {
      const ok = await copyText(this.linkInput.value)
      copyLabel.textContent = ok ? 'Copied' : 'Copy failed'
      clear(copyButton)
      copyButton.append(icon(ok ? 'check' : 'copy'), copyLabel)
      window.setTimeout(() => {
        copyLabel.textContent = 'Copy link'
        clear(copyButton)
        copyButton.append(icon('copy'), copyLabel)
      }, 1800)
      if (!ok) this.linkInput.select()
    })

    const qrButton = h('button', {
      class: 'icon-only',
      title: 'Show a QR code, so a phone can join by camera',
      ariaLabel: 'Show a QR code',
      on: { click: () => this.showQr() },
    })
    qrButton.append(icon('qr'))

    return h('div', { class: 'card stack tight' }, [
      h('div', { class: 'row spread' }, [
        h('span', { class: 'eyebrow', text: 'Share this link' }),
        h('span', { class: 'pill good' }, [h('i', { class: 'dot live' }), 'live']),
      ]),
      this.linkInput,
      h('div', { class: 'row' }, [copyButton, qrButton]),
      h('div', {
        class: 'tiny faint',
        text: 'The key after the # never reaches the webserver. Anyone who holds the whole link can watch.',
      }),
      h('div', { class: 'row', style: { marginTop: '2px' } }, [
        h('button', { class: 'ghost small', title: 'Rotate the key. Every old link stops working.', on: { click: () => void this.rotateLink() } }, [
          icon('refresh', 15),
          'New link',
        ]),
        h('button', { class: 'ghost small', title: 'Share a different window, tab, or display.', on: { click: () => void this.changeScreen() } }, [
          icon('monitor', 15),
          'Change screen',
        ]),
      ]),
    ])
  }

  /** A QR code big enough to scan from across a desk. */
  private showQr(): void {
    const link = this.linkInput.value
    const close = (): void => scrim.remove()

    const frame = h('div', { class: 'qr-frame' })
    try {
      frame.append(qrSvg(link, { pixels: 260 }))
    } catch {
      frame.append(h('div', { class: 'small', text: 'This link is too long for a QR code.' }))
    }

    const modal = h('div', { class: 'modal' }, [
      h('div', { class: 'row spread' }, [
        h('span', { class: 'eyebrow', text: 'Scan to watch' }),
        h('button', { class: 'ghost icon-only', ariaLabel: 'Close', on: { click: close } }, [
          icon('close'),
        ]),
      ]),
      frame,
      h('div', {
        class: 'tiny faint',
        style: { textAlign: 'center' },
        text: 'Point a phone camera at this. The phone opens the stream straight away.',
      }),
    ])

    const scrim = h('div', {
      class: 'scrim',
      on: {
        click: (ev) => {
          if (ev.target === scrim) close()
        },
      },
    })
    scrim.append(modal)
    document.body.append(scrim)

    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        close()
        window.removeEventListener('keydown', onKey)
      }
    }
    window.addEventListener('keydown', onKey)
  }

  private viewersCard(): HTMLElement {
    this.statusPills = h('div', { class: 'row wrap', style: { gap: '6px' } })
    this.viewerList = h('div', {})
    return h('div', { class: 'card stack tight' }, [
      h('div', { class: 'row spread' }, [h('span', { class: 'eyebrow', text: 'Viewers' }), this.statusPills]),
      this.viewerList,
    ])
  }

  // ---- quality ----

  private qualityCard(): HTMLElement {
    this.planLine = h('div', { class: 'tiny plan-line' })
    this.uploadLine = h('div', { class: 'tiny faint' })
    this.presetList = h('div', { class: 'presets' })
    this.resolutionRow = h('div', { class: 'chips' })
    this.fpsRow = h('div', { class: 'chips' })

    this.budgetInput = h('input', {
      type: 'range',
      min: '1',
      max: '50',
      step: '1',
      value: String(Math.round(this.budgetKbps() / 1000)),
      ariaLabel: 'Total upload budget',
      on: {
        // Touching the slider is the decision to drive it by hand.
        input: () => {
          this.settings.budgetAuto = false
          this.settings.budgetKbps = Number(this.budgetInput.value) * 1000
          this.persist()
          this.renderBudget()
          void this.tickStats()
        },
      },
    })

    this.budgetLabel = h('span', {
      class: 'tiny mono budget-label',
      style: { minWidth: '96px', textAlign: 'right' },
    })

    this.budgetNote = h('div', { class: 'tiny faint budget-note' })

    this.autoButton = h('button', {
      class: 'chip',
      text: 'Automatic',
      title: 'Let Beam set the budget from what it measures on the live connection.',
      on: {
        click: () => {
          this.settings.budgetAuto = !this.settings.budgetAuto
          if (!this.settings.budgetAuto) this.settings.budgetKbps = this.uplink.estimateKbps
          this.persist()
          this.renderBudget()
          void this.tickStats()
        },
      },
    })

    const codec = h('select', {
      ariaLabel: 'Video codec',
      on: {
        change: () => {
          this.settings.codec = codec.value as CodecChoice
          this.persist()
          toast('The codec applies to the next viewer who joins.', 'info')
        },
      },
    })
    codec.append(h('option', { value: 'auto', text: 'Automatic (recommended)' }))
    for (const name of availableCodecs()) codec.append(h('option', { value: name, text: name }))
    codec.value = this.settings.codec
    this.codecNote = h('div', { class: 'tiny faint codec-note' })

    const maxViewers = h('input', {
      type: 'range',
      min: '1',
      max: '20',
      step: '1',
      value: String(this.settings.maxViewers),
      ariaLabel: 'Viewer limit',
      on: {
        input: () => {
          this.settings.maxViewers = Number(maxViewers.value)
          maxLabel.textContent = maxViewers.value
          this.persist()
          this.renderViewers()
        },
      },
    })
    const maxLabel = h('span', {
      class: 'tiny mono',
      style: { minWidth: '58px', textAlign: 'right' },
      text: String(this.settings.maxViewers),
    })

    const approve = h('button', {
      class: `grow${this.settings.approve ? ' on' : ''}`,
      text: `Approve each viewer: ${this.settings.approve ? 'on' : 'off'}`,
      on: {
        click: () => {
          this.settings.approve = !this.settings.approve
          approve.textContent = `Approve each viewer: ${this.settings.approve ? 'on' : 'off'}`
          approve.classList.toggle('on', this.settings.approve)
          this.persist()
        },
      },
    })

    return h('div', { class: 'card stack tight' }, [
      h('div', { class: 'row spread' }, [
        h('span', { class: 'eyebrow', text: 'Quality' }),
        h('button', {
          class: 'ghost tiny-btn',
          text: 'Reset',
          title: 'Go back to Code and documents at 1080p',
          on: { click: () => void this.applyPreset('docs') },
        }),
      ]),
      this.presetList,
      h('div', { class: 'plan-box stack tight' }, [this.planLine, this.uploadLine]),
      h('details', { class: 'adv' }, [
        h('summary', { text: 'Fine tuning' }),
        h('div', { class: 'stack tight' }, [
          labelled('Resolution', this.resolutionRow, 'The height Beam sends. Lower starts faster.'),
          labelled('Frame rate', this.fpsRow, 'Fewer frames leave more bits for detail.'),
          labelled(
            'Upload budget',
            h('div', { class: 'stack tight' }, [
              h('div', { class: 'row' }, [this.autoButton, this.budgetLabel]),
              this.budgetInput,
              this.budgetNote,
            ]),
          ),
          labelled(
            'Viewer limit',
            h('div', { class: 'row' }, [maxViewers, maxLabel]),
            'Every viewer costs one more encode and one more upload stream.',
          ),
          labelled('Codec', h('div', { class: 'stack tight' }, [codec, this.codecNote])),
          approve,
        ]),
      ]),
    ])
  }

  private renderPresets(): void {
    clear(this.presetList)
    for (const preset of PRESETS) {
      const selected = this.settings.presetId === preset.id
      const row = h(
        'button',
        {
          class: `preset${selected ? ' on' : ''}`,
          title: preset.useWhen,
          on: { click: () => void this.applyPreset(preset.id) },
        },
        [
          h('div', { class: 'row spread', style: { width: '100%' } }, [
            h('span', { class: 'preset-name', text: preset.name }),
            h('span', {
              class: 'tiny mono faint',
              text: `${preset.maxHeight === 0 ? 'source' : `${preset.maxHeight}p`} · ${preset.fps} fps`,
            }),
          ]),
          selected ? h('div', { class: 'tiny dim preset-why', text: preset.useWhen }) : null,
        ],
      )
      this.presetList.append(row)
    }

    if (this.settings.presetId === 'custom') {
      this.presetList.append(
        h('div', { class: 'preset on custom' }, [
          h('div', { class: 'row spread', style: { width: '100%' } }, [
            h('span', { class: 'preset-name', text: 'Custom' }),
            h('span', {
              class: 'tiny mono faint',
              text: `${this.settings.maxHeight === 0 ? 'source' : `${this.settings.maxHeight}p`} · ${this.settings.fps} fps`,
            }),
          ]),
          h('div', {
            class: 'tiny dim preset-why',
            text: 'Your own settings, from the fine tuning below.',
          }),
        ]),
      )
    }
  }

  private renderResolutions(): void {
    clear(this.resolutionRow)
    for (const choice of RESOLUTION_CHOICES) {
      this.resolutionRow.append(
        h('button', {
          class: `chip${this.settings.maxHeight === choice.height ? ' on' : ''}`,
          text: choice.label,
          title: choice.note,
          on: {
            click: () => {
              this.settings.maxHeight = choice.height
              this.markCustom()
              void this.applyCaptureConstraints()
            },
          },
        }),
      )
    }
  }

  private renderFps(): void {
    clear(this.fpsRow)
    for (const choice of FPS_CHOICES) {
      this.fpsRow.append(
        h('button', {
          class: `chip${this.settings.fps === choice.fps ? ' on' : ''}`,
          text: choice.label,
          title: choice.note,
          on: {
            click: () => {
              this.settings.fps = choice.fps
              this.markCustom()
              void this.applyCaptureConstraints()
            },
          },
        }),
      )
    }
  }

  private async applyPreset(id: PresetId): Promise<void> {
    const preset = presetById(id)
    if (!preset) return
    this.settings.presetId = preset.id
    this.settings.mode = preset.mode
    this.settings.maxHeight = preset.maxHeight
    this.settings.fps = preset.fps
    this.settings.bitrateScale = preset.bitrateScale
    this.persist()
    this.renderPresets()
    this.renderResolutions()
    this.renderFps()
    for (const peer of this.peers.values()) {
      peer.setMode(preset.mode, this.settings.codec, this.gpu.hardware)
    }
    await this.applyCaptureConstraints()
    this.renderPlan(this.currentPlan(Math.max(1, this.peers.size)), this.peers.size)
  }

  private markCustom(): void {
    const match = PRESETS.find(
      (p) =>
        p.maxHeight === this.settings.maxHeight &&
        p.fps === this.settings.fps &&
        p.mode === this.settings.mode &&
        p.bitrateScale === this.settings.bitrateScale,
    )
    this.settings.presetId = match ? match.id : 'custom'
    this.persist()
    this.renderPresets()
    this.renderResolutions()
    this.renderFps()
  }

  private persist(): void {
    saveSettings(this.settings)
  }

  /** Push the resolution and the frame rate onto the live capture track. */
  private async applyCaptureConstraints(): Promise<void> {
    const track = this.capture?.video
    if (!track) {
      // Nothing is live yet. The next capture picks these up.
      this.renderPlan(this.currentPlan(1), 0)
      return
    }
    const constraints: MediaTrackConstraints = {
      frameRate: { ideal: this.settings.fps, max: this.settings.fps },
    }
    if (this.settings.maxHeight > 0) {
      constraints.height = { max: this.settings.maxHeight }
      constraints.width = { max: Math.round((this.settings.maxHeight * 16) / 9) }
    }
    try {
      await track.applyConstraints(constraints)
    } catch {
      // Some sources refuse a change once they are live. The sender side caps
      // the frame rate and the resolution anyway, so the stream still obeys.
      toast('This source kept its own size. Beam caps the stream on the way out.', 'info', 5000)
    }
    void this.tickStats()
  }

  // ---- audio ----

  private audioCard(systemAudioLikely: boolean): HTMLElement {
    this.sysMeter = h('i')
    this.micMeter = h('i')

    const sysGain = h('input', {
      type: 'range',
      min: '0',
      max: '150',
      step: '1',
      value: '100',
      ariaLabel: 'Screen audio volume',
      on: { input: () => this.mixer?.setSystemGain(Number(sysGain.value) / 100) },
    })

    const micGain = h('input', {
      type: 'range',
      min: '0',
      max: '150',
      step: '1',
      value: '100',
      disabled: true,
      ariaLabel: 'Microphone volume',
      on: { input: () => this.mixer?.setMicGain(Number(micGain.value) / 100) },
    })

    this.micButton = h('button', {
      class: 'grow',
      text: 'Turn on the microphone',
      on: {
        click: async () => {
          if (this.mixer?.hasMic) {
            this.mixer.stopMic()
            this.micButton.textContent = 'Turn on the microphone'
            this.micButton.classList.remove('on')
            micGain.disabled = true
            return
          }
          try {
            const stream = await captureMicrophone()
            this.mixer?.attachMic(stream)
            this.micButton.textContent = 'Microphone is on'
            this.micButton.classList.add('on')
            micGain.disabled = false
            toast('Your microphone is live for every viewer.', 'info')
          } catch (err) {
            toast(err instanceof CaptureError ? err.message : String(err), 'bad')
          }
        },
      },
    })

    const hasSystem = !!this.capture?.systemAudio
    this.sysNote = h('div', {
      class: 'tiny faint',
      text: hasSystem
        ? 'The audio of the shared screen is going out.'
        : systemAudioLikely
          ? 'No screen audio arrived. Share a tab, tick "Also share tab audio" in the picker, then use Change screen.'
          : 'This browser does not hand over screen audio. Your microphone still works.',
    })

    return h('div', { class: 'card stack tight' }, [
      h('span', { class: 'eyebrow', text: 'Audio' }),
      h('div', { class: 'row' }, [
        h('span', { class: 'tiny', text: 'Screen', style: { width: '54px' } }),
        h('div', { class: 'meter' }, [this.sysMeter]),
      ]),
      sysGain,
      this.sysNote,
      h('hr'),
      this.micButton,
      h('div', { class: 'row' }, [
        h('span', { class: 'tiny', text: 'Mic', style: { width: '54px' } }),
        h('div', { class: 'meter' }, [this.micMeter]),
      ]),
      micGain,
    ])
  }

  private sessionCard(): HTMLElement {
    this.relayLine = h('div', { class: 'row wrap', style: { gap: '6px' } })
    this.elapsed = h('span', { class: 'mono tiny', text: '0:00' })
    return h('div', { class: 'card stack tight' }, [
      h('div', { class: 'row spread' }, [
        h('span', { class: 'tiny faint', text: 'Live for' }),
        this.elapsed,
      ]),
      h('div', { class: 'row spread' }, [
        h('span', { class: 'tiny faint', text: 'Relays' }),
        this.relayLine,
      ]),
      h('button', { class: 'danger', on: { click: () => this.stop() } }, [
        icon('stop', 16),
        'Stop the stream',
      ]),
    ])
  }

  private renderRelays(health: RelayHealth[]): void {
    if (this.phase !== 'live' || !this.relayLine) return
    clear(this.relayLine)
    const open = health.filter((r) => r.status === 'open').length
    for (const r of health) {
      const tone = r.status === 'open' ? 'good' : r.status === 'failed' ? 'bad' : 'warn'
      this.relayLine.append(
        h('span', {
          class: `pill relay ${tone}`,
          text: r.name,
          title: r.detail ? `${r.status}: ${r.detail}` : r.status,
        }),
      )
    }
    if (open === 0) {
      this.relayLine.append(h('span', { class: 'tiny bad', text: 'no relay' }))
    }
  }

  private renderViewers(): void {
    if (this.phase !== 'live' || !this.viewerList) return
    clear(this.viewerList)
    clear(this.statusPills)

    const connected = [...this.peers.values()].filter((p) => p.state === 'connected').length
    document.title = connected > 0 ? `● ${connected} watching · Beam` : 'Sharing · Beam'

    this.statusPills.append(
      h('span', {
        class: `pill ${connected > 0 ? 'good' : ''}`.trim(),
        text: `${connected} of ${this.settings.maxViewers}`,
      }),
    )
    if (this.peers.size > 6) {
      this.statusPills.append(
        h('span', {
          class: 'pill warn',
          text: 'wide mesh',
          title: 'Above six viewers Beam halves the picture it sends, to keep the upload sane.',
        }),
      )
    }

    for (const [id, at] of this.pending) {
      this.viewerList.append(
        h('div', { class: 'viewer-row' }, [
          h('div', { class: 'stack tight' }, [
            h('div', { class: 'mono small', text: `viewer ${id.slice(0, 6)}` }),
            h('div', {
              class: 'tiny warn',
              text: `waiting ${Math.round((Date.now() - at) / 1000)} s for your approval`,
            }),
          ]),
          h('div', { class: 'row', style: { gap: '6px' } }, [
            h('button', {
              class: 'primary small',
              text: 'Approve',
              on: { click: () => this.admit(id) },
            }),
            h('button', {
              class: 'ghost small',
              text: 'Deny',
              on: { click: () => this.drop(id, true) },
            }),
          ]),
        ]),
      )
    }

    if (this.peers.size === 0 && this.pending.size === 0) {
      this.viewerList.append(
        h('div', { class: 'empty' }, [
          h('div', { class: 'small', text: 'Nobody has joined yet.' }),
          h('div', { class: 'tiny faint', text: 'Send the link above. Viewers appear here.' }),
        ]),
      )
      return
    }

    for (const [id, peer] of this.peers) {
      const s = peer.stats
      const grade = gradeOf(s)
      const tone = grade === 'good' ? 'good' : grade === 'ok' ? 'warn' : grade === 'poor' ? 'bad' : ''
      const stateText =
        peer.state === 'failed'
          ? 'connection failed'
          : peer.state === 'disconnected'
            ? 'reconnecting'
            : peer.state === 'new' || peer.state === 'connecting'
              ? 'connecting'
              : peer.state

      const badges = h('div', { class: 'statline' })
      if (peer.state === 'connected') {
        badges.append(
          h('span', { class: `pill ${tone}`.trim(), text: fmtKbps(s.kbps) }),
          h('span', { class: 'pill', text: `${s.width}x${s.height}` }),
          h('span', { class: 'pill', text: `${s.fps} fps` }),
          h('span', { class: 'pill', text: `${s.rttMs} ms` }),
        )
        if (s.lossPct > 0.5) {
          badges.append(h('span', { class: 'pill warn', text: `${s.lossPct}% loss` }))
        }
        if (s.limitation !== 'none' && s.limitation !== '') {
          badges.append(
            h('span', {
              class: 'pill warn',
              text: s.limitation === 'cpu' ? 'processor limited' : `${s.limitation} limited`,
              title:
                s.limitation === 'cpu'
                  ? 'This machine cannot encode fast enough. Lower the resolution or the frame rate.'
                  : 'The upload cannot carry this. Lower the budget or the resolution.',
            }),
          )
        }
        if (s.codec) {
          const onGpu = this.gpu.hardware.includes(s.codec.toUpperCase())
          badges.append(
            h('span', {
              class: `pill ${onGpu ? 'good' : ''}`.trim(),
              text: onGpu ? `${s.codec} on GPU` : s.codec,
              title: onGpu
                ? 'This machine encodes this codec on the GPU, which leaves the processor free.'
                : 'This codec has no hardware encoder here, so encoding runs on the processor.',
            }),
          )
        }
        if (s.encodeMsPerFrame > 0) {
          // How much of one frame interval the encoder eats. Above about half
          // and this machine is close to being the bottleneck, not the network.
          const frameMs = 1000 / Math.max(1, this.settings.fps)
          const share = s.encodeMsPerFrame / frameMs
          badges.append(
            h('span', {
              class: `pill ${share > 0.7 ? 'bad' : share > 0.45 ? 'warn' : ''}`.trim(),
              text: `${s.encodeMsPerFrame.toFixed(1)} ms/frame`,
              title: `Encoding uses ${Math.round(share * 100)} percent of the ${Math.round(frameMs)} ms available per frame${
                s.encoderImpl ? ` on ${s.encoderImpl}` : ''
              }. A high figure costs the machine, not the network.`,
            }),
          )
        }
        if (s.path) badges.append(h('span', { class: 'pill', text: s.path }))
      } else {
        const stateTone =
          peer.state === 'failed' ? 'bad' : peer.state === 'disconnected' ? 'warn' : ''
        badges.append(h('span', { class: `pill ${stateTone}`.trim(), text: stateText }))
      }

      this.viewerList.append(
        h('div', { class: 'viewer-row' }, [
          h('div', { class: 'row', style: { gap: '8px' } }, [
            h('i', { class: `dot ${tone}`.trim() }),
            h('span', { class: 'mono small truncate', text: `viewer ${id.slice(0, 6)}` }),
            h('span', { class: 'tiny faint', text: fmtDuration(Date.now() - peer.joinedAt) }),
          ]),
          h('button', {
            class: 'ghost small',
            text: 'Remove',
            on: { click: () => this.drop(id, true) },
          }),
          badges,
        ]),
      )
    }
  }

  private renderPlan(plan: QualityPlan, viewerCount: number): void {
    if (!this.planLine) return
    const prefix = this.phase === 'live' ? 'Each viewer gets' : 'Each viewer will get'
    const { width, height } = this.sourceSize()
    const ideal = idealBitrateKbps(
      this.settings.mode,
      width,
      height,
      this.settings.bitrateScale,
      this.settings.fps,
    )
    const sentHeight = Math.round(height / plan.scaleDown)
    const sentWidth = Math.round(width / plan.scaleDown)

    this.planLine.textContent = `${prefix} ${sentWidth}x${sentHeight} at ${plan.maxFramerate} fps, about ${fmtKbps(
      plan.maxBitrateKbps,
    )}.`

    const count = Math.max(1, viewerCount)
    const total = plan.maxBitrateKbps * count
    const parts: string[] = [
      `Total upload about ${fmtKbps(total)} for ${count} viewer${count === 1 ? '' : 's'}.`,
    ]
    if (plan.maxBitrateKbps < ideal * 0.95) {
      parts.push('The budget is holding the quality down.')
    }
    this.uploadLine.textContent = parts.join(' ')
    this.uploadLine.classList.toggle('warn', total > this.budgetKbps() * 0.95)
  }

  /** Say plainly whether encoding lands on the GPU or the processor. */
  private renderCodecNote(): void {
    if (!this.codecNote) return
    this.codecNote.textContent = this.gpu.checked
      ? `${this.gpu.note} VP9 and AV1 carry text best.`
      : 'Beam is checking for a hardware encoder. VP9 and AV1 carry text best.'
  }

  /** Keep the budget row honest about the number and where it came from. */
  private renderBudget(): void {
    if (!this.budgetLabel) return
    const auto = this.settings.budgetAuto
    const kbps = this.budgetKbps()

    this.autoButton.classList.toggle('on', auto)
    this.budgetLabel.textContent = `${fmtKbps(kbps)} · ${auto ? this.uplink.label : 'manual'}`
    this.budgetInput.value = String(Math.max(1, Math.round(kbps / 1000)))
    this.budgetInput.disabled = auto
    this.budgetNote.textContent = auto
      ? this.uplink.note
      : 'You set this by hand. Beam keeps to it, and still drops quality if the viewers report loss.'
  }

  private renderPreviewBadges(): void {
    if (this.phase !== 'live') return
    const { width, height } = this.sourceSize()
    const first = [...this.peers.values()][0]
    const preset = presetById(this.settings.presetId)
    const items: { text: string; tone?: 'good' | 'warn' | 'bad' }[] = [
      { text: `${width}x${height}` },
      { text: `${this.settings.fps} fps` },
      { text: preset ? preset.name : 'Custom' },
    ]
    if (first?.codec) items.push({ text: first.codec })
    this.surface?.setBadges(items)
  }

  // ---- actions ----

  private async rotateLink(): Promise<void> {
    for (const peer of this.peers.values()) peer.close()
    this.peers.clear()
    this.pending.clear()
    const secret = newSecret()
    this.room = await deriveRoom(secret)
    this.linkInput.value = roomLink(secret)
    this.openBus()
    this.renderViewers()
    toast('New link ready. Every old link is now dead.', 'info')
  }

  private async changeScreen(): Promise<void> {
    let next: ScreenCapture
    try {
      next = await captureScreen({
        maxHeight: this.settings.maxHeight,
        fps: this.settings.fps,
        wantSystemAudio: this.settings.shareSystemAudio,
      })
    } catch (err) {
      if (err instanceof CaptureError && err.kind === 'denied') return
      toast(err instanceof CaptureError ? err.message : String(err), 'bad')
      return
    }

    const old = this.capture
    this.capture = next
    this.watchCaptureEnd(next.video)

    this.mixer?.attachSystem(next.systemAudio ? new MediaStream([next.systemAudio]) : null)
    this.outStream = new MediaStream([next.video, this.mixer!.track])
    this.surface?.setStream(this.outStream)

    for (const peer of this.peers.values()) {
      peer.setMode(this.settings.mode, this.settings.codec, this.gpu.hardware)
      await peer.replaceVideo(next.video)
    }

    old?.stream.getTracks().forEach((t) => t.stop())
    this.sysNote.textContent = next.systemAudio
      ? 'The audio of the shared screen is going out.'
      : 'No screen audio arrived from this source. Your microphone still works.'
    void this.tickStats()
  }
}
