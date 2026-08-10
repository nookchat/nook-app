/**
 * The host screen.
 *
 * It owns the capture, the mixer, one HostPeer per viewer, and the quality
 * budget. Everything a viewer needs travels over the signal bus until the peer
 * connection stands up, and after that the bus only waits for new arrivals.
 */

import { hostNotes, checkSupport } from '../diagnostics'
import { AudioMixer } from '../media/mixer'
import { captureMicrophone, captureScreen, CaptureError, type ScreenCapture } from '../media/capture'
import { deriveRoom, newPeerId, newSecret, roomLink, type Room } from '../room'
import { SignalBus, type RelayHealth } from '../signal/bus'
import type { Envelope } from '../signal/envelope'
import { HostPeer } from '../rtc/host-peer'
import {
  availableCodecs,
  idealBitrateKbps,
  planFor,
  type CodecChoice,
  type Mode,
  type QualityPlan,
} from '../rtc/quality'
import { gradeOf } from '../rtc/stats'
import { clear, copyText, fmtDuration, fmtKbps, h, labelled } from './dom'
import { toast } from './toast'
import { VideoSurface } from './video-surface'

const ANNOUNCE_MS = 4000
const STATS_MS = 2000
const REAP_MS = 10_000
const PENDING_TTL_MS = 120_000

interface Settings {
  mode: Mode
  codec: CodecChoice
  budgetKbps: number
  maxViewers: number
  approve: boolean
  maxHeight: number
  fps: number
}

const DEFAULTS: Settings = {
  mode: 'text',
  codec: 'auto',
  budgetKbps: 8000,
  maxViewers: 10,
  approve: false,
  maxHeight: 0,
  fps: 30,
}

export class HostView {
  private readonly root: HTMLElement
  private readonly onExit: () => void
  private readonly selfId = newPeerId()
  private readonly settings: Settings = { ...DEFAULTS }

  private room: Room | null = null
  private bus: SignalBus | null = null
  private capture: ScreenCapture | null = null
  private mixer: AudioMixer | null = null
  private outStream: MediaStream | null = null
  private surface: VideoSurface | null = null

  private readonly peers = new Map<string, HostPeer>()
  private readonly pending = new Map<string, number>()
  private readonly startedAt = Date.now()

  private effectiveBudget = DEFAULTS.budgetKbps
  private congestedTicks = 0
  private lastBudgetDrop = 0

  private timers: number[] = [];
  private stopped = false

  // Elements we update in place.
  private linkInput!: HTMLInputElement
  private statusPills!: HTMLDivElement
  private viewerList!: HTMLDivElement
  private planLine!: HTMLDivElement
  private sysMeter!: HTMLElement
  private micMeter!: HTMLElement
  private micButton!: HTMLButtonElement
  private sysNote!: HTMLDivElement
  private relayLine!: HTMLDivElement
  private elapsed!: HTMLSpanElement

  constructor(root: HTMLElement, onExit: () => void) {
    this.root = root
    this.onExit = onExit
  }

