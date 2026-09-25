import { spaces } from '../space/registry'
import { isCallChannel, type CallNews, type SpaceRuntime } from '../space/runtime'
import { avatarOf } from './chat-panel'
import { h } from './dom'
import { icon } from './icons'
import { notify } from './notify'
import { ring } from './sounds'
import { toast } from './toast'

const onNews = (fn: (news: CallNews) => void): (() => void) => {
  const listener = (ev: Event): void => fn((ev as CustomEvent<CallNews>).detail)
  window.addEventListener('nook:call', listener)
  return () => window.removeEventListener('nook:call', listener)
}

function nameOf(space: SpaceRuntime, key: string): string {
  return space.chat?.nameOf(key) || 'Somebody'
}

function clock(since: number): string {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function installCalls(openDirect: (space: SpaceRuntime, key: string) => void): void {
  let card: HTMLElement | null = null
  let stopRing: () => void = () => undefined
  let lastFailure = 0

  const drop = (): void => {
    stopRing()
    stopRing = () => undefined
    card?.remove()
    card = null
  }

  onNews((news) => {
    const space = news.space
    if (news.kind === 'ringing' && space.ringing) {
      drop()
      const from = space.ringing.from
      const name = nameOf(space, from)
      const answer = h('button', { class: 'call-answer', ariaLabel: `Answer ${name}`, title: 'Answer' }, [icon('phone', 20)])
      const decline = h('button', { class: 'call-decline', ariaLabel: `Decline ${name}`, title: 'Decline' }, [icon('phone-off', 20)])
      card = h('div', { class: 'call-card', role: 'dialog', ariaLabel: `${name} is calling` }, [
        avatarOf(from, name, space.chat.avatarOf(from), 48),
        h('div', { class: 'call-words' }, [
          h('span', { class: 'call-name truncate', text: name }),
          h('span', { class: 'tiny faint truncate', text: `Calling you, in ${space.chat.spaceName() || 'a space'}` }),
        ]),
        decline,
        answer,
      ])
      answer.addEventListener('click', async () => {
        drop()
        try {
          await space.answer()
          openDirect(space, from)
        } catch (err) {
          toast(err instanceof Error ? err.message : 'The call could not start.', 'bad', 8000)
        }
      })
      decline.addEventListener('click', () => {
        drop()
        space.decline()
      })
      document.body.append(card)
      stopRing = ring()
      if (document.hidden) notify(`${name} is calling`, `In ${space.chat.spaceName() || 'a space'}`, () => window.focus())
      return
    }
    if (news.kind === 'rang-out' && card && !spaces.all().some((s) => s.ringing)) {
      drop()
      return
    }
    if (news.kind === 'ended' && news.reason) {
      toast(news.reason, 'info', 4000)
      return
    }
    if (news.kind === 'failed' && Date.now() - lastFailure > 30_000) {
      lastFailure = Date.now()
      toast(
        `Voice could not connect to ${space.mesh.peers().find((p) => p.id === news.peer)?.name || 'somebody'}. ` +
          'The server’s relay may be out of reach: Settings, Voice, has a test for it.',
        'bad',
        10_000,
      )
    }
  })
}

export function callControls(space: SpaceRuntime, key: string): { button: HTMLButtonElement; strip: HTMLElement; stop(): void } {
  const name = (): string => nameOf(space, key)
  const button = h('button', { class: 'ghost icon-only', ariaLabel: 'Call', title: 'Voice call' }, [icon('phone', 19)])
  button.addEventListener('click', async () => {
    if (space.call) return
    try {
      await space.startCall(key)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The call could not start.', 'warn', 6000)
    }
  })

  const words = h('span', { class: 'call-strip-words truncate' })
  const mute = h('button', { class: 'ghost icon-only', ariaLabel: 'Mute' })
  const hangUp = h('button', { class: 'call-decline small-round', ariaLabel: 'Hang up', title: 'Hang up' }, [icon('phone-off', 16)])
  const strip = h('div', { class: 'call-strip hidden' }, [h('i', { class: 'dot good' }), words, mute, hangUp])
  mute.addEventListener('click', () => {
    space.voice.setMuted(!space.voice.state.muted)
    paint()
  })
  hangUp.addEventListener('click', () => space.endCall())

  let drawnMuted: boolean | null = null
  const paint = (): void => {
    const call = space.call?.with === key ? space.call : null
    strip.classList.toggle('hidden', !call)
    strip.classList.toggle('live', !!call?.live)
    button.classList.toggle('hidden', !!call)
    if (!call) return
    words.textContent = call.live ? `In a call with ${name()} · ${clock(call.since)}` : `Calling ${name()}…`
    const muted = space.voice.state.muted
    if (muted === drawnMuted) return
    drawnMuted = muted
    mute.replaceChildren(icon(muted ? 'mic-off' : 'mic', 16))
    mute.title = muted ? 'Unmute' : 'Mute'
    mute.classList.toggle('on', muted)
  }
  const off = onNews(paint)
  const tick = window.setInterval(paint, 1000)
  paint()
  return {
    button,
    strip,
    stop: () => {
      off()
      window.clearInterval(tick)
    },
  }
}

export function voiceDock(here: SpaceRuntime | null): { root: HTMLElement; stop(): void } {
  const words = h('span', { class: 'tiny faint truncate' })
  const mute = h('button', { class: 'ghost icon-only', ariaLabel: 'Mute' })
  const leave = h('button', { class: 'ghost icon-only', ariaLabel: 'Leave voice', title: 'Leave' }, [icon('phone-off', 19)])
  const root = h('div', { class: 'voice-bar voice-dock hidden' }, [
    h('div', { class: 'voice-bar-text' }, [
      h('span', { class: 'voice-bar-state' }, [h('i', { class: 'dot good' }), 'Voice connected']),
      words,
    ]),
    mute,
    leave,
  ])
  const where = (): SpaceRuntime | null => spaces.all().find((s) => s !== here && s.voice?.state.channel) ?? null
  mute.addEventListener('click', () => {
    const space = where()
    space?.voice.setMuted(!space.voice.state.muted)
    paint()
  })
  leave.addEventListener('click', () => where()?.leaveVoice())
  const paint = (): void => {
    const space = where()
    root.classList.toggle('hidden', !space)
    if (!space) return
    const channel = space.voice.state.channel ?? ''
    const place = space.chat?.spaceName() || 'a space'
    words.textContent = isCallChannel(channel)
      ? `Call with ${nameOf(space, space.call?.with ?? '')}`
      : `${channel} · ${place}`
    const muted = space.voice.state.muted
    mute.replaceChildren(icon(muted ? 'mic-off' : 'mic', 19))
    mute.title = muted ? 'Unmute' : 'Mute'
  }
  const off = onNews(paint)
  paint()
  return { root, stop: off }
}
