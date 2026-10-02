import { h } from './dom'
import { ghost } from './ghost'
import { icon, type IconName } from './icons'

/**
 * The tour somebody new takes after I’m new, before they pick a name: what Nook is, what it does,
 * how it keeps what they write, and how to start. Skip goes straight to the name. Next, the dots,
 * the arrow keys and a swipe go through it.
 */

export interface Tour {
  readonly el: HTMLElement
  /** Shows a slide: the first when the tour opens, the last when the name step goes back to it. */
  show(slide: 'first' | 'last'): void
}

/** How far a finger goes sideways before it turns the slide. */
const SWIPE_PX = 48

const hidden = <T extends Element>(el: T): T => {
  el.setAttribute('aria-hidden', 'true')
  return el
}

function face(letters: string, tone: 'a' | 'b' | 'c', talking = false): HTMLElement {
  return h('span', { class: `tour-face tour-face--${tone}${talking ? ' talking' : ''}`, text: letters })
}

/** A space, drawn small: its channels, somebody talking in voice, and a conversation. */
function spaceScene(): HTMLElement {
  const channel = (glyph: IconName, name: string, on = false): HTMLElement =>
    h('span', { class: `tour-channel${on ? ' on' : ''}` }, [icon(glyph, 13), h('span', { text: name })])
  const row = (letters: string, tone: 'a' | 'b' | 'c', name: string, words: string): HTMLElement =>
    h('div', { class: 'tour-row' }, [
      face(letters, tone),
      h('span', { class: 'tour-row-words' }, [h('b', { text: name }), h('span', { text: words })]),
    ])
  return hidden(
    h('div', { class: 'tour-scene tour-scene--space' }, [
      h('div', { class: 'tour-window' }, [
        h('div', { class: 'tour-rail' }, [
          h('span', { class: 'tour-space-name', text: 'Game night' }),
          channel('hash', 'general', true),
          channel('hash', 'clips'),
          channel('volume', 'lounge'),
          h('span', { class: 'tour-voice' }, [face('M', 'a', true), face('L', 'b')]),
          h('span', { class: 'tour-scene-ghost' }, [ghost({ mood: 'idle', size: 44 })]),
        ]),
        h('div', { class: 'tour-chat' }, [
          h('span', { class: 'tour-chat-head' }, [icon('hash', 13), h('span', { text: 'general' })]),
          row('M', 'a', 'Maya', 'anyone up for a game tonight?'),
          row('L', 'b', 'Leo', 'in! I’ll share my screen'),
          row('S', 'c', 'Sam', 'see you in the lounge'),
        ]),
      ]),
    ]),
  )
}

/** What a space has, a tile each. */
function featureScene(): HTMLElement {
  const tiles: [IconName, string][] = [
    ['hash', 'Channels'],
    ['mic', 'Voice'],
    ['monitor', 'Screen share'],
    ['video', 'Camera'],
    ['phone', 'Calls'],
    ['whiteboard', 'Boards'],
  ]
  return hidden(
    h(
      'div',
      { class: 'tour-scene tour-scene--features' },
      tiles.map(([glyph, label], i) =>
        h('span', { class: 'tour-tile', style: { animationDelay: `${i * 50}ms` } }, [
          h('span', { class: 'tour-tile-icon' }, [icon(glyph, 20)]),
          h('span', { text: label }),
        ]),
      ),
    ),
  )
}

/** A message sealed on your device, kept by a server that cannot read it, and opened by a friend. */
function sealScene(): HTMLElement {
  const end = (who: string, words: string): HTMLElement =>
    h('span', { class: 'tour-node' }, [
      h('span', { class: 'tour-node-icon' }, [icon('device', 20)]),
      h('span', { class: 'tour-bubble', text: words }),
      h('small', { text: who }),
    ])
  const wire = (): HTMLElement =>
    h('span', { class: 'tour-wire' }, [h('i', { class: 'tour-packet' }), h('span', { class: 'tour-lock' }, [icon('lock', 13)])])
  return hidden(
    h('div', { class: 'tour-scene tour-scene--seal' }, [
      end('You', 'hi Maya'),
      wire(),
      h('span', { class: 'tour-node tour-node--server' }, [
        h('span', { class: 'tour-node-icon' }, [icon('server', 20)]),
        h('span', { class: 'tour-bubble tour-bubble--sealed', text: '••••••' }),
        h('small', { text: 'A Nook server' }),
      ]),
      wire(),
      end('Maya', 'hi Maya'),
    ]),
  )
}

interface Slide {
  title: string
  text: string
  scene: HTMLElement
}

/** The three steps to a first conversation, as the picture of the last slide. */
function startScene(invited: boolean): HTMLElement {
  const step = (n: number, glyph: IconName, title: string, about: string): HTMLElement =>
    h('li', { class: 'tour-step', style: { animationDelay: `${n * 70}ms` } }, [
      h('span', { class: 'tour-step-icon' }, [icon(glyph, 18)]),
      h('span', { class: 'tour-step-words' }, [h('b', { text: title }), h('span', { text: about })]),
    ])
  return h('ol', { class: 'tour-scene tour-scene--start' }, [
    step(0, 'user', 'Pick a name', 'And a picture, if you like.'),
    invited
      ? step(1, 'enter', 'Join their space', 'Your invite takes you straight in.')
      : step(1, 'enter', 'Join or make a space', 'Open a friend’s invite, or add a server.'),
    step(2, 'user-plus', 'Bring your people', 'Send an invite link or its QR code.'),
  ])
}

