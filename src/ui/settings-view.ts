import { cleanName } from '../chat'
import { SELF_HOSTING_URL, checkServer, serverTag, serverUrl, setDefaultServer } from '../backend'
import { health } from '../net/server-api'
import { micSettings, setMicSettings } from '../net/mic'
import { loadIdentity, saveDisplayName } from '../store/identity'
import { spaces } from '../space/registry'
import { addServer, knownServers, newSpaceServer, ownServers } from '../store/server-spaces'
import { saveAvatar, squareThumb } from './avatar'
import { avatarOf } from './chat-panel'
import { clear, copyText, h } from './dom'
import { openEmojiPicker, quickReactions, setQuickReactions } from './emoji'
import { icon } from './icons'
import { enterLinkCode, lastBackup, showBackup, showLinkCode } from './link-device'
import { askNotify, notifyState, stopNotify } from './notify'
import { setSounds, soundsOn } from './sounds'
import { spaceFace } from './space-switcher'
import { toast } from './toast'
import { voiceSettings } from './voice-settings'

interface SettingsActions {
  rename(name: string, avatar?: string): void
  back(): void
  space?: {
    id: string
    name: string
    admin: boolean
    rename(): Promise<void>
    reset(): Promise<void>
    leave(): Promise<void>
    remove(): Promise<void>
    removed?: { key: string; name: string; restore(): void }[]
    levels?: () => HTMLElement
  }
}

const card = (title: string, ...children: (Node | null)[]): HTMLElement =>
  h('section', { class: 'card stack tight' }, [h('span', { class: 'eyebrow', text: title }), ...children])

const note = (text: string): HTMLElement => h('div', { class: 'tiny faint', text })

function actionRow(label: string, about: string, button: HTMLButtonElement): HTMLElement {
  return h('div', { class: 'action-row' }, [
    h('span', { class: 'switch-words' }, [
      h('span', { class: 'switch-label', text: label }),
      h('span', { class: 'tiny faint switch-about', text: about }),
    ]),
    button,
  ])
}

