/**
 * A space.
 *
 * This is the app now. Chat is the thing, and a screen share is something that
 * happens inside a channel rather than the reason the room exists. There is no
 * host: everybody in a space is a peer, joined in a mesh, and the space carries
 * on whether or not anyone is sharing.
 *
 * Two kinds of connection live here, deliberately kept apart:
 *
 *   mesh     one data channel to every other member, made once, never
 *            renegotiated. Carries chat.
 *   share    the sharer opens a fresh connection to each watcher, exactly as
 *            before, and is always the offerer. Carries video and audio.
 *
 * Keeping them separate costs one extra handshake per pair while video is
 * running, and buys the absence of every glare and renegotiation problem that
 * one shared connection would have brought.
 */

import { checkSupport, hostBlocker } from '../diagnostics'
import { captureMicrophone, captureScreen, CaptureError, type ScreenCapture } from '../media/capture'
import { AudioMixer } from '../media/mixer'
import { Mesh } from '../net/mesh'
import { Voice } from '../net/voice'
import { UplinkMeter } from '../net/uplink'
import { deriveRoom, formatSecret, newPeerId, roomLink, shortLink, type Room } from '../room'
import { HostPeer } from '../rtc/host-peer'
import { ViewerPeer } from '../rtc/viewer-peer'
import { NO_HARDWARE, probeHardwareEncoders, type HardwareProbe } from '../rtc/hardware'
import {
  availableCodecs,
  FPS_CHOICES,
  planFor,
  PRESETS,
  presetById,
  RESOLUTION_CHOICES,
  type CodecChoice,
  type PresetId,
  type QualityPlan,
} from '../rtc/quality'
import { SignalBus } from '../signal/bus'
import type { Envelope } from '../signal/envelope'
import { loadSettings, saveSettings, type HostSettings } from '../settings'
import { getRoom, noteRoom } from '../store/db'
import { loadIdentity, shortKey } from '../store/identity'
import { settingsView } from './settings-view'
import { chirpJoin, chirpLeave, chirpMessage, isNews } from './sounds'
import { DEFAULT_CHANNEL, DEFAULT_VOICE, cleanChannel, type LogEvent } from '../store/log'
import { RoomChat } from '../store/room-chat'
import { ChatPanel } from './chat-panel'
import { clear, copyText, fmtKbps, h, labelled } from './dom'
import { icon } from './icons'
import { qrSvg } from './qr'
import type { WindowChrome } from './shell'
import { toast } from './toast'
import { VideoSurface } from './video-surface'

const STATS_MS = 2000

export class SpaceView {
  private readonly root: HTMLElement
  private readonly chrome: WindowChrome | null
  private readonly secret: string
  private readonly selfId = newPeerId()
  private settings: HostSettings = loadSettings()

  private room: Room | null = null
  private bus: SignalBus | null = null
  private mesh: Mesh | null = null
  private chat: RoomChat | null = null
  private chatPanel: ChatPanel | null = null
  private surface: VideoSurface | null = null

  private channel = DEFAULT_CHANNEL
  private drawQueued = false
  private readonly locked: boolean
  private readonly password: string
  /** True when this person just made the space, so they claim it. */
  private readonly fresh: boolean
  private readonly wantedName: string
  private spaceTitle!: HTMLSpanElement
  private voice: Voice | null = null
  private stopped = false
  private timers: number[] = []

  // Sharing, when this person is the one doing it.
  private capture: ScreenCapture | null = null
  private mixer: AudioMixer | null = null
  private outStream: MediaStream | null = null
  private readonly watchers = new Map<string, HostPeer>()
  private gpu: HardwareProbe = NO_HARDWARE
  private readonly uplink = new UplinkMeter()

  // Watching, when somebody else is.
  private watching: ViewerPeer | null = null
  private watchingWho: string | null = null
  /** Who is sharing, and in which channel. */
  private readonly sharers = new Map<string, string>()

  // Elements redrawn in place.
  private channelList!: HTMLDivElement
  private voiceList!: HTMLDivElement
  private peopleList!: HTMLDivElement
  private voiceBar!: HTMLDivElement
  private shell!: HTMLElement
  private stage!: HTMLDivElement
  private shareButton!: HTMLButtonElement
  private sharePanel!: HTMLDivElement
  private channelTitle!: HTMLSpanElement

