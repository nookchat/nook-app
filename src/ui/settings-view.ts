/**
 * Settings: who you are, which servers you use, the space you came from, and
 * a few preferences. Short on words on purpose; the README says the rest.
 */

import { cleanName } from '../chat'
import { SELF_HOSTING_URL, checkServer, serverTag, serverUrl, setDefaultServer } from '../backend'
import { health } from '../net/server-api'
import { micSettings, setMicSettings, type MicSettings } from '../net/mic'
import { gifCredential, GIF_SERVICES, setGifCredential, type GifService } from '../store/gifs'
import { loadIdentity, saveDisplayName, shortKey } from '../store/identity'
import { addServer, knownServers, newSpaceServer, ownServers } from '../store/server-spaces'
import { loadAvatar, saveAvatar, squareThumb } from './avatar'
import { avatarOf } from './chat-panel'
import { clear, copyText, h } from './dom'
import { openEmojiPicker, quickReactions, setQuickReactions } from './emoji'
import { icon } from './icons'
import { scanLinkCode, showLinkCode } from './link-device'
import { askNotify, notifyState, stopNotify } from './notify'
import { setSounds, soundsOn } from './sounds'
import { toast } from './toast'

/** The guide to running a server, in the repository. */

export interface SettingsActions {
  rename(name: string, avatar?: string): void
  back(): void
  /** The space itself, when settings was opened from inside one. */
  space?: {
    name: string
    admin: boolean
    rename(): Promise<void>
    reset(): Promise<void>
    leave(): Promise<void>
    remove(): Promise<void>
    removed?: { key: string; name: string; restore(): void }[]
  }
}

const card = (title: string, ...children: (Node | null)[]): HTMLElement =>
  h('section', { class: 'card stack tight' }, [h('span', { class: 'eyebrow', text: title }), ...children])

const note = (text: string): HTMLElement => h('div', { class: 'tiny faint', text })

/** A row that says what it is, with a switch at the end that flips when pressed. */
function toggle(label: string, on: () => boolean, set: (next: boolean) => void, about = ''): HTMLButtonElement {
  const button = switchRow(label, about)
  const paint = (): void => {
    button.setAttribute('aria-checked', String(on()))
  }
  button.addEventListener('click', () => {
    set(!on())
    paint()
  })
  paint()
  return button
}

function switchRow(label: string, about = ''): HTMLButtonElement {
  return h('button', { class: 'switch-row', role: 'switch' }, [
    h('span', { class: 'switch-words' }, [
      h('span', { class: 'switch-label', text: label }),
      about ? h('span', { class: 'tiny faint switch-about', text: about }) : null,
    ]),
    h('span', { class: 'switch' }, [h('i')]),
  ])
}

