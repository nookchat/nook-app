import { spaces } from '../space/registry'
import type { SpaceRuntime } from '../space/runtime'
import { ROOMS_CHANGED } from '../store/notes'
import { h } from './dom'
import { icon } from './icons'
import { CUSTOM, openSoundboard } from './soundboard'
import { toast } from './toast'

/**
 * For a phone with no space open: when another device of yours is in a voice channel, a row says
 * so, with the soundboard for it. The sounds play in the call from that device, not here.
 */
export function remoteBoard(): { el: HTMLElement; stop(): void } {
  const el = h('div', { class: 'remote-board hidden' })
  const watching = new Map<SpaceRuntime, () => void>()
  let queued = false

  const draw = (): void => {
    queued = false
    const rows: HTMLElement[] = []
    for (const space of spaces.all()) {
      const away = space.chat ? space.callElsewhere() : null
      if (!away || !space.chat.can('soundboard')) continue
      const open: HTMLButtonElement = h(
        'button',
        {
          class: 'small primary',
          title: 'Play a sound in the call on your other device',
          on: { click: () => openFor(space, open) },
        },
        [icon('music', 16), 'Soundboard'],
      )
      rows.push(
        h('div', { class: 'remote-board-row' }, [
          h('div', { class: 'voice-bar-text' }, [
            h('span', { class: 'voice-bar-state good' }, [h('span', { class: 'truncate', text: 'In a call on another device' })]),
            h('span', { class: 'tiny faint truncate', text: `${away.channel} / ${space.chat.spaceName() || 'Unnamed space'}` }),
          ]),
          open,
        ]),
      )
    }
    el.replaceChildren(...rows)
    el.classList.toggle('hidden', rows.length === 0)
  }

  const soon = (): void => {
    if (queued) return
    queued = true
    requestAnimationFrame(draw)
  }

  const openFor = (space: SpaceRuntime, anchor: HTMLElement): void => {
    const chat = space.chat
    openSoundboard({
      anchor,
      onPick: (id) => {
        if (!space.askSound(id)) toast('Your other device has left the call.', 'warn')
      },
      sounds: chat.boardSounds().map((b) => ({ id: CUSTOM + b.id, label: b.label, emoji: b.emoji, group: b.group })),
      groups: chat.boardGroups().map((g) => ({ id: g.id, label: g.label, emoji: g.emoji })),
      onManage: () => toast('Add sounds in Space settings.', 'info'),
      onAdd: () => toast('Add sounds in Space settings.', 'info'),
    })
  }

  // Spaces open and close, so the ones listened to are looked at again each time the list changes.
  const watch = (): void => {
    const now = new Set(spaces.all())
    for (const [space, stop] of watching) {
      if (now.has(space)) continue
      stop()
      watching.delete(space)
    }
    for (const space of now) {
      if (watching.has(space)) continue
      const stops = [space.on('voice', soon), space.on('peers', soon), space.on('changed', soon)]
      watching.set(space, () => stops.forEach((s) => s()))
    }
    soon()
  }
  window.addEventListener(ROOMS_CHANGED, watch)
  watch()

  return {
    el,
    stop: () => {
      window.removeEventListener(ROOMS_CHANGED, watch)
      for (const stop of watching.values()) stop()
      watching.clear()
    },
  }
}