  constructor(
    root: HTMLElement,
    secret: string,
    chrome: WindowChrome | null,
    onLeave: () => void,
    lock: { locked: boolean; password: string; fresh?: boolean; name?: string } = {
      locked: false,
      password: '',
    },
  ) {
    this.root = root
    this.secret = secret
    this.chrome = chrome
    this.locked = lock.locked
    this.password = lock.password
    this.fresh = lock.fresh === true
    this.wantedName = lock.name ?? ''
    chrome?.setActions({
      minimise: () => this.root.classList.toggle('rail-hidden'),
      maximise: () => this.surface?.requestFullscreen(),
      close: () => {
        this.destroy()
        onLeave()
      },
    })
  }

  get isLive(): boolean {
    return this.capture !== null || this.watching !== null
  }

  async start(): Promise<void> {
    this.renderShell()

    try {
      this.room = await deriveRoom(this.secret, this.password)
    } catch {
      this.stage.append(h('div', { class: 'empty', text: 'That room code is not valid.' }))
      return
    }

    const identity = loadIdentity()
    const note = await getRoom(this.room.id)
    const chat = new RoomChat(this.room.id, this.secret, note?.founder ?? '')
    chat.onChange = () => this.draw()
    chat.onFounder = (pubkey) => void this.remember({ founder: pubkey })
    await chat.load()
    this.chat = chat
    this.chatPanel?.setMe(chat.me)
    this.chatPanel?.setName(chat.displayName)

    const bus = new SignalBus(this.room, this.selfId)
    const voice = new Voice(bus, this.selfId)
    voice.onChange = () => this.draw()
    voice.onArrival = (arrived) => (arrived ? chirpJoin() : chirpLeave())
    this.voice = voice
    const mesh = new Mesh(bus, this.selfId, identity.name)
    mesh.extra = () => ({
      sharing: this.capture ? this.channel : undefined,
      voice: this.voice?.state.channel ?? undefined,
    })
    mesh.onData = (from, raw) => void this.onMeshData(from, raw)
    mesh.onPeers = () => this.draw()
    bus.onMessage = (env) => void this.onSignal(env)
    bus.onHealth = () => this.status()
    bus.start()
    mesh.start()
    this.bus = bus
    this.mesh = mesh

    // Whoever made the space claims it, once, and becomes its first admin.
    if (this.fresh && !chat.founder) {
      await chat.claimFounder()
      await this.remember({ founder: chat.me })
      if (this.wantedName) await chat.setSpaceName(this.wantedName)
    }
    await chat.announceName(chat.displayName)
    void probeHardwareEncoders(availableCodecs()).then((probe) => (this.gpu = probe))

    this.timers.push(window.setInterval(() => void this.tick(), STATS_MS))
    this.draw()
    this.status()
  }

  destroy(): void {
    if (this.stopped) return
    this.stopped = true
    for (const t of this.timers) window.clearInterval(t)
    this.timers = []
    this.stopSharing()
    this.voice?.dispose()
    this.watching?.close()
    this.watching = null
    this.mesh?.stop()
    const bus = this.bus
    this.bus = null
    if (bus) window.setTimeout(() => bus.stop(), 200)
    this.surface?.destroy()
    document.title = 'Cathode'
  }

  // ---- signalling ----

  private async onSignal(env: Envelope): Promise<void> {
    await this.mesh?.handle(env)
    await this.voice?.handle(env)

    const data = (env.data ?? {}) as Record<string, unknown>
    switch (env.type) {
      case 'announce': {
        const standing = typeof data.voice === 'string' ? cleanChannel(data.voice) : ''
        this.voice?.noteAnnounce(env.from, standing || null)
        const sharing = typeof data.sharing === 'string' ? cleanChannel(data.sharing) : ''
        const was = this.sharers.get(env.from)
        if (sharing) this.sharers.set(env.from, sharing)
        else this.sharers.delete(env.from)
        if (was !== sharing) this.draw()
        // Somebody is sharing in the channel we are looking at, so ask to watch.
        if (sharing === this.channel && !this.watching && env.from !== this.selfId) {
          this.watchingWho = env.from
          void this.bus?.send({ type: 'hello', to: env.from })
        }
        return
      }
      case 'hello': {
        // Only meaningful when we are the one sharing.
        if (!this.outStream) return
        this.watchers.get(env.from)?.close()
        this.watchers.delete(env.from)
        this.admitWatcher(env.from)
        return
      }
      case 'offer': {
        if (!this.watching) this.startWatching(env.from)
        await this.watching?.onOffer(data as unknown as RTCSessionDescriptionInit)
        return
      }
      case 'answer': {
        await this.watchers.get(env.from)?.onAnswer(data as unknown as RTCSessionDescriptionInit)
        return
      }
      case 'ice': {
        if (this.watchers.has(env.from)) {
          await this.watchers.get(env.from)?.onIce(data as unknown as RTCIceCandidateInit)
        } else if (env.from === this.watchingWho) {
          await this.watching?.onIce(data as unknown as RTCIceCandidateInit)
        }
        return
      }
      case 'bye': {
        this.voice?.forget(env.from)
        this.watchers.get(env.from)?.close()
        this.watchers.delete(env.from)
        if (env.from === this.watchingWho) this.stopWatching()
        return
      }
      default:
        return
    }
  }

