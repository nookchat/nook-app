import { cleanName } from '../chat'
import { SELF_HOSTING_URL, checkServer, serverTag, serverUrl, setDefaultServer } from '../backend'
import { health } from '../net/server-api'
import { micSettings, setMicSettings } from '../net/mic'
import { PLAYING_CHANGED, playingNow, seesGames, setShowsPlaying, showsPlaying } from '../net/playing'
import { seesRecordings } from '../net/recordings'
import { loadIdentity, saveDisplayName } from '../store/identity'
import { spaces } from '../space/registry'
import { addServer, knownServers, newSpaceServer, ownServers } from '../store/server-spaces'
import { aboutSettings } from './about'
import { saveAvatar, squareThumb } from './avatar'
import { avatarOf } from './chat-panel'
import { clear, copyText, h } from './dom'
import { openEmojiPicker, quickReactions, setQuickReactions } from './emoji'
import { icon } from './icons'
import { gameCard } from './game-card'
import { enterLinkCode, lastBackup, showBackup, showLinkCode } from './link-device'
import { paintFolders } from './recordings'
import { askNotify, notifyState, notifyText, notifyWhat, setNotifyText, setNotifyWhat, stopNotify } from './notify'
import { setSounds, soundsOn } from './sounds'
import { card, note, settingsShell, switchRow, toggle, type SettingsTab } from './settings-shell'
import { shortcutSettings } from './shortcuts'
import { setTheme, theme, type Theme } from './theme'
import { toast } from './toast'
import { voiceSettings } from './voice-settings'

interface SettingsActions {
  rename(name: string, avatar?: string): void
  back(): void
  /** The tab to open on. */
  start?: string
}

