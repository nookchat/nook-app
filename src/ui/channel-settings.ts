import type { ChannelInfo } from '../store/log'
import { h } from './dom'
import { openEmojiPicker } from './emoji'
import { actionRow, card, note, settingsShell, toggle, type SettingsTab } from './settings-shell'

export interface ChannelSettingsActions {
  channel: ChannelInfo
  voice: boolean
  /** General and lounge: everybody lands in them, so they stay open to all and cannot go. */
  isDefault: boolean
  /** The names of the levels it is kept to. Empty is everybody. */
  keptTo: string[]
  /** Only what changed: each resolves once it is written. */
  save(change: { label?: string; emoji?: string; topic?: string }): Promise<void>
  setNsfw(on: boolean): Promise<void>
  setMediaOnly(on: boolean): Promise<void>
  setNoTalking(on: boolean): Promise<void>
  /** Asks which levels. */
  chooseLevels(): Promise<void>
  /** Asks first. */
  remove(): Promise<void>
  start?: string
  back(): void
}

/** Everything about one channel in one place: its name, emoji and topic, who gets in, its rules, and delete. Its place is in the space's settings, under Channels. */
export function channelSettingsView(actions: ChannelSettingsActions): HTMLElement {
  const { channel, voice } = actions
  const group = voice ? channel.label : `#${channel.label}`
  const tabs: SettingsTab[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: 'settings',
      group,
      build: () => overviewPage(actions),
    },
    {
      id: 'access',
      label: 'Permissions',
      icon: 'lock',
      group,
      build: () => accessPage(actions),
    },
  ]
  if (!actions.isDefault) {
    tabs.push({
      id: 'delete',
      label: 'Delete',
      icon: 'trash',
      group,
      build: () =>
        h('div', { class: 'stack settings-stack' }, [
          card(
            'For everybody',
            h('div', { class: 'action-list' }, [
              actionRow(
                voice ? 'Delete the voice channel' : 'Delete the channel',
                voice ? 'Anybody in it now is taken out.' : 'Everything said in it goes with it, on every device. It cannot be undone.',
                h('button', { class: 'small danger', text: 'Delete', on: { click: () => void actions.remove() } }),
              ),
            ]),
          ),
        ]),
    })
  }
  return settingsShell({ title: 'Channel settings', tabs, start: actions.start, close: actions.back })
}

function overviewPage(actions: ChannelSettingsActions): HTMLElement {
  const { channel, voice } = actions
  let emoji = channel.emoji
  const face = h('button', { class: 'sound-face channel-face', title: 'Pick its emoji', ariaLabel: 'The channel’s emoji' })
  const clearEmoji = h('button', { class: 'ghost small', text: 'Take it away' })
  const paintEmoji = (): void => {
    face.textContent = emoji || (voice ? '🔊' : '#')
    face.classList.toggle('empty', !emoji)
    clearEmoji.classList.toggle('hidden', !emoji)
    dirty()
  }
  face.addEventListener('click', () =>
    openEmojiPicker({
      anchor: face,
      title: `An emoji for ${channel.label}`,
      onPick: (picked) => {
        emoji = picked
        paintEmoji()
      },
    }),
  )
  clearEmoji.addEventListener('click', () => {
    emoji = ''
    paintEmoji()
  })

  const name = h('input', { type: 'text', class: 'grow', value: channel.label, ariaLabel: 'Channel name', placeholder: channel.name })
  name.maxLength = 32
  const topic = h('input', { type: 'text', class: 'grow', value: channel.topic, ariaLabel: 'Topic', placeholder: 'A line saying what it is for' })
  topic.maxLength = 140
  const save = h('button', { class: 'primary', text: 'Save changes' })

  const change = (): { label?: string; emoji?: string; topic?: string } => {
    const out: { label?: string; emoji?: string; topic?: string } = {}
    const label = name.value.trim()
    if (label && label !== channel.label) out.label = label
    if (emoji !== channel.emoji) out.emoji = emoji
    if (!voice && topic.value.trim() !== channel.topic) out.topic = topic.value.trim()
    return out
  }
  function dirty(): void {
    save.disabled = Object.keys(change()).length === 0
  }
  name.addEventListener('input', dirty)
  topic.addEventListener('input', dirty)
  const commit = async (): Promise<void> => {
    const wanted = change()
    if (Object.keys(wanted).length === 0) return
    save.disabled = true
    await actions.save(wanted)
  }
  save.addEventListener('click', () => void commit())
  for (const field of [name, topic]) {
    field.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) void commit()
    })
  }
  paintEmoji()

  return h('div', { class: 'stack settings-stack' }, [
    card(
      'Name and emoji',
      note(`Everybody in the space sees these in the list of channels. Its name in links stays ${channel.name}.`),
      h('div', { class: 'row channel-name-edit' }, [face, name]),
      h('div', { class: 'row' }, [clearEmoji]),
    ),
    voice ? null : card('Topic', note('Shown at the top of the channel.'), topic),
    h('div', { class: 'row' }, [save]),
  ])
}

function accessPage(actions: ChannelSettingsActions): HTMLElement {
  const { channel, voice } = actions
  const state = { nsfw: channel.nsfw, mediaOnly: channel.mediaOnly, noTalking: channel.noTalking }
  const rules = voice
    ? [
        toggle(
          'No talking',
          () => state.noTalking,
          (on) => {
            state.noTalking = on
            void actions.setNoTalking(on)
          },
          'Mics stay off, but for the owner and whoever has Channels.',
        ),
      ]
    : [
        toggle(
          'NSFW',
          () => state.nsfw,
          (on) => {
            state.nsfw = on
            void actions.setNsfw(on)
          },
          'Pictures and videos are blurred until somebody clicks one.',
        ),
        toggle(
          'Media only',
          () => state.mediaOnly,
          (on) => {
            state.mediaOnly = on
            void actions.setMediaOnly(on)
          },
          'Each message needs a picture, a video or a file. Threads take words.',
        ),
      ]
  const who = actions.keptTo.length ? `Only ${actions.keptTo.join(', ')}` : 'Everybody'
  return h('div', { class: 'stack settings-stack' }, [
    actions.isDefault
      ? card(voice ? 'Who can join' : 'Who can see it', note(`Everybody. Everybody lands in ${channel.label}, so it stays open to all.`))
      : card(
          voice ? 'Who can join' : 'Who can see it',
          h('div', { class: 'action-list' }, [
            actionRow(
              who,
              'The owner, and whoever can change channels, always get in.',
              h('button', { class: 'small', text: 'Choose', on: { click: () => void actions.chooseLevels() } }),
            ),
          ]),
        ),
    card('Rules', h('div', { class: 'stack tight' }, rules)),
  ])
}