  private async onMeshData(_from: string, raw: string): Promise<void> {
    const fresh = (await this.chat?.ingest(raw)) ?? []
    if (fresh.length === 0) return
    // Somebody else said something, and said it just now rather than last week.
    if (fresh.some((e) => e.kind === 'said' && e.author !== this.chat?.me && isNews(e.at))) {
      chirpMessage()
    }
    // Pass on what was new, so a line reaches people we are not linked to.
    for (const wire of this.chat?.encode(fresh) ?? []) this.mesh?.broadcast(wire)
  }

  // ---- chat ----

  private async publish(make: (chat: RoomChat) => Promise<LogEvent>): Promise<void> {
    if (!this.chat) return
    const event = await make(this.chat)
    for (const raw of this.chat.encode([event])) this.mesh?.broadcast(raw)
  }

  /**
   * Redraw at most once a frame.
   *
   * Announcements, presence sweeps, chat merges and the stats tick all want a
   * redraw, and together they were rebuilding the rail many times a second. That
   * is wasted work, and it made the buttons move under the pointer.
   */
  private draw(): void {
    if (this.stopped || this.drawQueued) return
    this.drawQueued = true
    requestAnimationFrame(() => {
      this.drawQueued = false
      this.drawNow()
    })
  }

  private drawNow(): void {
    if (this.stopped || !this.chat) return
    this.chatPanel?.render(this.chat.messages(this.channel))
    this.chatPanel?.setPresence(this.mesh?.reach ?? 1)
    this.channelTitle.textContent = `#${this.channel}`
    const name = this.chat?.spaceName() || 'Unnamed space'
    if (this.spaceTitle.textContent !== name) {
      this.spaceTitle.textContent = name
      void this.remember({ name })
    }
    this.renderChannels()
    this.renderVoice()
    this.renderPeople()
    this.renderShareButton()
    this.status()
  }

  /** Keep what this device knows about the space up to date. */
  private async remember(patch: Partial<{ founder: string; name: string }>): Promise<void> {
    if (!this.room) return
    const existing = await getRoom(this.room.id)
    await noteRoom({
      room: this.room.id,
      secret: this.secret,
      lastSeen: Date.now(),
      title: patch.name ?? this.chat?.spaceName() ?? existing?.title ?? '',
      locked: this.locked,
      founder: patch.founder ?? existing?.founder ?? this.chat?.founder ?? '',
    })
  }

  private status(): void {
    if (!this.chrome) return
    const relays = this.bus?.healthList.filter((r) => r.status === 'open').length ?? 0
    const people = this.mesh?.peers().length ?? 0
    const what = this.capture
      ? 'Sharing your screen'
      : this.watching
        ? 'Watching a shared screen'
        : `#${this.channel}`
    this.chrome.setTitle(this.capture ? 'Sharing your screen' : `#${this.channel}`)
    this.chrome.setStatus([
      what,
      `${people + 1} here`,
      `${relays} relay${relays === 1 ? '' : 's'}`,
    ])
  }

  // ---- layout ----