  /** Call this straight from a click handler, so the capture prompt is allowed. */
  async start(): Promise<void> {
    try {
      this.capture = await captureScreen({
        maxHeight: this.settings.maxHeight,
        fps: this.settings.fps,
        wantSystemAudio: true,
      })
    } catch (err) {
      const message =
        err instanceof CaptureError ? err.message : `The screen share failed: ${String(err)}`
      toast(message, 'bad', 8000)
      // Nothing was opened, so mark the view finished before we hand back.
      this.stopped = true
      this.onExit()
      return
    }

    this.mixer = new AudioMixer()
    await this.mixer.resume()
    this.mixer.attachSystem(
      this.capture.systemAudio ? new MediaStream([this.capture.systemAudio]) : null,
    )

    this.outStream = new MediaStream([this.capture.video, this.mixer.track])

    // The browser puts its own "Stop sharing" bar on screen. Respect it.
    this.capture.video.addEventListener('ended', () => {
      toast('You stopped the screen share, so the stream ended.', 'warn')
      this.stop()
    })

    const secret = newSecret()
    this.room = await deriveRoom(secret)
    this.render(secret)
    this.openBus()
    this.startLoops()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const t of this.timers) window.clearInterval(t)
    this.timers = []
    void this.bus?.send({ type: 'bye' }).catch(() => undefined)
    for (const peer of this.peers.values()) peer.close()
    this.peers.clear()
    this.pending.clear()
    window.setTimeout(() => this.bus?.stop(), 250)
    this.surface?.destroy()
    this.capture?.stream.getTracks().forEach((t) => t.stop())
    this.mixer?.close()
    this.onExit()
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
            data: { reason: `This stream is full. The host allows ${this.settings.maxViewers} viewers.` },
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
      send: (type, data) => void this.bus?.send({ type, to: viewerId, data }),
      onChange: () => this.renderViewers(),
      onFailed: (reason) => toast(reason, 'bad', 8000),
    })
    this.peers.set(viewerId, peer)
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

    this.adaptBudget(peers)

    const plan = this.currentPlan(Math.max(1, peers.length))
    for (const peer of peers) await peer.setPlan(plan)

    this.renderViewers()
    this.renderPlan(plan, peers.length)
    this.renderPreviewBadges()
  }

  /**
   * The upload budget slider is the ceiling the host set. This lowers the real
   * budget when the viewers report loss, and it walks back up when the loss
   * clears. WebRTC adapts on its own too, but a mesh needs a shared ceiling,
   * otherwise every connection fights the others for the same uplink.
   */
  private adaptBudget(peers: HostPeer[]): void {
    const live = peers.filter((p) => p.state === 'connected' && p.stats.kbps > 0)
    if (live.length === 0) {
      this.effectiveBudget = this.settings.budgetKbps
      return
    }
    const avgLoss = live.reduce((sum, p) => sum + p.stats.lossPct, 0) / live.length
    const now = Date.now()

    if (avgLoss > 3) {
      this.congestedTicks += 1
      if (this.congestedTicks >= 2) {
        const next = Math.max(1000, Math.round(this.effectiveBudget * 0.8))
        if (next < this.effectiveBudget) {
          this.effectiveBudget = next
          this.lastBudgetDrop = now
        }
        this.congestedTicks = 0
      }
      return
    }

    this.congestedTicks = 0
    if (
      avgLoss < 0.5 &&
      this.effectiveBudget < this.settings.budgetKbps &&
      now - this.lastBudgetDrop > 15_000
    ) {
      this.effectiveBudget = Math.min(
        this.settings.budgetKbps,
        Math.round(this.effectiveBudget * 1.1),
      )
    }
  }

  private currentPlan(viewerCount: number): QualityPlan {
    const s = this.capture?.video.getSettings()
    return planFor({
      mode: this.settings.mode,
      budgetKbps: Math.min(this.effectiveBudget, this.settings.budgetKbps),
      viewerCount,
      width: s?.width ?? 1920,
      height: s?.height ?? 1080,
    })
  }

  private reap(): void {
    const now = Date.now()
    for (const [id, at] of this.pending) {
      if (now - at > PENDING_TTL_MS) this.pending.delete(id)
    }
    for (const [id, peer] of this.peers) {
      if (peer.state === 'closed') this.peers.delete(id)
    }
    this.renderViewers()
  }

  private tickMeters(): void {
    const levels = this.mixer?.levels() ?? { system: 0, mic: 0 }
    this.sysMeter.style.width = `${Math.round(levels.system * 100)}%`
    this.micMeter.style.width = `${Math.round(levels.mic * 100)}%`
  }

  // ---- render ----

  private render(secret: string): void {
    clear(this.root)
    const support = checkSupport()

    this.surface = new VideoSurface({ muted: true, showVolume: false })
    this.surface.setStream(this.outStream)
    this.surface.setMode('fit')

    this.linkInput = h('input', {
      type: 'text',
      readOnly: true,
      value: roomLink(secret),
      ariaLabel: 'The link to share',
      on: { focus: (ev) => (ev.target as HTMLInputElement).select() },
    })

    this.statusPills = h('div', { class: 'row wrap', style: { gap: '6px' } })
    this.viewerList = h('div', {})
    this.planLine = h('div', { class: 'tiny faint plan-line' })
    this.relayLine = h('div', { class: 'row wrap', style: { gap: '6px' } })
    this.elapsed = h('span', { class: 'mono tiny', text: '0:00' })

    const side = h('div', { class: 'host-side' }, [
      this.linkCard(),
      this.viewersCard(),
      this.qualityCard(),
      this.audioCard(support.systemAudio),
      this.sessionCard(),
      ...hostNotes(support).map((n) => h('div', { class: 'card tiny dim', text: n })),
    ])

    this.root.append(
      h('div', { class: 'host-grid' }, [
        h('div', { class: 'stack', style: { minHeight: '0' } }, [this.surface.root]),
        side,
      ]),
    )

    this.renderViewers()
    this.renderPlan(this.currentPlan(1), 0)
  }

  private linkCard(): HTMLElement {
    const copyButton = h('button', {
      class: 'primary',
      text: 'Copy',
      on: {
        click: async () => {
          const ok = await copyText(this.linkInput.value)
          copyButton.textContent = ok ? 'Copied' : 'Copy failed'
          window.setTimeout(() => (copyButton.textContent = 'Copy'), 1600)
          if (!ok) this.linkInput.select()
        },
      },
    })

    return h('div', { class: 'card stack tight' }, [
      h('div', { class: 'row spread' }, [
        h('strong', { text: 'Share this link' }),
        h('span', { class: 'pill good' }, [h('i', { class: 'dot live' }), 'live']),
      ]),
      h('div', { class: 'linkbox' }, [this.linkInput, copyButton]),
      h('div', {
        class: 'tiny faint',
        text: 'The key after the # never reaches the webserver. Anyone who holds this link can watch.',
      }),
      h('div', { class: 'row', style: { marginTop: '4px' } }, [
        h('button', {
          class: 'ghost small',
          text: 'New link',
          title: 'Rotate the key. Every old link stops working.',
          on: { click: () => void this.rotateLink() },
        }),
        h('button', {
          class: 'ghost small',
          text: 'Change screen',
          title: 'Share a different window, tab, or display.',
          on: { click: () => void this.changeScreen() },
        }),
      ]),
    ])
  }

  private viewersCard(): HTMLElement {
    return h('div', { class: 'card stack tight' }, [
      h('div', { class: 'row spread' }, [h('strong', { text: 'Viewers' }), this.statusPills]),
      this.viewerList,
    ])
  }

  private qualityCard(): HTMLElement {
    const modeButtons = (['text', 'motion'] as Mode[]).map((m) =>
      h('button', {
        class: `grow${this.settings.mode === m ? ' on' : ''}`,
        text: m === 'text' ? 'Text' : 'Video',
        title:
          m === 'text'
            ? 'Sharp text. Keeps resolution, drops frame rate.'
            : 'Smooth motion. Keeps frame rate, drops resolution.',
        on: {
          click: (ev) => {
            this.settings.mode = m
            const bar = (ev.currentTarget as HTMLElement).parentElement!
            for (const b of Array.from(bar.children)) b.classList.remove('on')
            ;(ev.currentTarget as HTMLElement).classList.add('on')
            for (const peer of this.peers.values()) peer.setMode(m, this.settings.codec)
            void this.tickStats()
          },
        },
      }),
    )

    const budget = h('input', {
      type: 'range',
      min: '1',
      max: '50',
      step: '1',
      value: String(this.settings.budgetKbps / 1000),
      ariaLabel: 'Total upload budget',
      on: {
        input: () => {
          this.settings.budgetKbps = Number(budget.value) * 1000
          this.effectiveBudget = this.settings.budgetKbps
          budgetLabel.textContent = `${budget.value} Mb/s total`
          void this.tickStats()
        },
      },
    })
    const budgetLabel = h('span', {
      class: 'tiny mono',
      text: `${this.settings.budgetKbps / 1000} Mb/s total`,
    })

    const cap = h('select', {
      ariaLabel: 'Source resolution cap',
      on: {
        change: () => {
          this.settings.maxHeight = Number(cap.value)
          void this.applySourceCap()
        },
      },
    })
    for (const [label, value] of [
      ['Original', '0'],
      ['1440p', '1440'],
      ['1080p', '1080'],
      ['720p', '720'],
    ]) {
      cap.append(h('option', { value, text: label }))
    }

    const codec = h('select', {
      ariaLabel: 'Video codec',
      on: {
        change: () => {
          this.settings.codec = codec.value as CodecChoice
          toast('The codec applies to the next viewer who joins.', 'info')
        },
      },
    })
    codec.append(h('option', { value: 'auto', text: 'Automatic' }))
    for (const name of availableCodecs()) codec.append(h('option', { value: name, text: name }))

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
          maxLabel.textContent = `${maxViewers.value} viewers`
          this.renderViewers()
        },
      },
    })
    const maxLabel = h('span', { class: 'tiny mono', text: `${this.settings.maxViewers} viewers` })

    const approve = h('button', {
      class: 'grow',
      text: 'Approve each viewer: off',
      on: {
        click: () => {
          this.settings.approve = !this.settings.approve
          approve.textContent = `Approve each viewer: ${this.settings.approve ? 'on' : 'off'}`
          approve.classList.toggle('on', this.settings.approve)
        },
      },
    })

    return h('div', { class: 'card stack tight' }, [
      h('strong', { text: 'Quality' }),
      h('div', { class: 'row', style: { gap: '6px' } }, modeButtons),
      labelled('Upload budget', h('div', { class: 'row' }, [budget, budgetLabel])),
      this.planLine,
      h('details', { class: 'adv' }, [
        h('summary', { text: 'Advanced' }),
        h('div', { class: 'stack tight' }, [
          labelled('Source resolution', cap, 'Cap a 4K display to save your processor.'),
          labelled('Codec', codec, 'VP9 and AV1 carry text best.'),
          labelled('Viewer limit', h('div', { class: 'row' }, [maxViewers, maxLabel])),
          approve,
        ]),
      ]),
    ])
  }

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
          ? 'No screen audio arrived. Share a tab, or tick "Share tab audio" in the picker, then use Change screen.'
          : 'This browser does not hand over screen audio. Your microphone still works.',
    })

    return h('div', { class: 'card stack tight' }, [
      h('strong', { text: 'Audio' }),
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
    return h('div', { class: 'card stack tight' }, [
      h('div', { class: 'row spread' }, [
        h('span', { class: 'tiny faint', text: 'Live for' }),
        this.elapsed,
      ]),
      h('div', { class: 'row spread' }, [
        h('span', { class: 'tiny faint', text: 'Relays' }),
        this.relayLine,
      ]),
      h('button', {
        class: 'danger',
        text: 'Stop the stream',
        on: { click: () => this.stop() },
      }),
    ])
  }

  private renderRelays(health: RelayHealth[]): void {
    if (!this.relayLine) return
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
    if (!this.viewerList) return
    clear(this.viewerList)
    clear(this.statusPills)

    const connected = [...this.peers.values()].filter((p) => p.state === 'connected').length
    this.statusPills.append(
      h('span', {
        class: `pill ${connected > 0 ? 'good' : ''}`.trim(),
        text: `${connected} of ${this.settings.maxViewers}`,
      }),
    )
    if (this.peers.size > 6) {
      this.statusPills.append(h('span', { class: 'pill warn', text: 'wide mesh' }))
    }

    for (const [id, at] of this.pending) {
      this.viewerList.append(
        h('div', { class: 'viewer-row' }, [
          h('div', { class: 'stack tight' }, [
            h('div', { class: 'mono small', text: `viewer ${id.slice(0, 6)}` }),
            h('div', {
              class: 'tiny warn faint',
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
        h('div', {
          class: 'tiny faint',
          text: 'Nobody has joined yet. Send the link above.',
          style: { paddingTop: '8px' },
        }),
      )
      return
    }

    for (const [id, peer] of this.peers) {
      const s = peer.stats
      const grade = gradeOf(s)
      const tone = grade === 'good' ? 'good' : grade === 'ok' ? 'warn' : grade === 'poor' ? 'bad' : ''
      const stateText =
        peer.state === 'connected'
          ? 'connected'
          : peer.state === 'failed'
            ? 'failed'
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
          badges.append(h('span', { class: 'pill warn', text: `limited: ${s.limitation}` }))
        }
        if (s.codec) badges.append(h('span', { class: 'pill', text: s.codec }))
        if (s.path) badges.append(h('span', { class: 'pill', text: s.path }))
      } else {
        badges.append(h('span', { class: 'pill', text: stateText }))
      }

      this.viewerList.append(
        h('div', { class: 'viewer-row' }, [
          h('div', { class: 'row', style: { gap: '8px' } }, [
            h('i', { class: `dot ${tone}`.trim(), style: { color: 'currentColor' } }),
            h('span', { class: 'mono small truncate', text: `viewer ${id.slice(0, 6)}` }),
            h('span', {
              class: 'tiny faint',
              text: fmtDuration(Date.now() - peer.joinedAt),
            }),
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
    const s = this.capture?.video.getSettings()
    const ideal = idealBitrateKbps(this.settings.mode, s?.width ?? 1920, s?.height ?? 1080)
    const scaleText = plan.scaleDown > 1 ? `, scaled to 1/${plan.scaleDown}` : ''
    const capped = plan.maxBitrateKbps < ideal ? ' (budget limited)' : ''
    const adapted =
      this.effectiveBudget < this.settings.budgetKbps
        ? ` Beam lowered the budget to ${fmtKbps(this.effectiveBudget)} because of packet loss.`
        : ''
    this.planLine.textContent = `Each of ${Math.max(1, viewerCount)} viewers gets ${fmtKbps(
      plan.maxBitrateKbps,
    )} at ${plan.maxFramerate} fps${scaleText}${capped}.${adapted}`
  }

  private renderPreviewBadges(): void {
    const s = this.capture?.video.getSettings()
    const first = [...this.peers.values()][0]
    const items: { text: string; tone?: 'good' | 'warn' | 'bad' }[] = [
      { text: `${s?.width ?? 0}x${s?.height ?? 0} source` },
      { text: `${Math.round(s?.frameRate ?? 0)} fps capture` },
      { text: this.settings.mode === 'text' ? 'Text mode' : 'Video mode' },
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
        wantSystemAudio: true,
      })
    } catch (err) {
      if (err instanceof CaptureError && err.kind === 'denied') return
      toast(err instanceof CaptureError ? err.message : String(err), 'bad')
      return
    }

    const old = this.capture
    this.capture = next
    next.video.addEventListener('ended', () => {
      toast('You stopped the screen share, so the stream ended.', 'warn')
      this.stop()
    })

    this.mixer?.attachSystem(next.systemAudio ? new MediaStream([next.systemAudio]) : null)
    this.outStream = new MediaStream([next.video, this.mixer!.track])
    this.surface?.setStream(this.outStream)

    for (const peer of this.peers.values()) {
      peer.setMode(this.settings.mode, this.settings.codec)
      await peer.replaceVideo(next.video)
    }

    old?.stream.getTracks().forEach((t) => t.stop())
    this.sysNote.textContent = next.systemAudio
      ? 'The audio of the shared screen is going out.'
      : 'No screen audio arrived from this source. Your microphone still works.'
    void this.tickStats()
  }

  private async applySourceCap(): Promise<void> {
    const track = this.capture?.video
    if (!track) return
    try {
      if (this.settings.maxHeight === 0) {
        await track.applyConstraints({ frameRate: { ideal: this.settings.fps, max: 60 } })
      } else {
        await track.applyConstraints({
          height: { max: this.settings.maxHeight },
          width: { max: Math.round((this.settings.maxHeight * 16) / 9) },
          frameRate: { ideal: this.settings.fps, max: 60 },
        })
      }
      void this.tickStats()
    } catch {
      toast('This browser refused the resolution cap for the current source.', 'warn')
    }
  }
}
