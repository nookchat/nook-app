/**
 * The icon set.
 *
 * Stroked outlines on a 24 unit grid, drawn in the current text colour, so one
 * icon works on a button, on a dark video overlay, and in either theme. Beam
 * used emoji here before, which changed shape on every platform and never
 * matched the weight of the text beside it.
 */

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

const PATHS: Record<IconName, string> = {
  copy: 'M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 17.5zM5.5 16A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5h8A1.5 1.5 0 0 1 15 6.5',
  check: 'M20 6.5 9.5 17 4.5 12',
  // Three eyes drawn as rings, plus a few loose modules. The even odd fill rule
  // is what turns the inner square of each eye into a hole.
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
}

/** Icons drawn as solid shapes rather than strokes. */
const FILLED = new Set<IconName>(['qr', 'stop'])

export function icon(name: IconName, size = 18): SVGSVGElement {
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
    path.setAttribute('stroke-width', '1.7')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
  }
  svg.append(path)
  return svg
}

/** The Beam mark: a rounded hexagon holding a beam of light. */
export function brandMark(size = 26): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')

  const gradient = document.createElementNS(ns, 'linearGradient')
  const id = `beam-mark-${Math.random().toString(36).slice(2, 8)}`
  gradient.setAttribute('id', id)
  gradient.setAttribute('x1', '0')
  gradient.setAttribute('y1', '0')
  gradient.setAttribute('x2', '1')
  gradient.setAttribute('y2', '1')
  for (const [offset, color] of [
    ['0%', 'var(--accent-2)'],
    ['100%', 'var(--accent)'],
  ]) {
    const stop = document.createElementNS(ns, 'stop')
    stop.setAttribute('offset', offset)
    stop.setAttribute('stop-color', color)
    gradient.append(stop)
  }
  const defs = document.createElementNS(ns, 'defs')
  defs.append(gradient)
  svg.append(defs)

  // A hexagon, the way the Zorin mark sits. A thick round join softens the
  // corners without the arc maths.
  const body = document.createElementNS(ns, 'path')
  body.setAttribute('d', 'M16 3.6 27.2 10v12L16 28.4 4.8 22V10z')
  body.setAttribute('fill', `url(#${id})`)
  body.setAttribute('stroke', `url(#${id})`)
  body.setAttribute('stroke-width', '3.4')
  body.setAttribute('stroke-linejoin', 'round')
  svg.append(body)

  // A beam widening as it leaves the mark.
  const beam = document.createElementNS(ns, 'path')
  beam.setAttribute('d', 'M11.5 11.5h9M11.5 16h6.5M11.5 20.5h4')
  beam.setAttribute('stroke', '#fff')
  beam.setAttribute('stroke-width', '2.1')
  beam.setAttribute('stroke-linecap', 'round')
  beam.setAttribute('opacity', '0.96')
  svg.append(beam)

  return svg
}
