export type IconName =
  | 'copy'
  | 'check'
  | 'qr'
  | 'expand'
  | 'collapse'
  | 'pip'
  | 'volume'
  | 'volume-low'
  | 'mute'
  | 'zoom-in'
  | 'zoom-out'
  | 'fit'
  | 'close'
  | 'refresh'
  | 'monitor'
  | 'mic'
  | 'mic-off'
  | 'stop'
  | 'share'
  | 'shield'
  | 'chevron-down'
  | 'plus'
  | 'minus'
  | 'home'
  | 'crown'
  | 'more'
  | 'menu'
  | 'people'
  | 'pin'
  | 'server'
  | 'hash'
  | 'settings'
  | 'send'
  | 'smile'
  | 'reply'
  | 'thread'
  | 'edit'
  | 'trash'
  | 'search'
  | 'chevron-left'
  | 'headphones'
  | 'phone-off'
  | 'link'
  | 'enter'
  | 'user-plus'
  | 'leave'
  | 'paperclip'
  | 'download'
  | 'play'
  | 'file'
  | 'music'
  | 'chevron-right'
  | 'phone'
  | 'device'

const PATHS: Record<IconName, string> = {
  copy: 'M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 17.5zM5.5 16A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5h8A1.5 1.5 0 0 1 15 6.5',
  pin: 'M9 4h6M10 4.5 9 11l-2.5 2.5h11L15 11l-1-6.5M12 13.5V20',
  check: 'M20 6.5 9.5 17 4.5 12',
  // The even-odd fill rule turns each eye's inner square into a hole.
  qr: 'M3.5 3.5h7v7h-7zM5.5 5.5h3v3h-3zM13.5 3.5h7v7h-7zM15.5 5.5h3v3h-3zM3.5 13.5h7v7h-7zM5.5 15.5h3v3h-3zM13.5 13.5h3v3h-3zM17.5 17.5h3v3h-3zM13.5 18.5h2v2h-2zM18.5 13.5h2v2h-2z',
  expand: 'M9 4H5.5A1.5 1.5 0 0 0 4 5.5V9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15M15 20h3.5a1.5 1.5 0 0 0 1.5-1.5V15',
  collapse: 'M4 9h3.5A1.5 1.5 0 0 0 9 7.5V4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20M20 15h-3.5a1.5 1.5 0 0 0-1.5 1.5V20',
  pip: 'M20 12V6.5A1.5 1.5 0 0 0 18.5 5h-13A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16H10M12.5 13h7a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-5a.5.5 0 0 1 .5-.5z',
  volume: 'M11 5.5 6.5 9.5H3.5v5h3l4.5 4zM15.5 9.5a3.6 3.6 0 0 1 0 5M18.5 6.5a7.5 7.5 0 0 1 0 11',
  'volume-low': 'M11 5.5 6.5 9.5H3.5v5h3l4.5 4zM15.5 9.5a3.6 3.6 0 0 1 0 5',
  mute: 'M11 5.5 6.5 9.5H3.5v5h3l4.5 4zM16 10l5 4M21 10l-5 4',
  'zoom-in': 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.4-4.4M11 8.5v5M8.5 11h5',
  'zoom-out': 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.4-4.4M8.5 11h5',
  fit: 'M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5zM8 9.5h8v5H8z',
  close: 'M18 6 6 18M6 6l12 12',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  monitor: 'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 14.5zM9 20h6M12 16v4',
  mic: 'M12 3.5a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0V6A2.5 2.5 0 0 1 12 3.5zM18 11a6 6 0 0 1-12 0M12 17v3.5',
  'mic-off': 'M9.5 9.5V6a2.5 2.5 0 0 1 4.7-1.2M14.5 12.4a2.5 2.5 0 0 1-4-1.4M18 11a6 6 0 0 1-1 3.3M6 11a6 6 0 0 0 9 5.2M12 17v3.5M4 4l16 16',
  stop: 'M7.5 6h9A1.5 1.5 0 0 1 18 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 16.5v-9A1.5 1.5 0 0 1 7.5 6z',
  share: 'M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 15.5zM9 20h6M12 11V6.5M9.5 9 12 6.5 14.5 9',
  shield: 'M12 3.5 5 6.4v5.1c0 4.2 2.9 7.5 7 8.6 4.1-1.1 7-4.4 7-8.6V6.4z',
  'chevron-down': 'M6 9.5 12 15.5 18 9.5',
  plus: 'M12 5.5v13M5.5 12h13',
  minus: 'M5.5 12h13',
  home: 'M3.5 11.5 12 4.5l8.5 7M6 10v9.5h12V10',
  crown: 'M4 8.5l3.6 3L12 5l4.4 6.5 3.6-3-1.6 8.5H5.6zM5.6 19.5h12.8v1.6H5.6z',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  menu: 'M4 7h16M4 12h16M4 17h16',
  hash: 'M5 9h14M5 15h14M10.5 4 8.5 20M15.5 4l-2 16',
  settings:
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  send: 'M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z',
  smile: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM8.5 14a4.2 4.2 0 0 0 7 0M9 9.8h.01M15 9.8h.01',
  reply: 'M9.5 7 4.5 12l5 5M4.5 12H14a5.5 5.5 0 0 1 5.5 5.5V19',
  thread: 'M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V16A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5zM8 9.5h8M8 12.5h5',
  edit: 'M14.5 6.5l3 3M5 19l1-4L15.8 5.2a2.1 2.1 0 0 1 3 3L9 18z',
  trash: 'M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5',
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.4-4.4',
  'chevron-left': 'M14.5 6 8.5 12l6 6',
  headphones: 'M4.5 16v-3a7.5 7.5 0 0 1 15 0v3M4.5 15.5h2a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1zM19.5 15.5h-2a1 1 0 0 0-1 1v2.5a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1z',
  'phone-off': 'M3.5 14.5c4.8-4.4 12.2-4.4 17 0l-1.8 2.3a1 1 0 0 1-1.3.2l-2.2-1.3a1 1 0 0 1-.5-.9V13a10 10 0 0 0-5.4 0v1.8a1 1 0 0 1-.5.9L6.6 17a1 1 0 0 1-1.3-.2z',
  link: 'M10 14a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2',
  enter: 'M10 7.5 14.5 12 10 16.5M14.5 12H4M13 4.5h5.5a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H13',
  server: 'M5.5 4.5h13a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zM5.5 13.5h13a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zM8 7.5h.01M8 16.5h.01',
  people: 'M9 11.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM3 19.5c0-3 2.7-4.8 6-4.8s6 1.8 6 4.8M16 5.4a3.2 3.2 0 0 1 0 6.2M17.5 14.9c2.1.5 3.5 1.9 3.5 4.6',
  'user-plus': 'M10 11.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM4 19.5c0-3 2.7-4.8 6-4.8s6 1.8 6 4.8M18.5 8v6M15.5 11h6',
  leave: 'M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14M10 12h10M16.5 8.5 20 12l-3.5 3.5',
  paperclip: 'M20 11.5 12.2 19.3a4.8 4.8 0 0 1-6.8-6.8l8.3-8.3a3.2 3.2 0 0 1 4.5 4.5l-8.3 8.3a1.6 1.6 0 0 1-2.3-2.3l7.6-7.6',
  download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14',
  play: 'M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z',
  file: 'M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5zM13.5 3.5v5h5',
  music: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  'chevron-right': 'M9.5 6 15.5 12l-6 6',
  phone: 'M6.8 3.8h2.4l1.5 4-2 1.3a11 11 0 0 0 6.2 6.2l1.3-2 4 1.5v2.4a2 2 0 0 1-2.1 2A16 16 0 0 1 4.8 5.9a2 2 0 0 1 2-2.1z',
  device: 'M8.5 3h7A1.5 1.5 0 0 1 17 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 19.5v-15A1.5 1.5 0 0 1 8.5 3zM11 18h2',
}

const FILLED = new Set<IconName>(['qr', 'stop', 'crown', 'play'])

const drawn = new Map<string, SVGSVGElement>()

export function icon(name: IconName, size = 18): SVGSVGElement {
  const key = `${name}:${size}`
  let template = drawn.get(key)
  if (!template) {
    template = draw(name, size)
    drawn.set(key, template)
  }
  return template.cloneNode(true) as SVGSVGElement
}

function draw(name: IconName, size: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('icon')

  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', PATHS[name])
  if (FILLED.has(name)) {
    path.setAttribute('fill', 'currentColor')
    path.setAttribute('fill-rule', 'evenodd')
  } else {
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', name === 'more' ? '2.6' : '1.7')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
  }
  svg.append(path)
  return svg
}
