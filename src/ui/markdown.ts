import { h } from './dom'

/**
 * Markdown to DOM nodes, for notes. Builds elements, never HTML strings, so what
 * somebody writes cannot put script or styles in the page.
 */
export function renderMarkdown(source: string): DocumentFragment {
  const out = document.createDocumentFragment()
  for (const node of blocks(source.replace(/\r\n?/g, '\n').split('\n'))) out.append(node)
  return out
}

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_LINE = /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$|^\s*\|?\s*:?-{3,}:?\s*\|\s*$/

function blocks(lines: string[]): Node[] {
  const out: Node[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++
      const code = h('code', { text: body.join('\n') })
      if (fence[2]) code.dataset.lang = fence[2]
      out.push(h('pre', {}, [code]))
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push(h(`h${heading[1].length}` as 'h1', {}, inline(heading[2])))
      i++
      continue
    }

    if (RULE.test(line)) {
      out.push(h('hr'))
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1])
      out.push(h('blockquote', {}, blocks(body)))
      continue
    }

    if (ITEM.test(line)) {
      const body: string[] = []
      while (i < lines.length && (ITEM.test(lines[i]) || /^\s{2,}\S/.test(lines[i]) || (!lines[i].trim() && ITEM.test(lines[i + 1] ?? '')))) {
        body.push(lines[i++])
      }
      out.push(list(body))
      continue
    }

    if (line.includes('|') && TABLE_LINE.test(lines[i + 1] ?? '')) {
      const rows: string[] = [line]
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(lines[i++])
      out.push(table(rows))
      continue
    }

    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !ITEM.test(lines[i])
    ) {
      para.push(lines[i++])
    }
    const p = h('p')
    para.forEach((text, n) => {
      if (n > 0) p.append(h('br'))
      p.append(...inline(text.trim()))
    })
    out.push(p)
  }
  return out
}

function list(lines: string[]): HTMLElement {
  const first = ITEM.exec(lines[0])!
  const base = first[1].length
  const ordered = /\d/.test(first[2])
  const box = h(ordered ? 'ol' : 'ul')
  if (ordered && parseInt(first[2], 10) !== 1) box.setAttribute('start', String(parseInt(first[2], 10)))

  let current: { text: string; inner: string[] } | null = null
  const items: { text: string; inner: string[] }[] = []
  for (const line of lines) {
    const hit = ITEM.exec(line)
    if (hit && hit[1].length <= base) {
      current = { text: hit[3], inner: [] }
      items.push(current)
    } else if (current) {
      current.inner.push(line.slice(Math.min(base + 2, line.length - line.trimStart().length)))
    }
  }

  for (const item of items) {
    const li = h('li')
    const task = /^\[([ xX])\]\s+(.*)$/.exec(item.text)
    if (task) {
      li.classList.add('task')
      const tick = h('input', { type: 'checkbox' })
      tick.checked = task[1] !== ' '
      tick.disabled = true
      li.append(tick, ...inline(task[2]))
    } else {
      li.append(...inline(item.text))
    }
    if (item.inner.some((l) => l.trim())) li.append(...blocks(item.inner))
    box.append(li)
  }
  return box
}

function cells(row: string): string[] {
  let text = row.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map((c) => c.trim())
}

function table(rows: string[]): HTMLElement {
  const [head, ...body] = rows
  const wrap = h('div', { class: 'md-table' })
  const t = h('table')
  t.append(h('thead', {}, [h('tr', {}, cells(head).map((c) => h('th', {}, inline(c))))]))
  const tbody = h('tbody')
  for (const row of body) tbody.append(h('tr', {}, cells(row).map((c) => h('td', {}, inline(c)))))
  t.append(tbody)
  wrap.append(t)
  return wrap
}

const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=\S)([\s\S]*?\S)\*|(?<![\w])_(?=\S)([\s\S]*?\S)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"')\]]+)/

function inline(text: string): Node[] {
  const out: Node[] = []
  let rest = text
  while (rest) {
    const hit = INLINE.exec(rest)
    if (!hit) {
      out.push(document.createTextNode(rest))
      break
    }
    if (hit.index > 0) out.push(document.createTextNode(rest.slice(0, hit.index)))
    rest = rest.slice(hit.index + hit[0].length)
    if (hit[2] !== undefined) out.push(h('code', { text: hit[2] }))
    else if (hit[3] !== undefined) out.push(h('strong', {}, inline(hit[3])))
    else if (hit[4] !== undefined) out.push(h('strong', {}, inline(hit[4])))
    else if (hit[5] !== undefined) out.push(h('s', {}, inline(hit[5])))
    else if (hit[6] !== undefined) out.push(h('em', {}, inline(hit[6])))
    else if (hit[7] !== undefined) out.push(h('em', {}, inline(hit[7])))
    else if (hit[8] !== undefined) out.push(link(hit[9], inline(hit[8]), hit[0]))
    else if (hit[10] !== undefined) out.push(link(hit[10], [document.createTextNode(hit[10])], hit[0]))
  }
  return out
}

function link(href: string, label: Node[], raw: string): Node {
  if (!/^(https?:|mailto:)/i.test(href)) return document.createTextNode(raw)
  const a = h('a', {}, label)
  a.href = href
  a.target = '_blank'
  a.rel = 'noreferrer noopener'
  return a
}
