// The right click menu a browser gives, which Electron leaves out: in a text box, on a
// selection, on a link or on a picture. The page puts its own menu on everything else, and
// that one never gets here: the page cancels the right click, and Electron shows nothing.

const MAX_SUGGESTIONS = 5

/**
 * What the menu holds, from what Electron says was under the pointer. `act` does what an
 * item needs beyond a role: replace a misspelled word, learn it, open or copy a link, copy
 * a picture. Plain objects, so a check can read them with no Electron there.
 */
function editMenu(params, act) {
  const items = []
  const flags = params.editFlags ?? {}
  const line = () => {
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' })
  }

  if (params.isEditable && params.misspelledWord) {
    for (const word of (params.dictionarySuggestions ?? []).slice(0, MAX_SUGGESTIONS)) {
      items.push({ label: word, click: () => act.replace(word) })
    }
    if (items.length === 0) items.push({ label: 'No guesses', enabled: false })
    items.push({ label: 'Add to dictionary', click: () => act.learn(params.misspelledWord) })
    line()
  }

  if (params.isEditable) {
    items.push(
      { role: 'undo', enabled: !!flags.canUndo },
      { role: 'redo', enabled: !!flags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: !!flags.canCut },
      { role: 'copy', enabled: !!flags.canCopy },
      { role: 'paste', enabled: !!flags.canPaste },
      { role: 'pasteAndMatchStyle', enabled: !!flags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: !!flags.canSelectAll },
    )
  } else if (String(params.selectionText ?? '').trim()) {
    items.push({ role: 'copy' })
  }

  const link = String(params.linkURL ?? '')
  if (/^https?:\/\//i.test(link)) {
    line()
    items.push({ label: 'Open link', click: () => act.open(link) }, { label: 'Copy link', click: () => act.copyText(link) })
  }

  if (params.mediaType === 'image' && params.hasImageContents !== false) {
    line()
    items.push({ label: 'Copy image', click: () => act.copyImage(params.x, params.y) })
  }

  while (items.length && items[items.length - 1].type === 'separator') items.pop()
  return items
}

module.exports = { editMenu }