function toggle(label: string, on: () => boolean, set: (next: boolean) => void, about = ''): HTMLButtonElement {
  const button = switchRow(label, about)
  const paint = (): void => button.setAttribute('aria-checked', String(on()))
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
  const close = (): void => {
    window.removeEventListener('keydown', onEscape, true)
    actions.back()
  }
  const onEscape = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || ev.defaultPrevented) return
    if (document.querySelector('.scrim, .menu, .emoji-picker, .emoji-pop, .viewer, .gif-pop')) return
    close()
  }
  window.addEventListener('keydown', onEscape, true)
  const identity = loadIdentity()

  const name = h('input', { type: 'text', value: identity.name, ariaLabel: 'Your name', placeholder: 'Your name' })
  const save = h('button', { class: 'primary', text: 'Save', ariaLabel: 'Save name' })
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
    if (ev.key === 'Enter') commit()
  })

  const backupNote = note('')
  const sayBackup = (): void => {
    const at = lastBackup()
    backupNote.textContent = at
      ? `Keep a backup, in case this browser forgets you. You saved one on ${at.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}.`
      : 'Keep a backup, in case this browser forgets you. You have not saved one here yet.'
  }
  sayBackup()

  const picture = h('button', { class: 'welcome-face profile-face', ariaLabel: 'Change your picture', title: 'Change your picture' })
  const removePicture = h('button', { class: 'ghost tiny-btn hidden', text: 'Remove' })
  const pickPicture = h('input', { type: 'file', class: 'hidden', ariaLabel: 'Choose a picture' })
  pickPicture.accept = 'image/*'
  picture.addEventListener('click', () => pickPicture.click())
  removePicture.addEventListener('click', () => {
    saveAvatar('')
    actions.rename(cleanName(name.value) || identity.name, '')
    drawAvatar()
  })
  const drawAvatar = (): void => {
    const avatar = spaces.myAvatar()
    picture.replaceChildren(avatarOf(identity.pubkey, identity.name, avatar, 56), h('span', { class: 'welcome-face-edit' }, [icon('edit', 12)]))
    removePicture.classList.toggle('hidden', !avatar)
  }
  const stopWatching = spaces.watchMyAvatar(() => (picture.isConnected ? drawAvatar() : stopWatching()))
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

  const serverList = h('div', { class: 'stack tight' })
  const drawServers = (): void => {
    const own = ownServers()
    const joined = knownServers().filter((s) => !own.includes(s))
    const target = newSpaceServer()
    clear(serverList)
    if (own.length === 0) serverList.append(note('You have no server yet. Add one to make spaces.'))
    const row = (server: string, mine: boolean): void => {
      const dot = h('i', { class: 'dot idle', title: 'Checking' })
      const peers = h('div', { class: 'server-peers' })
      serverList.append(
        h('div', { class: 'server-row' }, [
          h('div', { class: 'row' }, [
            dot,
            h('span', { class: 'grow truncate server-name', text: serverTag(server) }),
            target === server
              ? h('span', { class: 'pill', text: 'Default', title: 'New spaces go here' })
              : h('button', {
                  class: 'ghost tiny-btn',
                  text: 'Make default',
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
  const addRow = h('div', { class: 'row hidden' })
  const addOpen = h('button', { class: 'ghost small start' }, [icon('plus', 14), 'Add server'])
  addOpen.addEventListener('click', () => {
    addRow.classList.remove('hidden')
    addOpen.classList.add('hidden')
    addInput.focus()
  })
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
          toast(`No Nook server answered at ${serverTag(url)}.`, 'bad', 6000)
          return
        }
        addServer(url, true)
        addInput.value = ''
        addRow.classList.add('hidden')
        addOpen.classList.remove('hidden')
        drawServers()
        toast('Server added.', 'good')
      },
    },
  })

  addRow.append(addInput, addButton)

  const installCommand = 'curl -fsSL https://raw.githubusercontent.com/nebbsie/stream/main/server/install.sh | sh'
  const copyCommand = h('button', { class: 'small' }, [icon('copy', 13), 'Copy'])
  copyCommand.addEventListener('click', async () => {
    const ok = await copyText(installCommand)
    toast(ok ? 'Copied.' : 'Could not copy.', ok ? 'info' : 'warn')
  })
  const guide = h('a', { class: 'button-link', text: 'Full guide' })
  guide.href = SELF_HOSTING_URL
  guide.target = '_blank'
  guide.rel = 'noopener'
  const own = h('details', { class: 'adv' }, [
    h('summary', { text: 'Run a server' }),
    h('div', { class: 'stack tight' }, [
      note('On a Linux machine with Docker, and a domain pointed at it, run this. It asks for the domain and does the rest.'),
      h('pre', { class: 'code-block', text: installCommand }),
      h('div', { class: 'row' }, [copyCommand, guide]),
      note('Friends can each run one and join them into a cluster, so every space is kept on all of them.'),
    ]),
  ])

  const space = actions.space
  const spaceCard = space
    ? card(
        'This space',
        h('div', { class: 'space-card-head' }, [
          spaceFace(space.id, space.name, 44),
          h('div', { class: 'space-card-words' }, [
            h('span', { class: 'space-card-name truncate', text: space.name }),
            note(space.admin ? 'You can rename it, clear it and delete it' : 'You are a member here'),
          ]),
          space.admin
            ? h('button', { class: 'small', on: { click: () => void space.rename() } }, [icon('edit', 14), 'Rename'])
            : null,
        ]),
        space.removed?.length
          ? h('div', { class: 'stack tight' }, [
              h('span', { class: 'eyebrow', text: 'Removed people' }),
              h(
                'div',
                { class: 'action-list' },
                space.removed.map((p) => {
                  const row = h('div', { class: 'action-row' }, [
                    h('span', { class: 'switch-label truncate', text: p.name }),
                    h('button', {
                      class: 'small',
                      text: 'Unban',
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
              ),
            ])
          : null,
        h('div', { class: 'action-list' }, [
          actionRow(
            'Leave the space',
            'It comes off your list. The link still works if you want back in.',
            h('button', { class: 'small', text: 'Leave', on: { click: () => void space.leave() } }),
          ),
          space.admin
            ? actionRow(
                'Clear history',
                'Messages, polls and pins go for everybody. Names, channels and levels stay.',
                h('button', { class: 'small danger', text: 'Clear history', on: { click: () => void space.reset() } }),
              )
            : null,
          space.admin
            ? actionRow(
                'Delete the space',
                'It goes for everybody, on every device. This cannot be undone.',
                h('button', { class: 'small danger', text: 'Delete space', on: { click: () => void space.remove() } }),
              )
            : null,
        ]),
      )
    : null

  const notifyAbout = 'For mentions and direct messages, when the tab is behind'
  const notifyButton = switchRow('Notifications', notifyAbout)
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
            : notifyAbout
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

  const mic = (key: 'echo' | 'denoise' | 'gain' | 'smart', label: string, about: string): HTMLButtonElement =>
    toggle(label, () => micSettings()[key], (next) => setMicSettings({ ...micSettings(), [key]: next }), about)

  const quick = h('div', { class: 'row quick-slots' })
  const paintQuick = (): void => {
    clear(quick)
    const pinned = quickReactions()
    for (let i = 0; i < 5; i++) {
      const ch = pinned[i] ?? ''
      const slot = h('button', {
        class: `quick-slot${ch ? '' : ' empty'}`,
        text: ch,
        title: 'Change',
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
      if (!ch) slot.append(icon('plus', 18))
      quick.append(slot)
    }
    quick.append(
      h('button', {
        class: 'ghost small',
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

  return h('main', { class: 'settings' }, [
    h('div', { class: 'center-page' }, [
      h('div', { class: 'sheet stack' }, [
        h('div', { class: 'row settings-head' }, [
          h('h1', { class: 'settings-title grow', text: 'Settings' }),
          h(
            'button',
            { class: 'ghost icon-only settings-close', ariaLabel: 'Close settings', title: 'Close (Esc)', on: { click: close } },
            [icon('close', 20)],
          ),
        ]),

        card(
          'You',
          h('div', { class: 'profile-row' }, [
            picture,
            h('div', { class: 'stack tight grow' }, [h('div', { class: 'row' }, [name, save]), removePicture]),
          ]),
          pickPicture,
        ),

        spaceCard,
        space?.levels ? card('Levels', space.levels()) : null,

        card(
          'Voice',
          voiceSettings([
            h('div', { class: 'switch-list' }, [
              mic('smart', 'Noise removal', 'Takes out keyboards, fans and dogs'),
              mic('denoise', 'Noise suppression', "The browser's own, lighter filter"),
              mic('echo', 'Echo cancellation', 'Stops others hearing themselves through your speakers'),
              mic('gain', 'Auto volume', 'Keeps your voice at a steady level'),
            ]),
          ]),
        ),

        card(
          'Notifications',
          h('div', { class: 'switch-list' }, [
            notifyButton,
            toggle('Sounds', soundsOn, setSounds, 'A chirp for new messages'),
          ]),
        ),

        card(
          'Quick reactions',
          note('The emoji offered first when you react to a message. An empty place takes one you used lately.'),
          quick,
        ),

        card(
          'Your account',
          note('Use Nook on your phone or another computer, with the same spaces and messages.'),
          h('div', { class: 'row wrap' }, [
            h('button', { text: 'Link a device', on: { click: () => showLinkCode() } }),
            h('button', { class: 'ghost', text: 'Enter a code', on: { click: () => enterLinkCode() } }),
          ]),
          backupNote,
          h('div', { class: 'row wrap' }, [
            h('button', { on: { click: () => showBackup(sayBackup) } }, [icon('download', 15), 'Save a backup']),
          ]),
        ),

        card('Servers', serverList, addOpen, addRow, own),
      ]),
    ]),
  ])
}
