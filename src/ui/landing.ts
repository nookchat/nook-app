import { Capacitor } from '@capacitor/core'
import '../landing.css'
import { avatarOf } from './chat-panel'
import { desktopOs } from './desktop-offer'
import { h } from './dom'
import { ghost, lockup } from './ghost'
import { icon, type IconName } from './icons'

const RELEASES = 'https://github.com/nookchat/nook-app/releases/latest'
const SELF_HOSTING = 'https://github.com/nookchat/nook-app/blob/main/docs/self-hosting.md'
const HOW_IT_WORKS = './how-it-works.html'

/**
 * Whether somebody who is not signed in gets the whole page about Nook, before they start. An
 * invite, the desktop app and the Android app go straight to the card: those people chose already.
 */
export function wantsLanding(invited: boolean): boolean {
  if (invited || Capacitor.isNativePlatform()) return false
  return !(window as Window & { nookDesktop?: unknown }).nookDesktop
}

interface LandingActions {
  /** I'm new: the tour, then a name. */
  start(): void
  /** I have an account: another device, or a backup file. */
  signIn(): void
}

/**
 * The page about Nook for somebody who is not signed in: what it is, what it does, how it keeps
 * messages to the people in a space, and where to get it. Every button that starts goes to the
 * same steps the card has.
 */
export function landing(actions: LandingActions): HTMLElement {
  const startButton = (label: string, cls: string): HTMLButtonElement =>
    h('button', { class: cls, on: { click: () => actions.start() } }, [label, icon('chevron-right', 18)])
  const signInButton = (cls: string): HTMLButtonElement =>
    h('button', { class: cls, text: 'I have an account', on: { click: () => actions.signIn() } })

  const page = h('div', { class: 'welcome-step landing' }, [
    nav(startButton('Get started', 'primary lp-nav-start')),
    hero(startButton('Get started', 'primary accent big lp-cta'), signInButton('secondary big lp-cta')),
    features(),
    privacy(),
    servers(),
    download(startButton('Open Nook here', 'primary big')),
    closing(startButton('Get started', 'primary accent big lp-cta'), signInButton('ghost big')),
    footer(),
  ])
  playWhileSeen(page)
  return page
}