  private renderShell(): void {
    clear(this.root)

    this.channelList = h('div', { class: 'rail-list' })
    this.voiceList = h('div', { class: 'rail-list' })
    this.peopleList = h('div', { class: 'rail-list' })
    this.voiceBar = h('div', { class: 'voice-bar hidden' })
    this.stage = h('div', { class: 'stage hidden' })
    this.channelTitle = h('span', { class: 'eyebrow', text: `#${this.channel}` })

    this.shareButton = h('button', { class: 'primary grow' }, [icon('monitor', 15), 'Share screen'])
    this.shareButton.addEventListener('click', () => void this.toggleShare())

    this.sharePanel = h('div', { class: 'share-panel hidden' })

    this.chatPanel = new ChatPanel(loadIdentity().name, 'Chat')
    this.chatPanel.showNameField(false)
    this.chatPanel.actions = {
      say: (text, replyTo) => void this.publish((c) => c.say(text, this.channel, replyTo)),
      edit: (id, text) => void this.publish((c) => c.edit(id, text)),
      react: (id, emoji, on) => void this.publish((c) => c.react(id, emoji, on)),
      retract: (id) => void this.publish((c) => c.retract(id)),
      rename: (name) => this.rename(name),
    }
    this.chatPanel.setEnabled(true)

    this.spaceTitle = h('span', { class: 'space-name truncate', text: 'Unnamed space' })

    const left = h('div', { class: 'rail rail-left' }, [
      h('div', { class: 'rail-head space-title' }, [
        this.spaceTitle,
        h('button', {
          class: 'ghost tiny-btn',
          text: '✎',
          title: 'Rename this space. Admins only.',
          on: { click: () => void this.renameSpace() },
        }),
      ]),
      h('div', { class: 'rail-head' }, [
        h('span', { class: 'eyebrow', text: 'Text channels' }),
        h('button', {
          class: 'ghost tiny-btn',
          text: '+',
          title: 'Make a text channel',
          on: { click: () => void this.newChannel(false) },
        }),
      ]),
      this.channelList,
      h('div', { class: 'rail-head' }, [
        h('span', {
          class: 'eyebrow',
          text: 'Voice channels',
          title: 'Presence works. Audio between people does not yet.',
        }),
        h('button', {
          class: 'ghost tiny-btn',
          text: '+',
          title: 'Make a voice channel',
          on: { click: () => void this.newChannel(true) },
        }),
      ]),
      this.voiceList,
      h('div', { class: 'grow' }),
      this.voiceBar,
      h('div', { class: 'rail-foot stack tight' }, [
        h('div', { class: 'row' }, [this.shareButton]),
        h('div', { class: 'row' }, [
          h(
            'button',
            { class: 'grow', title: 'Your name, your ID, and the look', on: { click: () => this.openSettings() } },
            [icon('shield', 14), 'Settings'],
          ),
        ]),
      ]),
    ])

    const right = h('div', { class: 'rail rail-right' }, [
      h('div', { class: 'rail-head' }, [h('span', { class: 'eyebrow', text: 'Members' })]),
      this.peopleList,
      h('div', { class: 'grow' }),
      this.inviteBox(),
    ])

    this.shell = h('div', { class: 'space-grid' }, [
      left,
      h('div', { class: 'space-main' }, [
        h('div', { class: 'space-head row spread' }, [this.channelTitle]),
        this.stage,
        this.sharePanel,
        this.chatPanel.root,
      ]),
      right,
    ])

    this.root.append(h('main', {}, [this.shell]))
  }

  private openSettings(): void {
    clear(this.root)
    this.root.append(
      settingsView({
        rename: (name) => this.rename(name),
        back: () => {
          clear(this.root)
          this.root.append(h('main', {}, [this.shell]))
          this.drawNow()
        },
      }),
    )
  }

  private async renameSpace(): Promise<void> {
    if (!this.chat?.isAdmin) {
      toast('Only an admin can rename this space.', 'warn')
      return
    }
    const raw = window.prompt('Name this space', this.chat.spaceName()) ?? ''
    const name = raw.trim().slice(0, 32)
    if (!name) return
    await this.publish((c) => c.setSpaceName(name))
    await this.remember({ name })
  }

  private async setRole(subject: string, role: 'admin' | 'member' | 'kicked'): Promise<void> {
    if (!this.chat?.isAdmin) {
      toast('Only an admin can do that.', 'warn')
      return
    }
    await this.publish((c) => c.setRole(subject, role))
  }

  private rename(name: string): void {
    this.mesh?.setName(name)
    this.chatPanel?.setName(name)
    void this.publish((c) => c.announceName(name))
  }

  private inviteBox(): HTMLElement {
    const code = h('div', {
      class: 'share-code',
      text: formatSecret(this.secret),
      title: 'The code for this space',
      data: { link: roomLink(this.secret, this.locked) },
    })
    const copy = h('button', { class: 'grow' }, [icon('copy', 14), 'Copy invite'])
    copy.addEventListener('click', async () => {
      const ok = await copyText(roomLink(this.secret, this.locked))
      toast(ok ? 'Invite link copied.' : 'Could not copy. The code is above.', ok ? 'info' : 'warn')
    })
    const qr = h('button', { class: 'icon-only', title: 'Show a QR code', ariaLabel: 'Show a QR code' })
    qr.append(icon('qr', 14))
    qr.addEventListener('click', () => this.showQr())
    return h('div', { class: 'stack tight' }, [
      h('span', { class: 'eyebrow', text: 'Invite' }),
      code,
      h('div', { class: 'share-link truncate', text: shortLink(this.secret, this.locked) }),
      this.locked
        ? h('div', {
            class: 'tiny faint',
            text: 'This space has a password. Send it separately from the link.',
          })
        : null,
      h('div', { class: 'row' }, [copy, qr]),
    ])
  }