export function tour(invited: boolean, actions: { done(): void; back(): void }): Tour {
  const slides: Slide[] = [
    {
      title: 'A cozy corner for your friends',
      text: 'Nook is where you and your people hang out: chat in channels, talk in voice, and share your screen, in a space of your own.',
      scene: spaceScene(),
    },
    {
      title: 'Talk, watch, play',
      text: 'Write in a channel, hop into voice, turn on your camera, or share your screen so everybody watches together.',
      scene: featureScene(),
    },
    {
      title: 'Only yours to read',
      text: 'What you write is sealed on your device before it leaves. Spaces live on Nook servers anybody can run, and a server keeps what it cannot read.',
      scene: sealScene(),
    },
    {
      title: invited ? 'You’re nearly in' : 'Getting started',
      text: invited ? 'A friend saved you a seat. Pick a name, and you are in.' : 'Three small steps, and you are talking.',
      scene: startScene(invited),
    },
  ]

  const status = h('span', { class: 'tour-status', role: 'status' })
  const sections = slides.map((slide) =>
    h('section', { class: 'tour-slide', role: 'group' }, [
      slide.scene,
      h('h1', { class: 'welcome-title tour-title', text: slide.title }),
      h('p', { class: 'welcome-text tour-text', text: slide.text }),
    ]),
  )
  sections.forEach((section, i) => {
    section.setAttribute('aria-roledescription', 'slide')
    section.setAttribute('aria-label', `${i + 1} of ${slides.length}`)
  })
  const dots = slides.map((slide, i) => h('button', { class: 'tour-dot', ariaLabel: `Go to ${i + 1} of ${slides.length}: ${slide.title}` }))
  const skip = h('button', { class: 'ghost small tour-skip', text: 'Skip' })
  const back = h('button', { class: 'ghost tour-back', text: 'Back' })
  const next = h('button', { class: 'primary accent tour-next' })
  const track = h('div', { class: 'tour-slides' }, sections)

  const el = h('div', { class: 'welcome-step tour hidden' }, [
    skip,
    track,
    h('div', { class: 'tour-foot' }, [back, h('div', { class: 'tour-dots' }, dots), next]),
    status,
  ])
  el.setAttribute('role', 'region')
  el.setAttribute('aria-roledescription', 'carousel')
  el.setAttribute('aria-label', 'What Nook is')

  let at = 0
  const go = (to: number, focusNext = false): void => {
    const from = at
    at = Math.max(0, Math.min(slides.length - 1, to))
    sections.forEach((section, i) => {
      const on = i === at
      section.classList.toggle('on', on)
      section.inert = !on
      section.setAttribute('aria-hidden', String(!on))
    })
    // The slide comes in from the side it was asked from.
    const shown = sections[at]
    shown.dataset.from = at < from ? 'left' : 'right'
    shown.classList.remove('arrive')
    void shown.offsetWidth
    shown.classList.add('arrive')
    dots.forEach((dot, i) => {
      dot.classList.toggle('on', i === at)
      if (i === at) dot.setAttribute('aria-current', 'step')
      else dot.removeAttribute('aria-current')
    })
    const last = at === slides.length - 1
    next.replaceChildren(
      h('span', { text: last ? (invited ? 'Pick my name' : 'Let’s go') : 'Next' }),
      icon(last ? 'enter' : 'chevron-right', 16),
    )
    skip.classList.toggle('gone', last)
    status.textContent = `${at + 1} of ${slides.length}: ${slides[at].title}`
    if (focusNext) next.focus()
  }

  next.addEventListener('click', () => (at === slides.length - 1 ? actions.done() : go(at + 1, true)))
  back.addEventListener('click', () => (at === 0 ? actions.back() : go(at - 1)))
  skip.addEventListener('click', () => actions.done())
  dots.forEach((dot, i) => dot.addEventListener('click', () => go(i)))
  el.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement) return
    if (ev.key === 'ArrowRight') go(at + 1)
    else if (ev.key === 'ArrowLeft') go(at - 1)
    else return
    ev.preventDefault()
  })

  let down: { x: number; y: number; id: number } | null = null
  track.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'mouse') down = { x: ev.clientX, y: ev.clientY, id: ev.pointerId }
  })
  track.addEventListener('pointerup', (ev) => {
    if (!down || down.id !== ev.pointerId) return
    const dx = ev.clientX - down.x
    const dy = ev.clientY - down.y
    down = null
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy)) return
    go(dx < 0 ? at + 1 : at - 1)
  })
  track.addEventListener('pointercancel', () => (down = null))

  go(0)
  return {
    el,
    show: (slide) => go(slide === 'first' ? 0 : slides.length - 1),
  }
}
