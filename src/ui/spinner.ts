import { h } from './dom'

/** A turning ring and a line of words, for a part of the page that has not had what it shows yet. */
export function spinner(words = '', size: 'small' | 'big' = 'small'): HTMLDivElement {
  return h('div', { class: `loading-spot ${size}`, role: 'status', ariaLabel: words || 'Loading' }, [
    h('span', { class: 'spinner' }),
    words ? h('span', { class: 'loading-words', text: words }) : null,
  ])
}