  private showQr(): void {
    const close = (): void => {
      scrim.remove()
      window.removeEventListener('keydown', onKey)
    }
    // A dialog you cannot dismiss with Escape is a dialog that traps people.
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    const frame = h('div', { class: 'qr-frame' })
    try {
      frame.append(qrSvg(roomLink(this.secret, this.locked), { pixels: 240 }))
    } catch {
      frame.append(h('div', { class: 'small', text: 'This link is too long for a QR code.' }))
    }
    const scrim = h('div', {
      class: 'scrim',
      on: { click: (ev) => ev.target === scrim && close() },
    })
    scrim.append(
      h('div', { class: 'modal' }, [
        h('div', { class: 'row spread' }, [
          h('span', { class: 'eyebrow', text: 'Scan to join' }),
          h('button', { ariaLabel: 'Close', on: { click: close } }, [icon('close', 14)]),
        ]),
        frame,
      ]),
    )
    document.body.append(scrim)
  }

  // ---- channels and people ----

  private renderChannels(): void {
    clear(this.channelList)
    for (const name of this.chat?.channels() ?? [DEFAULT_CHANNEL]) {
      const sharingHere = [...this.sharers.values()].includes(name)
      this.channelList.append(
        h(
          'button',
          {
            class: `rail-item${name === this.channel ? ' on' : ''}`,
            on: { click: () => this.openChannel(name) },
          },
          [
            h('span', { class: 'truncate grow', text: `# ${name}` }),
            sharingHere ? h('span', { class: 'pill good', text: 'live' }) : null,
          ],
        ),
      )
    }
  }

  private renderVoice(): void {
    clear(this.voiceList)
    const here = this.voice?.state.channel ?? null
    for (const name of this.chat?.channels(true) ?? [DEFAULT_VOICE]) {
      const members = this.voice?.membersOf(name) ?? []
      const row = h('div', { class: 'voice-channel' }, [
        h(
          'button',
          {
            class: `rail-item${here === name ? ' on' : ''}`,
            title:
              here === name
                ? 'You are in here. Click to leave.'
                : 'Join this voice channel. Everybody in it hears everybody else.',
            on: { click: () => void this.joinVoice(name) },
          },
          [
            icon('volume-low', 13),
            h('span', { class: 'truncate grow', text: name }),
            members.length ? h('span', { class: 'pill', text: String(members.length) }) : null,
          ],
        ),
      ])
      for (const id of members) {
        const label =
          id === this.selfId
            ? `${this.chat?.displayName ?? 'You'} (you)`
            : this.mesh?.peers().find((p) => p.id === id)?.name || shortKey(id)
        row.append(
          h('div', { class: 'voice-member' }, [h('i', { class: 'dot good' }), h('span', { text: label })]),
        )
      }
      this.voiceList.append(row)
    }

    const state = this.voice?.state
    this.voiceBar.classList.toggle('hidden', !state?.channel)
    if (state?.channel) {
      clear(this.voiceBar)
      this.voiceBar.append(
        h('div', { class: 'row spread' }, [
          h('span', { class: 'tiny good truncate' }, [icon('volume-low', 12), ` ${state.channel}`]),
          h('span', { class: 'tiny faint', text: `${(this.voice?.connected ?? 0) + 1} in` }),
        ]),
        h('div', { class: 'row' }, [
          h('button', {
            class: `grow small${state.muted ? ' on' : ''}`,
            text: state.muted ? 'Unmute' : 'Mute',
            on: { click: () => this.voice?.setMuted(!state.muted) },
          }),
          h('button', {
            class: 'small danger',
            text: 'Leave',
            on: { click: () => this.leaveVoice() },
          }),
        ]),
      )
    }
  }

