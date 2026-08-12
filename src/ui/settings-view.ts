/**
 * Settings.
 *
 * Your name lives here rather than under the chat box, because a name is
 * something you set once and forget, not a control you need beside every
 * message.
 *
 * Your ID lives here too, and it is the more important of the two. The name is
 * a label; the ID is who you are. Everything in the log is signed by and
 * attributed to the ID, so changing your name renames you everywhere, in old
 * messages as well as new ones, and nobody else can take your name by typing it.
 */

import { cleanName } from '../chat'
import { loadIdentity, saveDisplayName, shortKey } from '../store/identity'
import { setSounds, soundsOn } from './sounds'
import { micSettings, setMicSettings, type MicSettings } from '../net/mic'
import { copyText, fmtBytes, h } from './dom'
import { storagePressure } from '../store/compact'
import { download, exportAll, importBundle } from '../store/transfer'
import { icon } from './icons'
import { applyTheme, loadTheme, THEMES } from './themes'
import { toast } from './toast'

export interface SettingsActions {
  rename(name: string): void
  back(): void
  /** Where this space keeps a copy, if it keeps one. Empty means it does not. */
  archive?: string
  setArchive?(url: string): Promise<boolean>
}

export function settingsView(actions: SettingsActions): HTMLElement {
  const identity = loadIdentity()

  const usage = h('div', { class: 'tiny faint', text: 'Checking how much room is left...' })
  void storagePressure().then(async (fraction) => {
    const estimate = await navigator.storage?.estimate?.().catch(() => null)
    usage.textContent = estimate?.usage
      ? `Using ${fmtBytes(estimate.usage)} of the space this browser allows, about ${Math.round(fraction * 100)} percent.`
      : 'This browser does not say how much room is left.'
  })

  const doExport = async (withIdentity: boolean): Promise<void> => {
    download(await exportAll(withIdentity))
    toast(
      withIdentity
        ? 'Exported, key included. Treat that file as a password.'
        : 'Exported. Your key stayed on this device.',
      'info',
      7000,
    )
  }

  const sound = h('button', {
    class: soundsOn() ? 'on' : '',
    text: soundsOn() ? 'Sounds are on' : 'Sounds are off',
    on: {
      click: () => {
        const next = !soundsOn()
        setSounds(next)
        sound.textContent = next ? 'Sounds are on' : 'Sounds are off'
        sound.classList.toggle('on', next)
      },
    },
  })

  /*
   * Microphone processing. All three default to on, which is right for talking
   * to people and wrong for music, so they are off-switches rather than
   * features. A change takes effect the next time you join a channel, because
   * the processing is chosen when the microphone is opened.
   */
  const micRow = (
    key: keyof MicSettings,
    label: string,
    why: string,
  ): HTMLElement => {
    const on = (): boolean => micSettings()[key]
    const button = h('button', {
      class: on() ? 'on' : '',
      text: on() ? `${label}: on` : `${label}: off`,
      title: why,
      on: {
        click: () => {
          const next = { ...micSettings(), [key]: !on() }
          setMicSettings(next)
          button.textContent = next[key] ? `${label}: on` : `${label}: off`
          button.classList.toggle('on', next[key])
        },
      },
    })
    return button
  }

  /*
   * The archive. Off unless somebody turns it on, and off is not a lesser
   * mode: a space works exactly the same without one. What it adds is the one
   * thing holding your own history cannot do, which is catch you up on
   * something said while every single person was offline.
   */
  const archiveInput = h('input', {
    type: 'text',
    ariaLabel: 'Archive address',
    placeholder: 'http://localhost:8787',
    value: actions.archive ?? '',
  })
  const archiveState = h('div', {
    class: 'tiny faint',
    text: actions.archive ? `Keeping a copy at ${actions.archive}` : 'No archive. Nothing is sent anywhere.',
  })
  const archiveSave = h('button', {
    text: 'Use it',
    on: {
      click: () => {
        const want = archiveInput.value.trim()
        archiveState.textContent = want ? 'Looking for it...' : 'Forgetting it...'
        void actions.setArchive?.(want).then((ok) => {
          if (!ok) {
            archiveState.textContent = 'Nothing answered there. Left as it was.'
            return
          }
          archiveState.textContent = want
            ? `Keeping a copy at ${want}`
            : 'No archive. Nothing is sent anywhere.'
        })
      },
    },
  })

  const file = h('input', { type: 'text', ariaLabel: 'Import a file' })
  file.type = 'file'
  file.accept = 'application/json'
  file.classList.add('hidden')
  file.addEventListener('change', async () => {
    const chosen = file.files?.[0]
    if (!chosen) return
    try {
      const takeIdentity = window.confirm(
        'Take the identity from this file as well? Only do this if it is your own export, on a new device. It replaces who you are here.',
      )
      const report = await importBundle(await chosen.text(), takeIdentity)
      toast(
        `Imported ${report.accepted} events across ${report.spaces} spaces.` +
          (report.refused ? ` ${report.refused} were refused.` : '') +
          (report.identity ? ' Your identity was replaced.' : ''),
        'info',
        9000,
      )
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'bad', 8000)
    }
    file.value = ''
  })

  const name = h('input', {
    type: 'text',
    value: identity.name,
    ariaLabel: 'Your name',
    placeholder: 'Your name',
  })
  const save = h('button', { class: 'primary', text: 'Save name' })
  const commit = (): void => {
    const next = cleanName(name.value)
    if (!next) {
      name.value = identity.name
      return
    }
    saveDisplayName(next)
    actions.rename(next)
    toast('Name changed. It updates everywhere, including old messages.', 'info', 5000)
  }
  save.addEventListener('click', commit)
  name.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') commit()
  })

  const idBox = h('div', { class: 'share-code', text: shortKey(identity.pubkey), title: identity.pubkey })
  const copyId = h('button', { class: 'grow' }, [icon('copy', 14), 'Copy full ID'])
  copyId.addEventListener('click', async () => {
    const ok = await copyText(identity.pubkey)
    toast(ok ? 'ID copied.' : 'Could not copy the ID.', ok ? 'info' : 'warn')
  })

  const theme = h('select', { ariaLabel: 'Theme', on: { change: () => applyTheme(theme.value) } })
  for (const t of THEMES) theme.append(h('option', { value: t.id, text: t.name, title: t.note }))
  theme.value = loadTheme()

  return h('main', {}, [
    h('div', { class: 'center-page' }, [
      h('div', { class: 'sheet stack' }, [
        h('div', { class: 'row spread' }, [
          h('span', { class: 'eyebrow', text: 'Settings' }),
          h('button', { text: 'Back', on: { click: actions.back } }),
        ]),

        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Your name' }),
          h('div', { class: 'row' }, [name, save]),
          h('div', {
            class: 'tiny faint',
            text: 'A label, not an identity. Change it whenever you like: it updates everywhere, in old messages too.',
          }),
        ]),

        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Your ID' }),
          idBox,
          h('div', { class: 'row' }, [copyId]),
          h('div', {
            class: 'tiny faint',
            text: 'This is who you are, in short. Every message you write is signed with the full key behind it, so nobody can take your name by typing it, and two people called the same thing are still two people. The key never leaves this device.',
          }),
          h('details', { class: 'adv' }, [
            h('summary', { text: 'Show the whole key' }),
            h('div', { class: 'tiny mono', style: { overflowWrap: 'anywhere' }, text: identity.pubkey }),
          ]),
        ]),

        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Sounds' }),
          sound,
          h('div', { class: 'tiny faint', text: 'A short blip when somebody says something, or walks into the voice channel you are in. Never for anything you did yourself, and never for history arriving from a peer.' }),
        ]),

        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Microphone' }),
          micRow('smart', 'Smart noise removal', 'A small neural network that removes keys, doors and voices behind you, not just steady sound.'),
          micRow('denoise', 'Basic noise suppression', 'The driver\u2019s own. Takes out steady background noise: fans, traffic, a room hum.'),
          micRow('echo', 'Echo cancellation', 'Stops the other side hearing themselves through your speakers.'),
          micRow('gain', 'Automatic volume', 'Evens out how loud you are as you move around.'),
          h('div', {
            class: 'tiny faint',
            text: 'Smart removal is a neural network trained on the noises the driver cannot find: typing, a door, somebody talking behind you. It runs on the audio thread, costs about a tenth of a core, and adds ten milliseconds. The other three run in the driver and cost nothing. Leave them on for talking, and turn them off for music, where the processing hears the content as noise and fights it. A change applies the next time you join a voice channel.',
          }),
        ]),

        actions.setArchive
          ? h('div', { class: 'card stack tight' }, [
              h('span', { class: 'eyebrow', text: 'Archive' }),
              h('div', { class: 'row' }, [archiveInput, archiveSave]),
              archiveState,
              h('div', {
                class: 'tiny faint',
                text: 'Optional, and off by default. Everybody in a space already keeps the whole history and hands it to whoever turns up, so a space survives as long as one person who was in it comes back. The one thing that cannot do is catch you up on something said while every single person was offline. An archive is a machine that is always awake, and that is all it is.',
              }),
              h('details', { class: 'adv' }, [
                h('summary', { text: 'What it can see, and what it can do' }),
                h('div', {
                  class: 'tiny faint',
                  text: 'It cannot read anything. Every event is sealed with the key made from the space code before it leaves this device, and the code lives in the part of a link that a browser never sends to anybody. It cannot lie either: every event inside is signed, and is checked coming back exactly like an event from a person, so one that was altered fails and is dropped. It can forget, or refuse, and either of those leaves you with a working space and no archive. Run one with: docker compose -f server/docker-compose.yml up -d',
                }),
              ]),
            ])
          : null,

        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Your data' }),
          usage,
          h('div', { class: 'row' }, [
            h('button', { class: 'grow', text: 'Export everything', on: { click: () => void doExport(false) } }),
            h('button', { text: 'Export with my ID', title: 'Carries your key too, so a new device is still you', on: { click: () => void doExport(true) } }),
          ]),
          h('div', { class: 'row' }, [file, h('button', { class: 'grow', text: 'Import a file', on: { click: () => file.click() } })]),
          h('div', {
            class: 'tiny faint',
            text: 'Every event in a file is verified the same way one from a person is, so an import can only add what it can prove. Old messages, edits and reactions are compacted away as they are superseded, and history past a limit is trimmed from the oldest end.',
          }),
        ]),

        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Look' }),
          theme,
          h('div', { class: 'tiny faint', text: 'Kept in this browser.' }),
        ]),
      ]),
    ]),
  ])
}
