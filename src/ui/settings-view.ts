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
import { defaultArchive, setDefaultArchive } from '../store/archive'
import { clear, copyText, fmtBytes, h } from './dom'
import { openEmojiPicker, quickReactions, setQuickReactions } from './emoji'
import { avatarOf } from './chat-panel'
import { loadAvatar, saveAvatar, squareThumb } from './avatar'
import { askNotify, notifyState, stopNotify } from './notify'
import { scanLinkCode, showLinkCode } from './link-device'
import { storagePressure } from '../store/compact'
import { download, exportAll, importBundle } from '../store/transfer'
import { icon } from './icons'
import { toast } from './toast'

export interface SettingsActions {
  rename(name: string, avatar?: string): void
  back(): void
  /** Where this space keeps a copy, if it keeps one. Empty means it does not. */
  archive?: string
  setArchive?(url: string): Promise<boolean>
  /** The space itself, when settings was opened from inside one. */
  space?: {
    name: string
    admin: boolean
    rename(): Promise<void>
    reset(): Promise<void>
    /** Off this device only. Everybody else keeps the space. */
    leave(): Promise<void>
    /** Closed for everybody who reads the log. Admins only. */
    remove(): Promise<void>
    /** Whoever has been removed, and the way back in for each of them. */
    removed?: { key: string; name: string; restore(): void }[]
  }
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
  /*
   * Use this one everywhere. Pasting the same address into every space anybody
   * ever opens is asking them to forget one, and a history kept for some of
   * your spaces and not others is worse than knowing you have none.
   */
  const rememberBox = h('input', { type: 'checkbox', ariaLabel: 'Use this archive for every space' })
  rememberBox.checked = defaultArchive() !== ''
  const rememberRow = h('label', { class: 'row tiny' }, [
    rememberBox,
    h('span', { text: 'Use this for every space, including new ones' }),
  ])

