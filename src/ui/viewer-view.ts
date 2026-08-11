/**
 * The viewer screen.
 *
 * A viewer only ever answers, so the host stays in charge of negotiation. The
 * Join button is also the gesture that lets the browser play sound, which is
 * why nothing starts before the click.
 */

import { checkSupport, viewerBlocker } from '../diagnostics'
import { deriveRoom, newPeerId, type Room } from '../room'
import { SignalBus, type RelayHealth } from '../signal/bus'
import type { Envelope } from '../signal/envelope'
import { ViewerPeer } from '../rtc/viewer-peer'
import { gradeOf } from '../rtc/stats'
import { clear, fmtKbps, h } from './dom'
import type { WindowChrome } from './shell'
import { toast } from './toast'
import { VideoSurface } from './video-surface'

const HELLO_RETRY_MS = 2500
const HELLO_GIVE_UP_MS = 25_000
const STATS_MS = 2000

type Phase = 'ready' | 'connecting' | 'waiting' | 'live' | 'ended' | 'denied' | 'failed'

export class ViewerView {
  private readonly root: HTMLElement
  private readonly secret: string
  private readonly onExit: () => void
  private readonly chrome: WindowChrome | null
  private readonly selfId = newPeerId()

  private room: Room | null = null
  private bus: SignalBus | null = null
  private peer: ViewerPeer | null = null
  private surface: VideoSurface | null = null

  private phase: Phase = 'ready'
  private hostId: string | null = null
  private joinedAt = 0
  private timers: number[] = []
  private relayHealth: RelayHealth[] = []
  private poorTicks = 0
  private lastQualityWarning = 0
  private stopped = false
  private readonly onPageHide = (): void => {
    void this.bus?.send({ type: 'bye' })
  }

  constructor(
    root: HTMLElement,
    secret: string,
    onExit: () => void,
    chrome: WindowChrome | null = null,
  ) {
    this.root = root
    this.secret = secret
    this.onExit = onExit
    this.chrome = chrome
    chrome?.setActions({
      minimise: () => this.surface?.cycleMode(),
      maximise: () => this.surface?.requestFullscreen(),
      close: () => {
        this.stop()
        clear(this.root)
        this.onExit()
      },
    })
  }

  private say(status: string): void {
    this.chrome?.setStatus([status])
  }

  async start(): Promise<void> {
    const support = checkSupport()
    const blocker = viewerBlocker(support)

    this.surface = new VideoSurface({ muted: true, showVolume: true, fullBleed: true })
    this.root.append(h('main', { class: 'pad', style: { padding: '0' } }, [this.surface.root]))

    if (blocker) {
      this.surface.setOverlay(this.message('Beam cannot run here', blocker, []))
      return
    }

    try {
      this.room = await deriveRoom(this.secret)
    } catch {
      this.surface.setOverlay(
        this.message('This link is broken', 'The key in the link is not valid. Ask for a new link.', [
          this.exitButton('Share my own screen'),
        ]),
      )
      return
    }

    this.showJoin()
  }

  /** Watching counts as live: a reload would drop the stream. */
  get isLive(): boolean {
    return this.phase === 'live'
  }