/** Your own settings. What a space's admins can change is in space-settings.ts. */
export function settingsView(actions: SettingsActions): HTMLElement {
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

  const addInput = h('input', { type: 'text', placeholder: 'nook.example.org', ariaLabel: 'Add a server' })
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

  const installCommand = 'curl -fsSL https://raw.githubusercontent.com/nookchat/nook-app/main/server/install.sh | sh'
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

  const notifyAbout = 'Who said what, when Nook is in the background or closed'
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

  // System, light or dark. System follows the device.
  const themeChoice = (): HTMLElement => {
    const group = h('div', { class: 'theme-choice', role: 'radiogroup', ariaLabel: 'Theme' })
    const choices: [Theme, string, 'monitor' | 'sun' | 'moon'][] = [
      ['system', 'System', 'monitor'],
      ['light', 'Light', 'sun'],
      ['dark', 'Dark', 'moon'],
    ]
    const buttons = choices.map(([value, label, glyph]) => {
      const button = h('button', { role: 'radio', on: { click: () => pick(value) } }, [icon(glyph, 18), label])
      button.dataset.theme = value
      return button
    })
    const paint = (): void => {
      const now = theme()
      for (const button of buttons) {
        const on = button.dataset.theme === now
        button.setAttribute('aria-checked', String(on))
        button.tabIndex = on ? 0 : -1
      }
    }
    const pick = (value: Theme): void => {
      setTheme(value)
      paint()
    }
    group.addEventListener('keydown', (ev) => {
      const step = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0
      if (!step) return
      ev.preventDefault()
      const at = choices.findIndex(([value]) => value === theme())
      const next = (at + step + choices.length) % choices.length
      pick(choices[next][0])
      buttons[next].focus()
    })
    group.append(...buttons)
    paint()
    return group
  }

  const tabs: SettingsTab[] = [
    {
      id: 'profile',
      label: 'Profile',
      icon: 'user',
      group: 'User settings',
      build: () =>
        h('div', { class: 'stack settings-stack' }, [
          card(
            'Name and picture',
            note('What people see next to what you say, in every space.'),
            h('div', { class: 'profile-row' }, [
              picture,
              h('div', { class: 'stack tight grow' }, [h('div', { class: 'row' }, [name, save]), removePicture]),
            ]),
            pickPicture,
          ),
        ]),
    },
    {
      id: 'appearance',
      label: 'Appearance',
      icon: 'sun',
      build: () =>
        h('div', { class: 'stack settings-stack' }, [
          card('Theme', note('Cream by day, charcoal after dark. System follows your device.'), themeChoice()),
        ]),
    },
    {
      id: 'voice',
      label: 'Voice & audio',
      icon: 'mic',
      build: () =>
        voiceSettings(
          h('div', { class: 'switch-list' }, [
            mic('smart', 'Noise removal', 'Takes out keyboards, fans and dogs'),
            mic('denoise', 'Noise suppression', "The browser's own, lighter filter"),
            mic('echo', 'Echo cancellation', 'Stops others hearing themselves through your speakers'),
            mic('gain', 'Auto volume', 'Keeps your voice at a steady level'),
          ]),
        ),
    },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: 'bell',
      build: () => {
        paintNotify()
        return h('div', { class: 'stack settings-stack' }, [
          card(
            'Alerts',
            h('div', { class: 'switch-list' }, [
              notifyButton,
              toggle(
                'Every message',
                () => notifyWhat() === 'all',
                (on) => setNotifyWhat(on ? 'all' : 'mentions'),
                'Off: only when somebody mentions you, and for direct messages',
              ),
              toggle('Show what they said', notifyText, setNotifyText, 'Off: only who, and where'),
              toggle('Sounds', soundsOn, setSounds, 'A chirp for new messages'),
            ]),
          ),
        ])
      },
    },
    {
      id: 'activity',
      label: 'Activity',
      icon: 'game',
      build: () => {
        const now = h('div', { class: 'tiny faint settings-game' })
        const paintNow = (): void => {
          const game = playingNow()
          clear(now)
          // What the others see, the same card as in your menu for them.
          if (seesGames() && showsPlaying() && game) now.append(gameCard(game))
          else {
            now.textContent = !seesGames()
              ? 'Nook finds the game in the desktop app. A browser cannot see your other programs.'
              : !showsPlaying()
                ? 'Nobody sees what you play.'
                : 'No game is running now.'
          }
        }
        const onPlaying = (): void => {
          if (now.isConnected) paintNow()
          else window.removeEventListener(PLAYING_CHANGED, onPlaying)
        }
        window.addEventListener(PLAYING_CHANGED, onPlaying)
        paintNow()
        return h('div', { class: 'stack settings-stack' }, [
          card(
            'What you are playing',
            note('The desktop app sees the game you have open and puts it under your name, the way Discord does.'),
            h('div', { class: 'switch-list' }, [
              toggle('Show what you are playing', showsPlaying, setShowsPlaying, 'Everybody in your spaces sees it'),
            ]),
            now,
          ),
        ])
      },
    },
    {
      id: 'recordings',
      label: 'Recordings',
      icon: 'clapper',
      build: () => {
        const folders = h('div', { class: 'stack tight recordings-folders' })
        if (seesRecordings()) void paintFolders(folders)
        else folders.append(note('The desktop app finds your recordings. A browser cannot see your folders.'))
        return h('div', { class: 'stack settings-stack' }, [
          card(
            'Where your recordings are',
            note(
              'Nook finds Steam\'s game recordings, and the Videos folder where NVIDIA, OBS and Xbox save theirs. Add any other folder. The clip button in the message box makes a clip from one.',
            ),
            folders,
          ),
        ])
      },
    },
    {
      id: 'reactions',
      label: 'Reactions',
      icon: 'smile',
      build: () =>
        h('div', { class: 'stack settings-stack' }, [
          card(
            'Quick reactions',
            note('The emoji offered first when you react to a message. An empty place takes one you used lately.'),
            quick,
          ),
        ]),
    },
    {
      id: 'keys',
      label: 'Keyboard',
      icon: 'keyboard',
      build: () => shortcutSettings(),
    },
    {
      id: 'devices',
      label: 'Devices & backup',
      icon: 'device',
      build: () =>
        h('div', { class: 'stack settings-stack' }, [
          card(
            'Other devices',
            note('Use Nook on your phone or another computer, with the same spaces and messages.'),
            h('div', { class: 'row wrap' }, [
              h('button', { text: 'Link a device', on: { click: () => showLinkCode() } }),
              h('button', { class: 'ghost', text: 'Enter a code', on: { click: () => enterLinkCode() } }),
            ]),
          ),
          card(
            'Backup',
            backupNote,
            h('div', { class: 'row wrap' }, [
              h('button', { on: { click: () => showBackup(sayBackup) } }, [icon('download', 15), 'Save a backup']),
            ]),
          ),
        ]),
    },
    {
      id: 'servers',
      label: 'Servers',
      icon: 'server',
      build: () => {
        drawServers()
        return h('div', { class: 'stack settings-stack' }, [card('Your servers', serverList, addOpen, addRow, own)])
      },
    },
    {
      id: 'about',
      label: 'About',
      icon: 'info',
      build: () => aboutSettings(),
    },
  ]

  return settingsShell({ title: 'Settings', tabs, start: actions.start, close: actions.back })
}