function nav(start: HTMLButtonElement): HTMLElement {
  // The address after # is a space's invite here, so a link on this page scrolls and leaves it be.
  const link = (text: string, to: string): HTMLAnchorElement => {
    const a = h('a', { class: 'lp-nav-link', text })
    a.href = to
    a.addEventListener('click', (ev) => {
      ev.preventDefault()
      document.getElementById(to.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return a
  }
  return h('header', { class: 'lp-nav' }, [
    h('div', { class: 'lp-nav-inner' }, [
      h('div', { class: 'welcome-brand lp-brand' }, [lockup(30)]),
      h('nav', { class: 'lp-nav-links', ariaLabel: 'On this page' }, [
        link('Features', '#lp-features'),
        link('Privacy', '#lp-privacy'),
        link('Servers', '#lp-servers'),
        link('Download', '#lp-download'),
      ]),
      start,
    ]),
  ])
}

function hero(start: HTMLButtonElement, signIn: HTMLButtonElement): HTMLElement {
  const promise = (glyph: IconName, text: string): HTMLElement =>
    h('li', { class: 'lp-promise' }, [icon(glyph, 16), h('span', { text })])
  return h('section', { class: 'lp-hero' }, [
    h('div', { class: 'lp-hero-words' }, [
      h('p', { class: 'lp-kicker' }, [h('span', { class: 'lp-kicker-dot' }), 'Chat, voice and screen share']),
      h('h1', { class: 'lp-title', text: 'A cozy corner for your people to talk.' }),
      h('p', {
        class: 'lp-lead',
        text: 'Spaces with text channels, voice, camera and screen share, for you and your friends. Your device locks every message before it leaves, so the server keeps only what it cannot read.',
      }),
      h('div', { class: 'lp-actions' }, [start, signIn]),
      h('ul', { class: 'lp-promises' }, [
        promise('lock', 'Encrypted on your device'),
        promise('user', 'No email or phone number'),
        promise('server', 'Run your own server'),
      ]),
    ]),
    h('div', { class: 'lp-hero-art' }, [appPreview()]),
  ])
}

/** A small Nook, drawn here: a space, its channels, a voice channel, and a conversation as it happens. */
function appPreview(): HTMLElement {
  const channel = (name: string, on = false, badge = ''): HTMLElement =>
    h('div', { class: `lp-app-channel${on ? ' on' : ''}` }, [
      icon('hash', 14),
      h('span', { text: name }),
      badge ? h('span', { class: 'lp-app-badge', text: badge }) : null,
    ])
  const member = (key: string, name: string, talking = false): HTMLElement =>
    h('div', { class: `lp-app-member${talking ? ' talking' : ''}` }, [avatarOf(key, name, '', 18), h('span', { text: name })])
  const message = (key: string, name: string, time: string, words: (Node | string)[], extra: HTMLElement | null = null): HTMLElement =>
    h('div', { class: 'lp-app-message' }, [
      avatarOf(key, name, '', 32),
      h('div', { class: 'lp-app-message-body' }, [
        h('div', { class: 'lp-app-who' }, [h('span', { class: 'lp-app-name', text: name }), h('span', { class: 'lp-app-time', text: time })]),
        h('div', { class: 'lp-app-text' }, words),
        extra,
      ]),
    ])
  const mention = h('span', { class: 'lp-app-mention', text: '@Theo' })

  const rail = h('div', { class: 'lp-app-rail' }, [
    h('div', { class: 'lp-app-space' }, [h('span', { class: 'lp-app-space-face', text: 'N' }), h('span', { text: 'Night Shift' })]),
    h('div', { class: 'lp-app-label', text: 'Text channels' }),
    channel('general', true),
    channel('design', false, '2'),
    channel('releases'),
    h('div', { class: 'lp-app-label', text: 'Voice' }),
    h('div', { class: 'lp-app-channel lp-app-voice' }, [icon('volume', 14), h('span', { text: 'Lounge' })]),
    member('maya', 'Maya', true),
    member('theo', 'Theo'),
  ])

  const share = h('div', { class: 'lp-app-share' }, [
    h('div', { class: 'lp-app-screen' }, [
      h('span', { class: 'lp-app-screen-line w70' }),
      h('span', { class: 'lp-app-screen-line w45' }),
      h('span', { class: 'lp-app-screen-line w60' }),
      h('span', { class: 'lp-app-live', text: 'Live' }),
    ]),
    h('div', { class: 'lp-app-share-words' }, [
      h('span', { class: 'lp-app-share-title', text: 'Theo is sharing a screen' }),
      h('span', { class: 'lp-app-share-join' }, [icon('monitor', 13), 'Watch']),
    ]),
  ])

  const conversation = h('div', { class: 'lp-app-log' }, [
    message('maya', 'Maya', '9:41 PM', ['anyone up for a round later?']),
    message('theo', 'Theo', '9:42 PM', ['after dinner! sharing the new build first'], share),
    message('ada', 'Ada', '9:43 PM', [mention, ' the soundboard clip you made is perfect 🎉'], h('div', { class: 'lp-app-reacts' }, [
      h('span', { class: 'lp-app-react on', text: '🔥 3' }),
      h('span', { class: 'lp-app-react', text: '😂 2' }),
    ])),
  ])
  const typing = h('div', { class: 'lp-app-typing' }, [ghost({ mood: 'typing', size: 24 }), h('span', { text: 'Maya is typing' })])
  const composer = h('div', { class: 'lp-app-composer' }, [
    icon('plus', 16),
    h('span', { class: 'lp-app-placeholder', text: 'Message #general' }),
    icon('smile', 16),
    h('span', { class: 'lp-app-send' }, [icon('send', 14)]),
  ])

  return h('div', { class: 'lp-app', role: 'img', ariaLabel: 'Nook, with a space, its channels, a voice channel, and a conversation' }, [
    rail,
    h('div', { class: 'lp-app-main' }, [
      h('div', { class: 'lp-app-head' }, [icon('hash', 16), h('span', { text: 'general' }), h('span', { class: 'lp-app-head-topic', text: 'Say hi, share things' })]),
      conversation,
      typing,
      composer,
    ]),
  ])
}

function section(id: string, cls: string, children: (Node | null)[]): HTMLElement {
  const el = h('section', { class: `lp-section ${cls}`, id }, [h('div', { class: 'lp-section-inner' }, children)])
  return el
}

function heading(kicker: string, title: string, text: string): HTMLElement {
  return h('div', { class: 'lp-heading' }, [
    h('p', { class: 'lp-section-kicker', text: kicker }),
    h('h2', { class: 'lp-section-title', text: title }),
    h('p', { class: 'lp-section-text', text }),
  ])
}

function features(): HTMLElement {
  const card = (glyph: IconName, title: string, text: string): HTMLElement =>
    h('article', { class: 'lp-card' }, [
      h('span', { class: 'lp-card-icon' }, [icon(glyph, 20)]),
      h('h3', { class: 'lp-card-title', text: title }),
      h('p', { class: 'lp-card-text', text }),
    ])
  return section('lp-features', 'lp-features', [
    heading('Everything a group needs', 'Talk the way you already do.', 'Channels on the left, the conversation in the middle, and who is here on the right. If you have used Discord, you already know your way around.'),
    h('div', { class: 'lp-cards' }, [
      card('hash', 'Text channels', 'Replies, reactions, threads, pins, edits, search, emoji and GIFs. Markdown and code, too.'),
      card('volume', 'Voice channels', 'Drop in and talk. Noise removal, mute and deafen, and a volume for each person.'),
      card('monitor', 'Screen share', 'Share a screen or a window from a voice channel, up to 1080p, with its sound.'),
      card('video', 'Camera', 'Turn your camera on in a voice channel or a call. Each one is a tile above the chat.'),
      card('phone', 'Messages and calls', 'Direct messages from all your spaces in one place, and a call that rings the other person.'),
      card('paperclip', 'Files', 'Pictures, videos and files up to 100 MB each, with previews in the chat.'),
      card('music', 'Soundboard and notes', 'Play a sound to the room, keep notes for the space, and set a status.'),
      card('crown', 'Levels', 'Owner, Admin, Moderator, Member and levels of your own decide who can do what.'),
      card('game', 'Desktop app', 'Show what you play, pick the window to share, and keep clips of your games.'),
    ]),
  ])
}

function privacy(): HTMLElement {
  const step = (n: number, title: string, text: string): HTMLElement =>
    h('li', { class: 'lp-step' }, [
      h('span', { class: 'lp-step-n', text: String(n) }),
      h('span', { class: 'lp-step-title', text: title }),
      h('span', { class: 'lp-step-text', text }),
    ])
  const link = h('div', { class: 'lp-invite', ariaLabel: 'An invite link' }, [
    h('span', { class: 'lp-invite-host', text: 'nookchat.app/' }),
    h('span', { class: 'lp-invite-key', text: '#K7M2-9QPT-VB2W' }),
  ])
  return section('lp-privacy', 'lp-privacy', [
    h('div', { class: 'lp-privacy-grid' }, [
      h('div', {}, [
        heading('Private by design', 'The server keeps what it cannot read.', 'Each device signs and encrypts what it writes before it sends it. The servers store and pass on data they cannot open, and they cannot write a message in your name.'),
        h('div', { class: 'lp-key' }, [
          link,
          h('p', { class: 'lp-key-text', text: 'A space’s invite holds its key after the #. A browser never sends that part to a server.' }),
        ]),
      ]),
      h('ol', { class: 'lp-steps' }, [
        step(1, 'You write', 'A message, a file, a reaction or a name.'),
        step(2, 'Your device signs it', 'With a key that lives only on your devices. It is you.'),
        step(3, 'Your device locks it', 'With the space’s key, by AES-GCM. A file gets a key of its own.'),
        step(4, 'A server passes it on', 'It keeps the locked copy, and sends it to the others.'),
        step(5, 'Your friends open it', 'Each device unlocks it and checks who wrote it.'),
      ]),
    ]),
    h('p', { class: 'lp-privacy-foot' }, [
      'Voice, camera and screen share go between browsers, encrypted, and Nook keeps no recording of a call. ',
      outLink('How Nook works', HOW_IT_WORKS),
    ]),
  ])
}

function servers(): HTMLElement {
  const point = (glyph: IconName, title: string, text: string): HTMLElement =>
    h('li', { class: 'lp-point' }, [
      h('span', { class: 'lp-point-icon' }, [icon(glyph, 18)]),
      h('span', { class: 'lp-point-words' }, [h('span', { class: 'lp-point-title', text: title }), h('span', { class: 'lp-point-text', text })]),
    ])
  return section('lp-servers', 'lp-servers', [
    h('div', { class: 'lp-servers-grid' }, [
      h('div', {}, [
        heading('Yours to run', 'Start on ours. Move to yours.', 'Your spaces work on the Nook server from the start. When you want your own, one command sets one up on a small Linux machine.'),
        h('ul', { class: 'lp-points' }, [
          point('server', 'One command', 'It makes the secrets, gets a certificate, and starts the server and a relay for calls.'),
          point('people', 'A cluster with friends', 'Several servers keep a copy of each space. When one stops, the app moves to the next.'),
          point('shield', 'Still locked', 'Your own server cannot read your spaces either.'),
        ]),
        outLink('Read the self-hosting guide', SELF_HOSTING, 'lp-more'),
      ]),
      h('div', { class: 'lp-terminal', ariaLabel: 'The command that sets up a server' }, [
        h('div', { class: 'lp-terminal-bar' }, [h('span', {}), h('span', {}), h('span', {})]),
        h('pre', { class: 'lp-terminal-text' }, [
          h('span', { class: 'lp-terminal-prompt', text: '$ ' }),
          'curl -fsSL https://raw.githubusercontent.com/nookchat/nook-app/main/server/install.sh | sh',
          '\n',
          h('span', { class: 'lp-terminal-out', text: 'Your domain? nook.example.org' }),
          '\n',
          h('span', { class: 'lp-terminal-out', text: 'Starting the server, its database, HTTPS and a relay for calls' }),
          '\n',
          h('span', { class: 'lp-terminal-ok', text: 'Your server answers at https://nook.example.org' }),
        ]),
      ]),
    ]),
  ])
}

function download(here: HTMLButtonElement): HTMLElement {
  const os = desktopOs()
  const getDesktop = h('button', { class: 'secondary big', on: { click: () => window.open(RELEASES, '_blank', 'noopener') } }, [
    icon('download', 18),
    os ? `Download for ${os}` : 'Download',
  ])
  const place = (glyph: IconName, title: string, text: string, action: HTMLElement | null): HTMLElement =>
    h('article', { class: 'lp-place' }, [
      h('span', { class: 'lp-card-icon' }, [icon(glyph, 20)]),
      h('h3', { class: 'lp-card-title', text: title }),
      h('p', { class: 'lp-card-text', text }),
      action,
    ])
  return section('lp-download', 'lp-download', [
    heading('Wherever you are', 'On your computer, in a browser, on your phone.', 'One account on all of them. Link a new device with a QR code, and your spaces come along.'),
    h('div', { class: 'lp-places' }, [
      place('monitor', 'Desktop app', 'For macOS, Windows and Linux. It updates itself, and adds game activity, a window picker and clips.', getDesktop),
      place('window', 'In a browser', 'Nothing to install. Voice, screen share and notifications work right here.', here),
      place('device', 'On a phone', 'Open Nook and add it to your home screen. Chat and voice come with you.', null),
    ]),
  ])
}

function closing(start: HTMLButtonElement, signIn: HTMLButtonElement): HTMLElement {
  return section('lp-start', 'lp-closing', [
    h('div', { class: 'lp-closing-ghost' }, [ghost({ mood: 'idle', size: 72, label: 'The Nook ghost' })]),
    h('h2', { class: 'lp-closing-title', text: 'Make a space for your people.' }),
    h('p', { class: 'lp-closing-text', text: 'Pick a name, make a space, and send the invite. It takes a minute.' }),
    h('div', { class: 'lp-actions center' }, [start, signIn]),
  ])
}

function footer(): HTMLElement {
  return h('footer', { class: 'lp-footer' }, [
    h('div', { class: 'lp-footer-inner' }, [
      lockup(22),
      h('nav', { class: 'lp-footer-links', ariaLabel: 'More about Nook' }, [
        outLink('How Nook works', HOW_IT_WORKS),
        outLink('Run a server', SELF_HOSTING),
        outLink('Releases', RELEASES),
      ]),
    ]),
  ])
}

function outLink(text: string, to: string, cls = ''): HTMLAnchorElement {
  const a = h('a', { class: cls, text })
  a.href = to
  if (/^https?:/.test(to)) {
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
  }
  return a
}

/**
 * The preview's typing ghost and the closing ghost move only while they are on screen, so one
 * ghost moves at a time, and a page scrolled away does no work.
 */
function playWhileSeen(page: HTMLElement): void {
  const watch = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.classList.toggle('lp-seen', entry.isIntersecting)
  }, { threshold: 0.25 })
  queueMicrotask(() => {
    for (const el of page.querySelectorAll('.lp-app, .lp-closing-ghost')) watch.observe(el)
  })
}
