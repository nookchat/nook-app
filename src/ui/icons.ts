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
  | 'user'
  | 'bell'
  | 'signal'
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
  | 'headphones-off'
  | 'phone-off'
  | 'link'
  | 'enter'
  | 'user-plus'
  | 'leave'
  | 'paperclip'
  | 'download'
  | 'play'
  | 'pause'
  | 'file'
  | 'music'
  | 'chevron-right'
  | 'phone'
  | 'device'
  | 'ghost'
  | 'vanish'
  | 'sun'
  | 'moon'
  | 'lock'
  | 'image'
  | 'camera'
  | 'video'
  | 'check-double'

// The Nook set: a 24px grid, a 1.75px stroke, round caps and joins, and currentColor. The shared
// icons come from nook-brand/react/icons.tsx. The rest are drawn here on the same grid and stroke.

/** A circle as a path, so one icon can be one path. */
const circle = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`

const ellipse = (cx: number, cy: number, rx: number, ry: number): string =>
  `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0z`

const rect = (x: number, y: number, w: number, h: number, r: number): string =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`

/** A stroke, and the small solid shapes (eyes, dots) that some icons have. */
interface Drawing {
  line: string
  solid?: string
}

const MIC = `${rect(9, 3, 6, 11, 3)}M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21`
const LENS = `${circle(11, 11, 7)}M16.2 16.2 21 21`