  const archiveSave = h('button', {
    text: 'Use it',
    on: {
      click: () => {
        const want = archiveInput.value.trim()
        archiveState.textContent = want ? 'Looking for it...' : 'Forgetting it...'
        setDefaultArchive(rememberBox.checked ? want : '')
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
          (report.identity ? ' Your identity was replaced. Reloading.' : ''),
        'info',
        9000,
      )
      /*
       * The key is read once and held for the life of the page, so a page that
       * was told it has a new identity still signs with the old one. It said
       * "your identity was replaced" and then wrote everything as the person it
       * had just replaced. Start again rather than keep two answers.
       */
      if (report.identity) window.setTimeout(() => window.location.reload(), 1500)
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

  /*
   * A picture, shrunk until it fits in one signed event.
   *
   * There is nowhere to upload it to, so it travels inside the profile event
   * that carries the name, and an event has a size limit that everybody
   * enforces. Forty eight pixels of WebP is about fifteen hundred characters,
   * which fits with room to spare, and at the size it is drawn nobody can tell.
   */
  const picture = h('div', { class: 'row' })
  const drawAvatar = (): void => {
    clear(picture)
    picture.append(
      avatarOf(identity.pubkey, identity.name, loadAvatar(), 44),
      h('button', {
        text: loadAvatar() ? 'Change picture' : 'Add a picture',
        on: { click: () => pickPicture.click() },
      }),
    )
    if (loadAvatar()) {
      picture.append(
        h('button', {
          class: 'ghost',
          text: 'Remove',
          on: {
            click: () => {
              saveAvatar('')
              actions.rename(cleanName(name.value) || identity.name, '')
              drawAvatar()
            },
          },
        }),
      )
    }
  }
  const pickPicture = h('input', { type: 'text', ariaLabel: 'Choose a picture' })
  pickPicture.type = 'file'
  pickPicture.accept = 'image/*'
  pickPicture.classList.add('hidden')
  pickPicture.addEventListener('change', async () => {
    const chosen = pickPicture.files?.[0]
    if (!chosen) return
    pickPicture.value = ''
    try {
      const small = await squareThumb(chosen)
      saveAvatar(small)
      actions.rename(cleanName(name.value) || identity.name, small)
      drawAvatar()
      toast('Picture set. Everybody sees it the next time they hear from you.', 'info', 6000)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That picture could not be used.', 'bad', 7000)
    }
  })
  drawAvatar()
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

  /** Off, on, or the browser has taken the decision out of your hands. */
  function notifyButton(): HTMLElement {
    const button = h('button', {})
    const paint = (): void => {
      const state = notifyState()
      button.className = state === 'on' ? 'on' : ''
      button.disabled = state === 'blocked' || state === 'unsupported'
      button.textContent =
        state === 'on'
          ? 'Notifications are on'
          : state === 'blocked'
            ? 'This browser is blocking them'
            : state === 'unsupported'
              ? 'This browser has none'
              : 'Notifications are off'
    }
    button.addEventListener('click', () => {
      if (notifyState() === 'on') {
        stopNotify()
        paint()
        return
      }
      void askNotify().then((state) => {
        paint()
        if (state === 'blocked') {
          toast('The browser is refusing. Turn them on for this site in its settings.', 'warn', 8000)
        }
      })
    })
    paint()
    return button
  }

  /** Five slots. Clicking one opens the picker; picking nothing empties it. */
  function quickRow(): HTMLElement {
    const row = h('div', { class: 'row quick-slots' })
    const paint = (): void => {
      clear(row)
      const pinned = quickReactions()
      for (let i = 0; i < 5; i++) {
        const ch = pinned[i] ?? ''
        const slot = h('button', {
          class: `quick-slot${ch ? '' : ' empty'}`,
          text: ch || '+',
          title: ch ? `${ch}. Click to change it, or empty it.` : 'Pin one here',
          ariaLabel: ch ? `Quick reaction ${i + 1}, ${ch}` : `Quick reaction ${i + 1}, empty`,
          on: {
            click: () =>
              openEmojiPicker({
                anchor: slot,
                title: ch ? 'Change this one' : 'Pin one here',
                onPick: (picked) => {
                  const next = [...quickReactions()]
                  next[i] = picked
                  setQuickReactions(next)
                  paint()
                },
              }),
            // The way back out: a slot you can fill has to be one you can empty.
            contextmenu: (ev) => {
              ev.preventDefault()
              const next = [...quickReactions()]
              next.splice(i, 1)
              setQuickReactions(next)
              paint()
            },
          },
        })
        row.append(slot)
      }
      row.append(
        h('button', {
          class: 'ghost tiny-btn',
          text: 'Clear',
          title: 'Empty all five and go back to whatever you have used lately',
          on: {
            click: () => {
              setQuickReactions([])
              paint()
            },
          },
        }),
      )
    }
    paint()
    return row
  }

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
          picture,
          pickPicture,
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

        /*
         * The five reactions offered before the picker is opened.
         *
         * Empty slots fall back to whatever you have been using lately, which
         * is right for somebody who never opens this and right on a new device.
         * Pinning one is for the emoji a particular room runs on.
         */
        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Quick reactions' }),
          quickRow(),
          h('div', {
            class: 'tiny faint',
            text: 'The five offered the moment you react to a message. Click one to change it, or leave them empty to be offered whatever you have used lately.',
          }),
        ]),

        /*
         * Being told when you are not looking.
         *
         * The browser's own notifications, which need no server and last as
         * long as the tab does. Asked for here, on a button that says what it
         * is for, rather than on the way in: a prompt nobody asked for gets
         * refused, and a refusal cannot be taken back from inside the page.
         */
        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Notifications' }),
          notifyButton(),
          h('div', {
            class: 'tiny faint',
            text: 'Only when somebody says your name or writes to you privately, and only while this tab is open behind something else. There is no server holding your messages, so nothing can reach you once the tab is closed.',
          }),
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

        /*
         * The space itself, which is where anybody would look for it.
         *
         * These used to be two small buttons beside the space name in the
         * corner of the rail, which is where you put something you expect
         * people to press by accident. Renaming a room and emptying it are
         * both rare and one of them cannot be undone.
         */
        actions.space
          ? h('div', { class: 'card stack tight' }, [
              h('span', { class: 'eyebrow', text: 'This space' }),
              h('div', { class: 'share-code', text: actions.space.name }),
              actions.space.admin
                ? h('div', { class: 'row' }, [
                    h('button', {
                      class: 'grow',
                      text: 'Rename it',
                      on: { click: () => void actions.space?.rename() },
                    }),
                    h('button', {
                      class: 'danger',
                      text: 'Clear the history',
                      on: { click: () => void actions.space?.reset() },
                    }),
                  ])
                : h('div', {
                    class: 'tiny faint',
                    text: 'Renaming this space and clearing its history are for whoever runs it.',
                  }),
              actions.space.admin
                ? h('div', {
                    class: 'tiny faint',
                    text: 'Clearing takes the messages, polls and pins off every device that is in the space or joins later. Names, channels and who runs it stay. Anybody who already saved a copy keeps it: there is no server to take it back from.',
                  })
                : null,

              /*
               * Whoever has been removed. They are off the members list
               * entirely, because removed should look removed, so the way to
               * let one back in has to live somewhere. It is here, with the
               * other rare admin acts. The row disappears as soon as it is
               * used, without waiting for the log to come back around.
               */
              actions.space.admin && actions.space.removed?.length
                ? h('div', { class: 'stack tight' }, [
                    h('span', { class: 'eyebrow', text: 'Removed people' }),
                    ...actions.space.removed.map((p) => {
                      const row = h('div', { class: 'row spread' }, [
                        h('span', { class: 'truncate tiny', text: p.name, title: `ID ${p.key}` }),
                        h('button', {
                          class: 'small',
                          text: 'Let them back in',
                          on: {
                            click: () => {
                              p.restore()
                              row.remove()
                            },
                          },
                        }),
                      ])
                      return row
                    }),
                  ])
                : null,

              /*
               * The two ways out, which are different things and are worded as
               * different things. Leaving is yours alone. Deleting is the whole
               * room, and only whoever runs it can do it.
               */
              h('div', { class: 'row' }, [
                h('button', {
                  class: 'grow',
                  text: 'Leave this space',
                  title: 'Take it off this device. Everybody else keeps it.',
                  on: { click: () => void actions.space?.leave() },
                }),
                actions.space.admin
                  ? h('button', {
                      class: 'danger',
                      text: 'Delete for everybody',
                      title: 'Close the space on every device that reads the log',
                      on: { click: () => void actions.space?.remove() },
                    })
                  : null,
              ]),
              h('div', {
                class: 'tiny faint',
                text: actions.space.admin
                  ? 'Leaving takes this space off this device and off no other. Deleting writes a signed line saying the space is finished, which every device honours by forgetting it, now or whenever it next syncs. Neither one can reach a copy somebody already exported.'
                  : 'Leaving takes this space off this device. Everybody else keeps theirs, and the link still works if you want back in.',
              }),
            ])
          : null,

        actions.setArchive
          ? h('div', { class: 'card stack tight' }, [
              h('span', { class: 'eyebrow', text: 'Archive' }),
              h('div', { class: 'row' }, [archiveInput, archiveSave]),
              archiveState,
              rememberRow,
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

        /*
         * A second device is a second person unless the key goes with you.
         * Exporting a file and carrying it across works and nobody does it.
         */
        h('div', { class: 'card stack tight' }, [
          h('span', { class: 'eyebrow', text: 'Your other devices' }),
          h('div', { class: 'row' }, [
            h('button', {
              class: 'grow',
              text: 'Show a linking code',
              title: 'Put your key on screen as a QR code for another device to read',
              on: { click: () => showLinkCode() },
            }),
            h('button', {
              text: 'Take over from a code',
              title: 'Read a code from another device and become that person here',
              on: {
                click: () =>
                  scanLinkCode((linked) => {
                    if (linked.name) saveDisplayName(linked.name)
                    toast('This device is you now. Starting again.', 'info', 5000)
                    window.setTimeout(() => window.location.reload(), 1200)
                  }),
              },
            }),
          ]),
          h('div', {
            class: 'tiny faint',
            text: 'Your name and your messages belong to a key kept on this device. Show the code on the device that has it, read it with the one that does not, and both are you. Anybody who photographs that code becomes you, so it clears itself after a minute.',
          }),
        ]),

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
      ]),
    ]),
  ])
}
