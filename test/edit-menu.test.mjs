import { createRequire } from 'node:module'
import { check, finish } from './harness.mjs'

// The desktop app's right click menu, which Electron leaves out: what it holds for a text
// box, a misspelled word, a selection, a link and a picture, and that each item does its work.
const { editMenu } = createRequire(import.meta.url)('../desktop/edit-menu.cjs')

const done = []
const act = {
  replace: (w) => done.push(`replace ${w}`),
  learn: (w) => done.push(`learn ${w}`),
  open: (u) => done.push(`open ${u}`),
  copyText: (t) => done.push(`copy ${t}`),
  copyImage: (x, y) => done.push(`image ${x},${y}`),
}
const names = (items) => items.map((i) => i.role ?? i.label ?? '-')
const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }

const box = editMenu({ isEditable: true, editFlags: flags, selectionText: 'hi' }, act)
check(
  'a text box has undo, redo, cut, copy, paste and select all',
  names(box).join() === 'undo,redo,-,cut,copy,paste,pasteAndMatchStyle,-,selectAll',
  names(box).join(),
)
check('and each is on only when it can be', box.find((i) => i.role === 'redo').enabled === false && box.find((i) => i.role === 'paste').enabled === true)

const empty = editMenu({ isEditable: true, editFlags: {} }, act)
check('an empty box with nothing to paste has them all off', empty.filter((i) => i.role).every((i) => i.enabled === false))

const spelt = editMenu({ isEditable: true, editFlags: flags, misspelledWord: 'helo', dictionarySuggestions: ['hello', 'help', 'hero', 'halo', 'held', 'helm'] }, act)
check('a misspelled word has at most five guesses first', names(spelt).slice(0, 6).join() === 'hello,help,hero,halo,held,Add to dictionary', names(spelt).join())
spelt[0].click()
spelt.find((i) => i.label === 'Add to dictionary').click()
check('a guess replaces the word, and Add to dictionary learns it', done.includes('replace hello') && done.includes('learn helo'))

const noGuess = editMenu({ isEditable: true, editFlags: flags, misspelledWord: 'qzx', dictionarySuggestions: [] }, act)
check('with no guesses it says so', noGuess[0].label === 'No guesses' && noGuess[0].enabled === false)

check('a selection in the page has Copy', names(editMenu({ isEditable: false, selectionText: 'some words' }, act)).join() === 'copy')
check('a right click on nothing has no menu', editMenu({ isEditable: false, selectionText: '  ' }, act).length === 0)

const link = editMenu({ isEditable: false, selectionText: '', linkURL: 'https://example.org/a' }, act)
check('a link has Open link and Copy link', names(link).join() === 'Open link,Copy link', names(link).join())
link[0].click()
link[1].click()
check('which open it and copy it', done.includes('open https://example.org/a') && done.includes('copy https://example.org/a'))
check('a link that is not the web gets nothing', editMenu({ isEditable: false, linkURL: 'javascript:alert(1)' }, act).length === 0)

const picture = editMenu({ isEditable: false, mediaType: 'image', x: 10, y: 20 }, act)
picture[0].click()
check('a picture has Copy image, from where it was clicked', names(picture).join() === 'Copy image' && done.includes('image 10,20'))

const both = editMenu({ isEditable: false, selectionText: 'x', linkURL: 'https://a.b/' }, act)
check('a selection in a link has both, with one line between', names(both).join() === 'copy,-,Open link,Copy link', names(both).join())

finish()
