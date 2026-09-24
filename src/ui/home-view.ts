/**
 * Home: your direct messages, from every space, and the way into the spaces.
 *
 * A private conversation belongs to a space: it is kept in that space's log,
 * sealed so only the two of you can read it, and it is with somebody you met
 * there. But it is read out here, beside every other one, the way every chat
 * app with servers does it, because who you are talking to matters more than
 * where you met them.
 */

import { shortKey } from '../store/identity'
import { loadAvatar } from './avatar'
import { ChatPanel, avatarOf } from './chat-panel'
import { h } from './dom'
import { icon } from './icons'
import { spaces } from '../space/registry'
import { filesFor, type SpaceRuntime } from '../space/runtime'
import { ROOMS_CHANGED } from '../store/notes'
import type { WindowChrome } from './shell'
import { homeFace, switcherButton } from './space-switcher'
import { callControls, voiceDock } from './call'

export interface HomeActions {
  /** The home page itself: your spaces, and making or joining one. */
  page(): Promise<HTMLElement>
  settings(): void
}

/** A conversation, by the space it lives in and the person it is with. */
export interface DirectRef {
  room: string
  key: string
}

interface Row {
  space: SpaceRuntime
  key: string
  name: string
  last: number
  unread: number
}

function rows(): Row[] {
  const out: Row[] = []
  for (const space of spaces.all()) {
    if (!space.chat) continue
    for (const talk of space.chat.directs()) out.push({ space, ...talk })
  }
  return out.sort((a, b) => b.last - a.last)
}

export class HomeView {
  readonly isLive = false
  private readonly root: HTMLElement
  private readonly chrome: WindowChrome
  private readonly actions: HomeActions
  private open: DirectRef | null
  private readonly list = h('div', { class: 'rail-list' })
  private readonly main = h('div', { class: 'space-main' })
  private readonly shell: HTMLElement
  private panel: ChatPanel | null = null
  private stopped = false
  private drawQueued = false
  private unlisten: (() => void) | null = null
  /** The call button and strip of the conversation on show, and the way to stop them listening. */
  private callBits: { stop(): void } | null = null
  private readonly dock = voiceDock(null)

  constructor(root: HTMLElement, chrome: WindowChrome, actions: HomeActions, open: DirectRef | null = null) {
    this.root = root
    this.chrome = chrome
    this.actions = actions
    this.open = open

    const me = h('div', { class: 'me-panel' }, [
      h('span', { class: 'me-face' }),
      h('div', { class: 'me-text' }, [h('span', { class: 'me-name truncate', text: 'You' }), chrome.status]),
      h(
        'button',
        { class: 'ghost icon-only', title: 'Your name, your ID, and your servers', ariaLabel: 'Settings', on: { click: () => actions.settings() } },
        [icon('settings', 17)],
      ),
    ])
    const left = h('div', { class: 'rail rail-left', role: 'navigation', ariaLabel: 'Direct messages' }, [
      h('div', { class: 'space-title' }, [
        switcherButton({
          active: null,
          face: homeFace(24),
          name: h('span', { class: 'pane-name truncate', text: 'Home' }),
          nav: chrome.nav,
        }),
      ]),
      h('div', { class: 'rail-scroll' }, [
        h('div', { class: 'rail-head' }, [h('span', { class: 'eyebrow', text: 'Direct messages' })]),
        this.list,
      ]),
      this.dock.root,
      me,
    ])
    this.shell = h('div', { class: 'space-grid home-grid-shell members-hidden' }, [left, this.main])
    this.root.append(h('main', {}, [this.shell]))
    this.drawMe(me)
  }

  async start(): Promise<void> {
    const redraw = (): void => this.draw()
    window.addEventListener(ROOMS_CHANGED, redraw)
    this.unlisten = () => window.removeEventListener(ROOMS_CHANGED, redraw)
    await this.show(this.open)
    this.draw()
  }

  destroy(): void {
    this.stopped = true
    this.unlisten?.()
    this.callBits?.stop()
    this.dock.stop()
  }

  private drawMe(me: HTMLElement): void {
    const any = spaces.all().find((s) => s.chat)?.chat
    const name = any?.displayName ?? ''
    const face = me.querySelector('.me-face')
    face?.replaceChildren(avatarOf(any?.me ?? 'you', name, loadAvatar(), 32), h('i', { class: 'dot good' }))
    const label = me.querySelector('.me-name')
    if (label && name) label.textContent = name
  }