  private async joinVoice(name: string): Promise<void> {
    if (this.voice?.state.channel === name) return
    try {
      await this.voice?.join(name)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'bad')
      return
    }
    this.announceMe()
    this.draw()
  }

  private leaveVoice(): void {
    this.voice?.dispose()
    this.announceMe()
    this.draw()
  }

  /** One announcement carries the name, what we are sharing, and where we stand. */
  private announceMe(): void {
    this.mesh?.announce()
  }

  private renderPeople(): void {
    clear(this.peopleList)
    const person = (
      name: string,
      id: string,
      ready: boolean,
      sharing: boolean,
      voice: string | null,
      you: boolean,
    ): HTMLElement =>
      h('div', { class: 'rail-person', title: `ID ${id}` }, [
        h('i', { class: `dot ${ready ? 'good' : 'warn'}` }),
        /*
         * Just the name. The identity behind it is what actually matters, but a
         * key under every row is a column of noise nobody reads: it sits in the
         * title instead, and stands in for the name when there is not one.
         */
        h('div', { class: 'grow truncate', text: you ? `${name} (you)` : name }),
        voice ? h('span', { class: 'pill', title: `In voice: ${voice}` }, [icon('volume-low', 11)]) : null,
        sharing ? h('span', { class: 'pill good', text: 'live' }) : null,
      ])

    const roles = this.chat?.roles() ?? new Map<string, string>()
    const iAmAdmin = this.chat?.isAdmin === true

    this.peopleList.append(
      person(
        this.chat?.displayName ?? 'You',
        this.chat?.me ?? '',
        true,
        this.capture !== null,
        this.voice?.state.channel ?? null,
        true,
      ),
    )
    /*
     * The roster is keyed by mesh id, which is per session, while roles are
     * keyed by the identity that signs events. They are matched by name, which
     * is loose, so the role controls sit under the people the log knows about
     * rather than under the connections.
     */
    for (const peer of this.mesh?.peers() ?? []) {
      this.peopleList.append(
        person(
          peer.name || shortKey(peer.id),
          peer.id,
          peer.ready,
          this.sharers.has(peer.id),
          this.voice?.whereIs(peer.id) ?? null,
          false,
        ),
      )
    }

    const names = this.chat?.log.names() ?? new Map<string, string>()
    const others = [...names.keys()].filter((k) => k !== this.chat?.me)
    if (others.length) {
      this.peopleList.append(h('div', { class: 'rail-head' }, [h('span', { class: 'eyebrow', text: 'Known' })]))
    }
    for (const key of others) {
      const role = roles.get(key) ?? 'member'
      this.peopleList.append(
        h('div', { class: 'rail-person', title: `ID ${key}` }, [
          h('div', { class: 'grow', style: { minWidth: '0' } }, [
            h('div', { class: 'truncate', text: names.get(key) || shortKey(key) }),
            role === 'member' ? null : h('div', { class: 'tiny faint', text: role }),
          ]),
          iAmAdmin && role !== 'admin'
            ? h('button', {
                class: 'ghost tiny-btn',
                text: '↑',
                title: 'Make an admin',
                on: { click: () => void this.setRole(key, 'admin') },
              })
            : null,
          iAmAdmin && role !== 'kicked' && key !== this.chat?.founder
            ? h('button', {
                class: 'ghost tiny-btn',
                text: '✕',
                title: 'Remove from this space',
                on: { click: () => void this.setRole(key, 'kicked') },
              })
            : null,
        ]),
      )
    }
  }

  private openChannel(name: string): void {
    if (name === this.channel) return
    this.channel = name
    // Watching follows the channel: leave whatever was on the old one.
    this.stopWatching()
    this.draw()
    const sharer = [...this.sharers.entries()].find(([, ch]) => ch === name)
    if (sharer) {
      this.watchingWho = sharer[0]
      void this.bus?.send({ type: 'hello', to: sharer[0] })
    }
  }

  private async newChannel(voice: boolean): Promise<void> {
    const raw = window.prompt(voice ? 'Name the voice channel' : 'Name the channel')
    if (raw === null) return
    const name = cleanChannel(raw)
    if (!name) {
      toast('A channel name needs a letter or a number in it.', 'warn')
      return
    }
    await this.publish((c) => c.makeChannel(name, voice))
    if (!voice) this.openChannel(name)
    else this.draw()
  }

  // ---- sharing ----

  private renderShareButton(): void {
    const sharing = this.capture !== null
    clear(this.shareButton)
    this.shareButton.append(
      icon(sharing ? 'stop' : 'monitor', 15),
      sharing ? 'Stop sharing' : 'Share screen',
    )
    this.shareButton.classList.toggle('danger', sharing)
    this.shareButton.classList.toggle('primary', !sharing)
    this.sharePanel.classList.toggle('hidden', !sharing)
    this.stage.classList.toggle('hidden', !sharing && !this.watching)
  }

  private async toggleShare(): Promise<void> {
    if (this.capture) {
      this.stopSharing()
      this.draw()
      return
    }
    const blocker = hostBlocker(checkSupport())
    if (blocker) {
      toast(blocker, 'bad', 8000)
      return
    }
    try {
      this.capture = await captureScreen({
        maxHeight: this.settings.maxHeight,
        fps: this.settings.fps,
        wantSystemAudio: this.settings.shareSystemAudio,
      })
    } catch (err) {
      if (!(err instanceof CaptureError) || err.kind !== 'denied') {
        toast(err instanceof CaptureError ? err.message : String(err), 'bad', 8000)
      }
      return
    }

    this.mixer = new AudioMixer()
    await this.mixer.resume()
    this.mixer.attachSystem(
      this.capture.systemAudio ? new MediaStream([this.capture.systemAudio]) : null,
    )
    this.outStream = new MediaStream([this.capture.video, this.mixer.track])
    this.capture.video.addEventListener('ended', () => {
      if (this.capture) {
        this.stopSharing()
        this.draw()
      }
    })

    this.showOwnPreview()
    this.buildSharePanel()
    this.announceMe()
    void this.publish((c) => c.say(`started sharing in #${this.channel}`, this.channel))
    this.draw()
  }

  private stopSharing(): void {
    for (const peer of this.watchers.values()) peer.close()
    this.watchers.clear()
    this.capture?.stream.getTracks().forEach((t) => t.stop())
    this.capture = null
    this.mixer?.close()
    this.mixer = null
    this.outStream = null
    this.surface?.setStream(null)
    this.stage.classList.add('hidden')
    this.announceMe()
  }

  private admitWatcher(peerId: string): void {
    if (!this.outStream) return
    const peer = new HostPeer({
      viewerId: peerId,
      stream: this.outStream,
      mode: this.settings.mode,
      codec: this.settings.codec,
      hardware: this.gpu.hardware,
      send: (type, data) => void this.bus?.send({ type, to: peerId, data }),
      onChange: () => this.draw(),
      onFailed: (reason) => toast(reason, 'bad', 8000),
      onChat: () => undefined,
    })
    this.watchers.set(peerId, peer)
    void peer.setPlan(this.plan(this.watchers.size))
  }

  private startWatching(from: string): void {
    this.watchingWho = from
    this.ensureSurface()
    this.watching = new ViewerPeer({
      send: (type, data) => void this.bus?.send({ type, to: from, data }),
      onStream: (stream) => {
        this.stage.classList.remove('hidden')
        this.surface?.setStream(stream)
        void this.surface?.tryUnmute().then((got) => {
          if (!got) this.surface?.setSoundPrompt(() => void this.surface?.tryUnmute())
        })
      },
      onChange: () => this.draw(),
      onFailed: (reason) => toast(reason, 'bad', 8000),
      onChat: () => undefined,
      onChatReady: () => undefined,
    })
  }

  private stopWatching(): void {
    this.watching?.close()
    this.watching = null
    this.watchingWho = null
    if (!this.capture) {
      this.surface?.setStream(null)
      this.stage.classList.add('hidden')
    }
  }

  private ensureSurface(): void {
    if (this.surface) return
    this.surface = new VideoSurface({ muted: true, showVolume: true })
    this.stage.append(this.surface.root)
  }

  private showOwnPreview(): void {
    this.ensureSurface()
    this.surface?.setStream(this.outStream)
    this.stage.classList.remove('hidden')
  }

  private plan(watchers: number): QualityPlan {
    const s = this.capture?.video.getSettings()
    return planFor({
      mode: this.settings.mode,
      budgetKbps: this.settings.budgetAuto ? this.uplink.estimateKbps : this.settings.budgetKbps,
      viewerCount: Math.max(1, watchers),
      width: s?.width ?? 1920,
      height: s?.height ?? 1080,
      fps: this.settings.fps,
      bitrateScale: this.settings.bitrateScale,
    })
  }

  private async tick(): Promise<void> {
    const peers = [...this.watchers.values()]
    if (peers.length) {
      await Promise.all(peers.map((p) => p.sample()))
      const live = peers.filter((p) => p.state === 'connected' && p.stats.kbps > 0)
      if (live.length) {
        this.uplink.observe({
          demandKbps: this.plan(1).maxBitrateKbps * live.length,
          sendingKbps: live.reduce((n, p) => n + p.stats.kbps + p.stats.audioKbps, 0),
          availableKbps: live.reduce((n, p) => n + p.stats.availableOutKbps, 0),
          lossPct: live.reduce((n, p) => n + p.stats.lossPct, 0) / live.length,
        })
      }
      const plan = this.plan(peers.length)
      for (const peer of peers) await peer.setPlan(plan)
      this.renderSharePanel(plan, peers.length)
    }
    if (this.watching) {
      const s = await this.watching.sample()
      this.surface?.setBadges([
        { text: fmtKbps(s.kbps) },
        { text: `${s.width}x${s.height}` },
        { text: `${s.fps} fps` },
        ...(s.codec ? [{ text: s.codec }] : []),
      ])
    }
    void this.remember({})
  }

  // ---- the share controls ----

  private buildSharePanel(): void {
    clear(this.sharePanel)
    const presets = h('div', { class: 'chips' })
    for (const preset of PRESETS) {
      presets.append(
        h('button', {
          class: `chip${this.settings.presetId === preset.id ? ' on' : ''}`,
          text: preset.name,
          title: preset.useWhen,
          on: { click: () => void this.applyPreset(preset.id) },
        }),
      )
    }

    const resolution = h('div', { class: 'chips' })
    for (const choice of RESOLUTION_CHOICES) {
      resolution.append(
        h('button', {
          class: `chip${this.settings.maxHeight === choice.height ? ' on' : ''}`,
          text: choice.label,
          title: choice.note,
          on: {
            click: () => {
              this.settings.maxHeight = choice.height
              this.settings.presetId = 'custom'
              saveSettings(this.settings)
              void this.applyConstraints()
            },
          },
        }),
      )
    }

    const fps = h('div', { class: 'chips' })
    for (const choice of FPS_CHOICES) {
      fps.append(
        h('button', {
          class: `chip${this.settings.fps === choice.fps ? ' on' : ''}`,
          text: choice.label,
          title: choice.note,
          on: {
            click: () => {
              this.settings.fps = choice.fps
              this.settings.presetId = 'custom'
              saveSettings(this.settings)
              void this.applyConstraints()
            },
          },
        }),
      )
    }

    const mic = h('button', { text: 'Turn on the microphone' })
    mic.addEventListener('click', async () => {
      if (this.mixer?.hasMic) {
        this.mixer.stopMic()
        mic.textContent = 'Turn on the microphone'
        mic.classList.remove('on')
        return
      }
      try {
        this.mixer?.attachMic(await captureMicrophone())
        mic.textContent = 'Microphone is on'
        mic.classList.add('on')
      } catch (err) {
        toast(err instanceof CaptureError ? err.message : String(err), 'bad')
      }
    })

    this.planLine = h('div', { class: 'plan-box tiny' })

    this.sharePanel.append(
      h('div', { class: 'card stack tight' }, [
        h('div', { class: 'row spread' }, [
          h('span', { class: 'eyebrow', text: `Sharing in #${this.channel}` }),
          h('span', { class: 'pill good' }, [h('i', { class: 'dot live' }), 'live']),
        ]),
        presets,
        this.planLine,
        h('details', { class: 'adv' }, [
          h('summary', { text: 'Fine tuning' }),
          h('div', { class: 'stack tight' }, [
            labelled('Resolution', resolution),
            labelled('Frame rate', fps),
            mic,
          ]),
        ]),
      ]),
    )
    this.renderSharePanel(this.plan(1), 0)
  }

  private planLine: HTMLDivElement | null = null

  private renderSharePanel(plan: QualityPlan, watchers: number): void {
    if (!this.planLine) return
    const s = this.capture?.video.getSettings()
    const w = Math.round((s?.width ?? 1920) / plan.scaleDown)
    const hgt = Math.round((s?.height ?? 1080) / plan.scaleDown)
    this.planLine.textContent =
      `Each watcher gets ${w}x${hgt} at ${plan.maxFramerate} fps, about ${fmtKbps(plan.maxBitrateKbps)}. ` +
      `${watchers} watching.`
  }

  private async applyPreset(id: PresetId): Promise<void> {
    const preset = presetById(id)
    if (!preset) return
    this.settings = {
      ...this.settings,
      presetId: preset.id,
      mode: preset.mode,
      maxHeight: preset.maxHeight,
      fps: preset.fps,
      bitrateScale: preset.bitrateScale,
    }
    saveSettings(this.settings)
    for (const peer of this.watchers.values()) {
      peer.setMode(preset.mode, this.settings.codec as CodecChoice, this.gpu.hardware)
    }
    await this.applyConstraints()
    this.buildSharePanel()
  }

  private async applyConstraints(): Promise<void> {
    const track = this.capture?.video
    if (!track) return
    const constraints: MediaTrackConstraints = {
      frameRate: { ideal: this.settings.fps, max: this.settings.fps },
    }
    if (this.settings.maxHeight > 0) {
      constraints.height = { max: this.settings.maxHeight }
      constraints.width = { max: Math.round((this.settings.maxHeight * 16) / 9) }
    }
    await track.applyConstraints(constraints).catch(() => undefined)
    this.buildSharePanel()
  }
}