const ICONS: Record<IconName, string | Drawing> = {
  ghost: {
    line: 'M4.8 10.6A7.2 7.2 0 0 1 19.2 10.6L19.2 17.8Q18 19.4 16.8 18Q15.6 16.6 14.4 18Q13.2 19.4 12 18Q10.8 16.6 9.6 18Q8.4 19.4 7.2 18L3.4 20.6Q4.8 18.6 4.8 15.8Z',
    solid: `${ellipse(9.8, 11, 0.9, 1.3)}${ellipse(14.2, 11, 0.9, 1.3)}`,
  },
  send: 'M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z',
  paperclip: 'm20 11.5-8.4 8.4a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8',
  smile: { line: `${circle(12, 12, 9)}M8.5 14.5a4.5 4.5 0 0 0 7 0`, solid: `${circle(9, 10, 0.9)}${circle(15, 10, 0.9)}` },
  mic: MIC,
  'mic-off': `${MIC}M4 4l16 16`,
  camera: `M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z${circle(12, 13, 3.5)}`,
  image: `${rect(3, 4, 18, 16, 2)}${circle(9, 10, 1.8)}M21 16l-5-5-9 9`,
  video: `${rect(3, 6, 13, 12, 2)}M16 10l5-3v10l-5-3z`,
  phone: 'M5 4h3.5l1.5 4.5-2.2 1.3a11 11 0 0 0 6.4 6.4l1.3-2.2L20 15.5V19a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z',
  'phone-off':
    'M3.5 14.5c4.8-4.4 12.2-4.4 17 0l-1.8 2.3a1 1 0 0 1-1.3.2l-2.2-1.3a1 1 0 0 1-.5-.9V13a10 10 0 0 0-5.4 0v1.8a1 1 0 0 1-.5.9L6.6 17a1 1 0 0 1-1.3-.2z',
  search: LENS,
  'zoom-in': `${LENS}M11 8v6M8 11h6`,
  'zoom-out': `${LENS}M8 11h6`,
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  'chevron-left': 'm15 5-7 7 7 7',
  'chevron-right': 'm9 5 7 7-7 7',
  'chevron-down': 'm6 9.5 6 6 6-6',
  more: { line: '', solid: `${circle(5, 12, 1.2)}${circle(12, 12, 1.2)}${circle(19, 12, 1.2)}` },
  check: 'm5 12.5 4.5 4.5L19 7.5',
  'check-double': 'm2.5 12.5 4.5 4.5 9.5-9.5M11.5 16l1 1L22 7.5',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  lock: `${rect(5, 11, 14, 10, 2)}M8 11V8a4 4 0 0 1 8 0v3`,
  user: `${circle(12, 8, 4)}M4 20a8 8 0 0 1 16 0`,
  people: `${circle(9, 8, 3.5)}M2.5 20a6.5 6.5 0 0 1 13 0M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 13.8a6.5 6.5 0 0 1 3.5 6.2`,
  'user-plus': `${circle(9, 8, 3.5)}M2.5 20a6.5 6.5 0 0 1 13 0M18.5 8v6M15.5 11h6`,
  settings: `M4 7h10M18 7h2M4 17h4M12 17h8${circle(16, 7, 2)}${circle(10, 17, 2)}`,
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  reply: 'M9 7 4 12l5 5M4 12h10a6 6 0 0 1 6 6v1',
  pin: 'M9 3h6l-1 6 4 4H6l4-4zM12 13v8',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  sun: `${circle(12, 12, 4)}M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4`,
  vanish: 'M12 21a7 7 0 0 1-7-7c0-3 2-5.5 4-8 .5 2 1.8 3 3 3 0-2 1-4 3-6 1.5 3 4 5.5 4 11a7 7 0 0 1-7 7z',

  copy: `${rect(9, 8, 11, 11, 2)}M5.5 16A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5h8A1.5 1.5 0 0 1 15 6.5`,
  qr: `${rect(4, 4, 6, 6, 1)}${rect(14, 4, 6, 6, 1)}${rect(4, 14, 6, 6, 1)}M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h.01M20 14h.01`,
  expand: 'M9 4H5.5A1.5 1.5 0 0 0 4 5.5V9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15M15 20h3.5a1.5 1.5 0 0 0 1.5-1.5V15',
  collapse: 'M4 9h3.5A1.5 1.5 0 0 0 9 7.5V4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20M20 15h-3.5a1.5 1.5 0 0 0-1.5 1.5V20',
  pip: `M20 12V6a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5${rect(12.5, 13, 8, 6.5, 1)}`,
  volume: 'M11 5.5 6.5 9.5H3.5v5h3l4.5 4zM15.5 9.5a3.6 3.6 0 0 1 0 5M18.5 6.5a7.5 7.5 0 0 1 0 11',
  'volume-low': 'M11 5.5 6.5 9.5H3.5v5h3l4.5 4zM15.5 9.5a3.6 3.6 0 0 1 0 5',
  mute: 'M11 5.5 6.5 9.5H3.5v5h3l4.5 4zM16 10l5 4M21 10l-5 4',
  fit: `${rect(3, 6, 18, 12, 2)}M8 9.5h8v5H8z`,
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  signal: 'M5 19v-3M10 19v-6.5M15 19V9M20 19V5.5',
  monitor: `${rect(3, 4, 18, 12, 2)}M9 20h6M12 16v4`,
  stop: rect(6, 6, 12, 12, 2),
  share: `${rect(3, 4, 18, 12, 2)}M9 20h6M12 16v4M12 12.5v-5M9.5 10 12 7.5l2.5 2.5`,
  shield: 'M12 3 5 6v5.5c0 4.3 2.9 7.7 7 8.8 4.1-1.1 7-4.5 7-8.8V6z',
  home: 'M4 11 12 4l8 7M6 9.5V20h12V9.5',
  crown: 'M4 8.5l3.6 3L12 5l4.4 6.5 3.6-3-1.6 9H5.6zM5.6 20h12.8',
  menu: 'M4 7h16M4 12h16M4 17h16',
  hash: 'M5 9h14M5 15h14M10.5 4 8.5 20M15.5 4l-2 16',
  thread: 'M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9l-4 3.5V16H5a1 1 0 0 1-1-1zM8 9.5h8M8 12.5h5',
  edit: 'M14.5 6.5l3 3M5 19l1-4L15.8 5.2a2.1 2.1 0 0 1 3 3L9 18z',
  headphones: 'M4.5 16v-3a7.5 7.5 0 0 1 15 0v3M4.5 15.5h2a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1zM19.5 15.5h-2a1 1 0 0 0-1 1V19a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1z',
  'headphones-off':
    'M4.5 16v-3a7.5 7.5 0 0 1 12.6-5.5M19.5 13v3M4.5 15.5h2a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1zM19.5 15.5h-2a1 1 0 0 0-1 1V19a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1zM4 4l16 16',
  link: 'M10 14a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2',
  enter: 'M10 7.5 14.5 12 10 16.5M14.5 12H4M13 4h6a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-6',
  server: `${rect(4, 4, 16, 6.5, 1.5)}${rect(4, 13.5, 16, 6.5, 1.5)}M8 7.25h.01M8 16.75h.01`,
  leave: 'M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8M10 12h10M16.5 8.5 20 12l-3.5 3.5',
  download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14',
  play: 'M8 5.5v13a.8.8 0 0 0 1.2.7l10.3-6.5a.8.8 0 0 0 0-1.4L9.2 4.8A.8.8 0 0 0 8 5.5z',
  pause: `${rect(6.5, 5, 3.5, 14, 1)}${rect(14, 5, 3.5, 14, 1)}`,
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  music: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  device: `${rect(7, 3, 10, 18, 2)}M11 18h2`,
}

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

  const drawing = ICONS[name]
  const { line, solid } = typeof drawing === 'string' ? { line: drawing, solid: '' } : drawing
  if (line) {
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', line)
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '1.75')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
  }
  if (solid) {
    const dots = document.createElementNS(ns, 'path')
    dots.setAttribute('d', solid)
    dots.setAttribute('fill', 'currentColor')
    svg.append(dots)
  }
  return svg
}