  private draw(): void {
    if (this.stopped || this.drawQueued) return
    this.drawQueued = true
    requestAnimationFrame(() => {
      this.drawQueued = false
      this.drawList()
      this.drawConversation()
    })
  }

  private drawList(): void {
    const all = rows()
    const items: HTMLElement[] = all.map((row) => {
      const on = this.open?.room === row.space.room?.id && this.open?.key === row.key
      const label = row.name || shortKey(row.key)
      return h(
        'button',
        {
          class: `rail-item dm-item${on ? ' on' : ''}${row.unread ? ' unread' : ''}`,
          title: `${label}, in ${row.space.chat.spaceName() || 'a space'}`,
          on: { click: () => void this.show({ room: row.space.room.id, key: row.key }) },
        },
        [
          avatarOf(row.key, row.name, row.space.chat.avatarOf(row.key), 28),
          h('span', { class: 'dm-text' }, [
            h('span', { class: 'truncate', text: label }),
            h('span', { class: 'dm-space truncate', text: row.space.chat.spaceName() || 'Unnamed space' }),
          ]),
          row.unread ? h('span', { class: 'pill bad', text: String(row.unread) }) : null,
        ],
      )
    })
    if (items.length === 0) items.push(h('div', { class: 'rail-empty', text: 'No messages yet.' }))
    this.list.replaceChildren(...items)
  }

  /** Show a conversation, or the home page when there is none. */
  private async show(ref: DirectRef | null): Promise<void> {
    this.panel?.keepDraft()
    this.callBits?.stop()
    this.callBits = null
    this.open = ref
    this.shell.classList.toggle('dm-open', ref !== null)
    if (!ref) {
      this.panel = null
      this.main.replaceChildren(await this.actions.page())
      this.drawList()
      return
    }
    const space = spaces.get(ref.room)
    if (!space) return
    await space.ready
    if (this.stopped || this.open !== ref) return
    const panel = new ChatPanel(space.chat.displayName, 'Direct')
    panel.showNameField(false)
    panel.setMe(space.chat.me)
    panel.onDirect = (key) => void this.show(key ? { room: ref.room, key } : null)
    panel.actions = {
      say: () => undefined,
      sayDirect: (to, text, files) => void space.chat.sayDirect(to, text, files),
      edit: (id, text) => void space.chat.edit(id, text),
      react: (id, emoji, on) => void space.chat.react(id, emoji, on),
      retract: (id) => void space.chat.retract(id),
      rename: () => undefined,
      pin: () => undefined,
      vote: () => undefined,
    }
    panel.setEnabled(true)
    panel.setFiles(filesFor(space))
    this.panel = panel
    const back = h(
      'button',
      { class: 'ghost icon-only dm-back', ariaLabel: 'Back to home', title: 'Back', on: { click: () => void this.show(null) } },
      [icon('chevron-left', 18)],
    )
    const title = h('div', { class: 'row channel-head' }, [
      h('span', { class: 'channel-name' }, [h('span', { class: 'truncate', text: space.chat.nameOf(ref.key) || shortKey(ref.key) })]),
      h('span', { class: 'channel-topic truncate', text: `in ${space.chat.spaceName() || 'a space'}` }),
    ])
    const call = callControls(space, ref.key)
    this.callBits = call
    this.main.replaceChildren(h('div', { class: 'space-head row' }, [back, title, call.button]), call.strip, panel.root)
    panel.useDraft(`dm:${ref.room}:${ref.key}`)
    this.drawConversation()
    this.drawList()
    panel.focus()
  }

  private drawConversation(): void {
    const ref = this.open
    const panel = this.panel
    if (!ref || !panel) return
    const space = spaces.get(ref.room)
    if (!space?.chat) return
    const chat = space.chat
    const name = chat.nameOf(ref.key) || shortKey(ref.key)
    panel.setNames(chat.log.names(), chat.log.avatars())
    panel.setIntro({
      title: name,
      text: `Your private conversation with ${name}. Only the two of you can read it.`,
    })
    panel.setDirect(ref.key, name)
    panel.render(chat.directWith(ref.key))
    // On screen is read.
    if (!document.hidden) {
      const top = chat.directHighWater(ref.key)
      const marks = { ...(space.note?.readDm ?? {}) }
      if (top > (marks[ref.key] ?? 0)) {
        marks[ref.key] = top
        void space.remember({ readDm: marks })
      }
    }
    this.chrome.setTitle(`Nook | ${name}`)
  }

  /** The conversation on screen, so a notification for it can stay quiet. */
  get showing(): DirectRef | null {
    return this.open
  }
}
