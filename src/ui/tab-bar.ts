import { spaces } from '../space/registry'
import type { SpaceRuntime } from '../space/runtime'
import { MUTED_CHANGED } from '../store/mute'
import { ROOMS_CHANGED } from '../store/notes'
import { loadAvatar } from './avatar'
import { h } from './dom'
import { icon } from './icons'
import { spaceFace } from './space-switcher'

export type Tab = 'home' | 'space' | 'you'

interface TabGo {
  home(): void
  /** The space to go back to, or null when there is none yet. */
  space: SpaceRuntime | null
  openSpace(space: SpaceRuntime): void
  you(): void
}

const countText = (n: number): string => (n > 99 ? '99+' : String(n))

/**
 * The bar along the bottom of a phone, as Discord has: Home with the direct messages, the space
 * you were last in, and You. It shows where there is room to choose (home, settings, and a space
 * with its channels out), and goes while you read or write a conversation: see styles.css.
 */
export function tabBar(current: Tab, go: TabGo): HTMLElement {
  const homeCount = h('span', { class: 'tab-count hidden' })
  const spaceCount = h('span', { class: 'tab-count hidden' })
  const tab = (which: Tab, label: string, face: Node, count: HTMLElement | null, run: () => void): HTMLElement => {
    const button = h(
      'button',
      {
        class: `tab${which === current ? ' current' : ''}`,
        ariaLabel: label,
        on: { click: () => which !== current && run() },
      },
      [h('span', { class: 'tab-face' }, [face, count]), h('span', { class: 'tab-label', text: label })],
    )
    if (which === current) button.setAttribute('aria-current', 'page')
    return button
  }

  const space = go.space
  const titleOf = (): string => space?.note?.title || space?.chat?.spaceName() || ''
  const faceOf = (title: string): HTMLElement | null =>
    space ? spaceFace(space.room?.id ?? space.secret, title, 24, space.note?.picture ?? '') : null
  let drawnAs = `${titleOf()}|${space?.note?.picture ?? ''}`
  const picture = loadAvatar()
  const me = picture ? h('img', { class: 'tab-me' }) : icon('user', 22)
  if (me instanceof HTMLImageElement) {
    me.alt = ''
    me.src = picture
  }

  const spaceTab = space ? tab('space', titleOf() || 'Space', faceOf(titleOf()) as HTMLElement, spaceCount, () => go.openSpace(space)) : null
  const bar = h('nav', { class: 'tab-bar', ariaLabel: 'Where to go' }, [
    tab('home', 'Home', icon('home', 22), homeCount, go.home),
    spaceTab,
    tab('you', 'You', me, null, go.you),
  ])

  // What waits: direct messages on Home, mentions on the space's tab, for every space.
  const paint = (): void => {
    if (!bar.isConnected && bar.dataset.drawn) {
      window.removeEventListener(ROOMS_CHANGED, paint)
      window.removeEventListener(MUTED_CHANGED, paint)
      return
    }
    bar.dataset.drawn = '1'
    // The space's name and picture come in after the bar is drawn, when it was opened just now.
    const now = `${titleOf()}|${space?.note?.picture ?? ''}`
    if (spaceTab && now !== drawnAs) {
      drawnAs = now
      const title = titleOf()
      spaceTab.setAttribute('aria-label', title || 'Space')
      spaceTab.querySelector('.space-face')?.replaceWith(faceOf(title) as HTMLElement)
      const label = spaceTab.querySelector('.tab-label')
      if (label) label.textContent = title || 'Space'
    }
    let direct = 0
    let mentions = 0
    for (const s of spaces.all()) {
      const u = s.unread()
      direct += u.direct
      mentions += u.mentions
    }
    for (const [el, n] of [[homeCount, direct], [spaceCount, mentions]] as const) {
      el.textContent = countText(n)
      el.classList.toggle('hidden', n === 0)
    }
  }
  window.addEventListener(ROOMS_CHANGED, paint)
  window.addEventListener(MUTED_CHANGED, paint)
  paint()
  return bar
}