  destroy(): void {
    this.stop()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const t of this.timers) window.clearInterval(t)
    this.timers = []
    window.removeEventListener('pagehide', this.onPageHide)
    void this.bus?.send({ type: 'bye' }).catch(() => undefined)
    this.peer?.close()
    window.setTimeout(() => this.bus?.stop(), 200)
    this.surface?.destroy()
  }

  // ---- phases ----

  private showJoin(): void {
    const card = this.message(
      'Someone shared their screen with you',
      'The picture and the sound travel straight from their computer to yours. No server holds a copy.',
      [
        h('button', {
          class: 'primary big',
          text: 'Join the stream',
          on: { click: () => void this.join() },
        }),
      ],
    )
    card.append(
      h('div', { class: 'shortcuts', style: { justifyContent: 'center', marginTop: '4px' } }, [
        h('kbd', { text: 'F' }),
        h('span', { text: 'Fullscreen' }),
        h('kbd', { text: 'M' }),
        h('span', { text: 'Mute' }),
        h('kbd', { text: 'Z' }),
        h('span', { text: 'Fit, fill, or actual size' }),
        h('kbd', { text: 'Scroll' }),
        h('span', { text: 'Zoom, with control held' }),
      ]),
    )
    this.surface?.setOverlay(card)
    this.say('Ready to join.')
  }

  private async join(): Promise<void> {
    if (!this.room || this.phase !== 'ready') return
    this.phase = 'connecting'
    this.joinedAt = Date.now()

    // The click gave us permission to play sound. Take it now, without waiting,
    // because there is no stream to play yet.
    void this.surface?.playWithSound()

    this.surface?.setOverlay(this.message('Connecting', 'Beam is looking for the host.', []))
    this.say('Connecting to the host...')

    const bus = new SignalBus(this.room, this.selfId)
    bus.onMessage = (env) => void this.onMessage(env)
    bus.onHealth = (health) => {
      this.relayHealth = health
      if (this.phase === 'connecting' && health.every((r) => r.status === 'failed')) {
        this.fail(
          'No relay reachable',
          'Beam could not reach any of its signal relays. A firewall on this network is blocking them.',
        )
      }
    }
    bus.start()
    this.bus = bus
    window.addEventListener('pagehide', this.onPageHide)

    void bus.send({ type: 'hello' })
    this.timers.push(
      window.setInterval(() => {
        if (this.phase === 'connecting' || this.phase === 'waiting') {
          void this.bus?.send({ type: 'hello' })
          if (Date.now() - this.joinedAt > HELLO_GIVE_UP_MS && this.phase !== 'waiting') {
            this.phase = 'waiting'
            this.surface?.setOverlay(this.stuckMessage())
          }
        }
      }, HELLO_RETRY_MS),
    )

    this.timers.push(window.setInterval(() => void this.tickStats(), STATS_MS))
  }

  private async onMessage(env: Envelope): Promise<void> {
    switch (env.type) {
      case 'announce': {
        this.hostId = env.from
        return
      }
      case 'offer': {
        this.hostId = env.from
        if (!this.peer) this.createPeer()
        await this.peer?.onOffer(env.data as RTCSessionDescriptionInit)
        return
      }
      case 'ice': {
        await this.peer?.onIce(env.data as RTCIceCandidateInit)
        return
      }
      case 'deny': {
        // Only the host may turn us away. Anything else on this room is noise.
        if (this.hostId && env.from !== this.hostId) return
        const reason =
          (env.data as { reason?: string } | undefined)?.reason ?? 'The host did not let you in.'
        this.phase = 'denied'
        this.peer?.close()
        this.peer = null
        this.surface?.setStream(null)
        this.surface?.setOverlay(
          this.message('You cannot watch this stream', reason, [
            this.exitButton('Share my own screen'),
          ]),
        )
        return
      }
      case 'bye': {
        // Every viewer says goodbye to the whole room when it leaves. Only the
        // goodbye from the host means the stream is over.
        if (env.from !== this.hostId) return
        if (this.phase === 'live' || this.phase === 'connecting') {
          this.phase = 'ended'
          this.say('The stream ended.')
          this.peer?.close()
          this.peer = null
          this.surface?.setStream(null)
          this.surface?.setBadges([])
          this.surface?.setOverlay(
            this.message('The stream ended', 'The host stopped sharing.', [
              this.exitButton('Share my own screen'),
            ]),
          )
        }
        return
      }
      default:
        return
    }
  }

  private createPeer(): void {
    this.peer = new ViewerPeer({
      send: (type, data) => {
        if (this.hostId) void this.bus?.send({ type, to: this.hostId, data })
      },
      onStream: (stream) => {
        this.surface?.setStream(stream)
        void this.surface?.playWithSound().catch(() => undefined)
      },
      onChange: () => {
        const state = this.peer?.state
        if (state === 'connected' && this.phase !== 'live') {
          this.phase = 'live'
          this.chrome?.setTitle('Beam - watching a shared screen')
          this.surface?.setOverlay(null)
        } else if (state === 'disconnected' && this.phase === 'live') {
          this.surface?.setBadges([{ text: 'reconnecting', tone: 'warn' }])
        }
      },
      onFailed: (reason) => this.fail('The connection failed', reason),
    })
  }

  /**
   * Why nothing is happening, based on what actually arrived. Three cases look
   * the same to a person, so name them apart.
   */
  private stuckMessage(): HTMLElement {
    const openRelays = this.relayHealth.filter((r) => r.status === 'open').length

    if (openRelays === 0) {
      return this.message(
        'Beam cannot reach a relay',
        'This network blocks the connections Beam needs to find the host. Try another network, or a phone hotspot.',
        [this.exitButton('Share my own screen')],
      )
    }

    if (this.bus && this.bus.opened === 0 && this.bus.unreadable > 0) {
      return this.message(
        'This link is not complete',
        'Somebody is streaming here, but the key in your link does not fit. A chat app probably cut the link short. Ask for the whole link again.',
        [this.exitButton('Share my own screen')],
      )
    }

    return this.message(
      'The host is not sharing',
      'Nobody is streaming on this link right now. Beam keeps trying, so leave this page open.',
      [this.exitButton('Share my own screen')],
    )
  }

  private fail(title: string, reason: string): void {
    if (this.phase === 'failed' || this.phase === 'ended') return
    this.phase = 'failed'
    this.surface?.setOverlay(
      this.message(title, reason, [
        h('button', {
          class: 'primary',
          text: 'Try again',
          on: { click: () => window.location.reload() },
        }),
        this.exitButton('Share my own screen'),
      ]),
    )
  }

  private async tickStats(): Promise<void> {
    if (!this.peer || this.phase !== 'live') return
    const s = await this.peer.sample()
    const grade = gradeOf(s)

    // Say it once, in plain words, rather than leaving a person to read numbers.
    if (grade === 'poor') {
      this.poorTicks += 1
      if (this.poorTicks === 3 && Date.now() - this.lastQualityWarning > 60_000) {
        this.lastQualityWarning = Date.now()
        toast(
          'The connection between you and the host is weak. The picture may stutter, and the host can lower the quality to help.',
          'warn',
          8000,
        )
      }
    } else {
      this.poorTicks = 0
    }

    const tone = grade === 'good' ? 'good' : grade === 'ok' ? 'warn' : grade === 'poor' ? 'bad' : undefined
    const badges: { text: string; tone?: 'good' | 'warn' | 'bad' }[] = [
      { text: fmtKbps(s.kbps), tone },
      { text: `${s.width}x${s.height}` },
      { text: `${s.fps} fps` },
    ]
    if (s.rttMs > 0) badges.push({ text: `${s.rttMs} ms` })
    if (s.lossPct > 0.5) badges.push({ text: `${s.lossPct}% loss`, tone: 'warn' })
    if (s.codec) badges.push({ text: s.codec })
    if (s.kbps === 0) badges.push({ text: 'no picture yet', tone: 'warn' })
    this.surface?.setBadges(badges)
    this.chrome?.setStatus([
      `Watching. ${s.width}x${s.height} at ${s.fps} frames.`,
      fmtKbps(s.kbps),
      s.codec || 'negotiating',
    ])
  }

  // ---- small builders ----

  private message(title: string, body: string, actions: HTMLElement[]): HTMLElement {
    const relayNote =
      this.relayHealth.length > 0 && this.phase === 'connecting'
        ? h(
            'div',
            { class: 'row wrap', style: { gap: '6px', justifyContent: 'center', marginTop: '10px' } },
            this.relayHealth.map((r) =>
              h('span', {
                class: `pill ${r.status === 'open' ? 'good' : r.status === 'failed' ? 'bad' : ''}`.trim(),
                text: r.name,
              }),
            ),
          )
        : null

    return h('div', { class: 'sheet stack', style: { textAlign: 'center' } }, [
      h('h2', { text: title, style: { margin: '0', fontSize: '22px' } }),
      h('p', { class: 'dim', text: body, style: { margin: '0' } }),
      actions.length
        ? h('div', { class: 'row', style: { justifyContent: 'center', gap: '10px' } }, actions)
        : null,
      relayNote,
    ])
  }

  private exitButton(text: string): HTMLButtonElement {
    return h('button', {
      text,
      on: {
        click: () => {
          this.stop()
          clear(this.root)
          this.onExit()
        },
      },
    })
  }
}

export function warnUnsupportedHost(): void {
  const s = checkSupport()
  if (s.isIOS) {
    toast('This device can watch a stream, but it cannot share a screen.', 'info', 7000)
  }
}