export function settingsView(actions: SettingsActions): HTMLElement {
  const identity = loadIdentity()

  // ---- profile ----
  const name = h('input', { type: 'text', value: identity.name, ariaLabel: 'Your name', placeholder: 'Your name' })
  const save = h('button', { class: 'primary', text: 'Save name' })
  const commit = (): void => {
    const next = cleanName(name.value)
    if (!next) {
      name.value = identity.name
      return
    }
    saveDisplayName(next)
    actions.rename(next)
    toast('Name saved.', 'info')
  }
  save.addEventListener('click', commit)
  name.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') commit()
  })

  // A picture travels inside the signed event that carries your name, shrunk to fit.
  const picture = h('div', { class: 'row' })
  const pickPicture = h('input', { type: 'text', ariaLabel: 'Choose a picture' })
  pickPicture.type = 'file'
  pickPicture.accept = 'image/*'
  pickPicture.classList.add('hidden')
  const drawAvatar = (): void => {
    clear(picture)
    picture.append(
      avatarOf(identity.pubkey, identity.name, loadAvatar(), 44),
      h('button', { text: loadAvatar() ? 'Change picture' : 'Add a picture', on: { click: () => pickPicture.click() } }),
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
  pickPicture.addEventListener('change', async () => {
    const chosen = pickPicture.files?.[0]
    if (!chosen) return
    pickPicture.value = ''
    try {
      const small = await squareThumb(chosen)
      saveAvatar(small)
      actions.rename(cleanName(name.value) || identity.name, small)
      drawAvatar()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That picture could not be used.', 'bad', 7000)
    }
  })
  drawAvatar()

  const copyId = h('button', {}, [icon('copy', 14), 'Copy ID'])
  copyId.addEventListener('click', async () => {
    const ok = await copyText(identity.pubkey)
    toast(ok ? 'ID copied.' : 'Could not copy the ID.', ok ? 'info' : 'warn')
  })

  // ---- servers ----
  const serverList = h('div', { class: 'stack tight' })
  /*
   * Yours first: the ones you added, where your new spaces go. Then the ones
   * an invite led to, which hold spaces you joined and nothing else of yours
   * unless you choose to use one.
   */
  const drawServers = (): void => {
    const own = ownServers()
    const joined = knownServers().filter((s) => !own.includes(s))
    const target = newSpaceServer()
    clear(serverList)
    if (own.length === 0) serverList.append(note('You have no server yet. Add one below to make spaces.'))
    const row = (server: string, mine: boolean): void => {
      const dot = h('i', { class: 'dot idle', title: 'Checking' })
      const peers = h('div', { class: 'server-peers' })
      serverList.append(
        h('div', { class: 'server-row' }, [
          h('div', { class: 'row' }, [
            dot,
            h('span', { class: 'grow truncate server-name', text: serverTag(server) }),
            target === server
              ? h('span', { class: 'pill', text: 'new spaces go here' })
              : h('button', {
                  class: 'ghost tiny-btn',
                  text: 'Use for new spaces',
                  title: mine ? '' : 'Only if whoever runs it is happy for you to',
                  on: {
                    click: () => {
                      addServer(server, true)
                      setDefaultServer(server)
                      drawServers()
                    },
                  },
                }),
          ]),
          peers,
        ]),
      )
      void health(server).then((state) => {
        dot.className = `dot ${state.up ? 'good' : 'bad'}`
        dot.title = state.up ? `Up${state.version ? `, version ${state.version}` : ''}` : 'Not answering'
        // The rest of its cluster: every one keeps a copy of every space.
        for (const peer of state.peers) {
          peers.append(
            h('div', { class: 'row tiny faint' }, [
              h('i', { class: `dot ${peer.up ? 'good' : 'bad'}` }),
              h('span', { class: 'truncate', text: `${serverTag(peer.url)}${peer.up ? '' : ' (down)'}` }),
            ]),
          )
        }
      })
    }
    for (const server of own) row(server, true)
    if (joined.length) {
      serverList.append(h('span', { class: 'eyebrow', text: 'From invites' }))
      for (const server of joined) row(server, false)
    }
  }
  drawServers()

  const addInput = h('input', { type: 'text', placeholder: 'cathode.example.org', ariaLabel: 'Add a server' })
  const addButton = h('button', {
    text: 'Add',
    on: {
      click: async () => {
        const url = serverUrl(addInput.value)
        if (!url) {
          toast('That is not a server address.', 'warn')
          return
        }
        if (!(await checkServer(url))) {
          toast(`No Cathode server answered at ${serverTag(url)}.`, 'bad', 6000)
          return
        }
        addServer(url, true)
        addInput.value = ''
        drawServers()
        toast('Server added.', 'good')
      },
    },
  })

  // Run your own: the three commands, and the guide for the rest.
  const commands = [
    'git clone https://github.com/nebbsie/stream.git && cd stream',
    'cp server/.env.example server/.env   # then fill it in',
    'docker compose -f server/docker-compose.yml up -d',
  ]
  const copyCommands = h('button', { class: 'small' }, [icon('copy', 13), 'Copy'])
  copyCommands.addEventListener('click', async () => {
    const ok = await copyText(commands.join('\n'))
    toast(ok ? 'Copied.' : 'Could not copy.', ok ? 'info' : 'warn')
  })
  const guide = h('a', { class: 'button-link', text: 'Full guide' })
  guide.href = SELF_HOSTING_URL
  guide.target = '_blank'
  guide.rel = 'noopener'
  const own = h('details', { class: 'adv' }, [
    h('summary', { text: 'Run your own server' }),
    h('div', { class: 'stack tight' }, [
      note('A Linux machine with Docker and a domain name.'),
      h('pre', { class: 'code-block', text: commands.join('\n') }),
      h('div', { class: 'row' }, [copyCommands, guide]),
      note('Friends can each run one and join them into a cluster, so every space is kept on all of them.'),
    ]),
  ])

  // ---- this space ----
  const space = actions.space
  const spaceCard = space
    ? card(
        'This space',
        h('div', { class: 'small', text: space.name }),
        space.admin
          ? h('div', { class: 'row wrap' }, [
              h('button', { text: 'Rename', on: { click: () => void space.rename() } }),
              h('button', { class: 'danger', text: 'Clear history', on: { click: () => void space.reset() } }),
            ])
          : null,
        space.admin && space.removed?.length
          ? h('div', { class: 'stack tight' }, [
              h('span', { class: 'eyebrow', text: 'Removed people' }),
              ...space.removed.map((p) => {
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
        h('div', { class: 'row wrap' }, [
          h('button', { text: 'Leave this space', on: { click: () => void space.leave() } }),
          space.admin
            ? h('button', { class: 'danger', text: 'Delete for everybody', on: { click: () => void space.remove() } })
            : null,
        ]),
      )
    : null

  // ---- preferences ----
  const notifyButton = switchRow('Notifications', 'For mentions and direct messages, when the tab is behind')
  const paintNotify = (): void => {
    const state = notifyState()
    notifyButton.setAttribute('aria-checked', String(state === 'on'))
    notifyButton.disabled = state === 'blocked' || state === 'unsupported'
    const about = notifyButton.querySelector('.switch-about')
    if (about) {
      about.textContent =
        state === 'blocked'
          ? 'Blocked by the browser. Allow them in the site settings.'
          : state === 'unsupported'
            ? 'This browser has none.'
            : 'For mentions and direct messages, when the tab is behind'
    }
  }
  notifyButton.addEventListener('click', () => {
    if (notifyState() === 'on') {
      stopNotify()
      paintNotify()
      return
    }
    void askNotify().then(paintNotify)
  })
  paintNotify()

  const mic = (key: keyof MicSettings, label: string, about: string): HTMLButtonElement =>
    toggle(label, () => micSettings()[key], (next) => setMicSettings({ ...micSettings(), [key]: next }), about)

  const quick = h('div', { class: 'row quick-slots' })
  const paintQuick = (): void => {
    clear(quick)
    const pinned = quickReactions()
    for (let i = 0; i < 5; i++) {
      const ch = pinned[i] ?? ''
      const slot = h('button', {
        class: `quick-slot${ch ? '' : ' empty'}`,
        text: ch || '+',
        ariaLabel: ch ? `Quick reaction ${i + 1}, ${ch}` : `Quick reaction ${i + 1}, empty`,
        on: {
          click: () =>
            openEmojiPicker({
              anchor: slot,
              title: 'Quick reaction',
              onPick: (picked) => {
                const next = [...quickReactions()]
                next[i] = picked
                setQuickReactions(next)
                paintQuick()
              },
            }),
        },
      })
      quick.append(slot)
    }
    quick.append(
      h('button', {
        class: 'ghost tiny-btn',
        text: 'Reset',
        on: {
          click: () => {
            setQuickReactions([])
            paintQuick()
          },
        },
      }),
    )
  }
  paintQuick()

  const held = gifCredential()
  const gifPick = h('select', { ariaLabel: 'GIF service' })
  for (const service of GIF_SERVICES) {
    const option = h('option', { text: service.label, value: service.id })
    if (held?.service === service.id) option.selected = true
    gifPick.append(option)
  }
  const gifInput = h('input', {
    type: 'text',
    class: 'grow',
    ariaLabel: 'GIF search key',
    placeholder: 'Your own key (optional)',
    value: held?.key ?? '',
  })
  const gifSave = h('button', {
    text: 'Save',
    on: {
      click: () => {
        setGifCredential((gifPick.value as GifService) || 'klipy', gifInput.value)
        toast(gifInput.value.trim() ? 'GIF key saved.' : 'GIF key cleared.', 'good')
      },
    },
  })

  return h('main', { class: 'settings' }, [
    h('div', { class: 'center-page' }, [
      h('div', { class: 'sheet stack' }, [
        h('div', { class: 'row settings-head' }, [
          h('button', { class: 'ghost', text: 'Back', on: { click: actions.back } }, [icon('chevron-left', 16)]),
          h('h1', { class: 'settings-title', text: 'Settings' }),
        ]),

        card('Profile', h('div', { class: 'row' }, [name, save]), picture, pickPicture),

        card(
          'Your ID',
          h('div', { class: 'row' }, [
            h('span', { class: 'share-code grow', text: shortKey(identity.pubkey), title: identity.pubkey }),
            copyId,
          ]),
          h('div', { class: 'row wrap' }, [
            h('button', { text: 'Link another device', on: { click: () => showLinkCode() } }),
            h('button', {
              class: 'ghost',
              text: 'Use a code from another device',
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
          note('Your key signs everything you write. It stays on this device; linking copies it to another.'),
        ),

        card('Servers', serverList, h('div', { class: 'row' }, [addInput, addButton]), own),

        spaceCard,

        card(
          'Preferences',
          h('div', { class: 'switch-list' }, [
            notifyButton,
            toggle('Sounds', soundsOn, setSounds, 'A chirp for new messages, and the soundboard'),
          ]),
          h('span', { class: 'eyebrow', text: 'Microphone' }),
          h('div', { class: 'switch-list' }, [
            mic('smart', 'Noise removal', 'Takes out keyboards, fans and dogs'),
            mic('denoise', 'Noise suppression', "The browser's own, lighter filter"),
            mic('echo', 'Echo cancellation', 'Stops others hearing themselves through your speakers'),
            mic('gain', 'Auto volume', 'Keeps your voice at a steady level'),
          ]),
          h('span', { class: 'eyebrow', text: 'Quick reactions' }),
          quick,
          h('span', { class: 'eyebrow', text: 'GIF search' }),
          h('div', { class: 'row' }, [gifPick, gifInput, gifSave]),
        ),
      ]),
    ]),
  ])
}
