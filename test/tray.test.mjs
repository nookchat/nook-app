import { createRequire } from 'node:module'
import { check, finish } from './harness.mjs'

// The desktop app's tray icon says what waits for you, as Discord's does: the count in the
// corner of the icon, in its tooltip, and at the top of its menu.
const { dotPlace, laidOver, trayMenuItems, trayTooltip } = createRequire(import.meta.url)('../desktop/tray.cjs')

check('with nothing waiting the tooltip is the name alone', trayTooltip(0) === 'Nook')
check('one waiting is said as one', trayTooltip(1) === 'Nook · 1 unread mention or message', trayTooltip(1))
check('more are counted', trayTooltip(12) === 'Nook · 12 unread mentions and messages', trayTooltip(12))

const done = []
const act = { open: () => done.push('open'), quit: () => done.push('quit') }
const label = (items) => items.map((i) => i.label ?? '-').join(' | ')
check('the menu is Open and Quit when nothing waits', label(trayMenuItems(0, act)) === 'Open Nook | - | Quit Nook', label(trayMenuItems(0, act)))
const waiting = trayMenuItems(3, act)
check('with messages waiting, the count comes first', label(waiting) === '3 unread mentions and messages | - | Open Nook | - | Quit Nook', label(waiting))
waiting[0].click()
waiting.at(-1).click()
check('the count opens the window, and Quit quits', done.join() === 'open,quit', done.join())

const { dot, x, y } = dotPlace(32)
check('the count sits in the bottom right corner', x + dot === 32 && y + dot === 32 && dot > 16, JSON.stringify({ dot, x, y }))

// A grey icon, and a count that is solid red in its top left pixel and clear in the rest.
const size = 4
const icon = Buffer.alloc(size * size * 4, 0)
for (let i = 0; i < size * size; i++) icon.set([100, 100, 100, 255], i * 4)
const count = Buffer.alloc(2 * 2 * 4, 0)
count.set([0, 0, 200, 255], 0)
const out = laidOver(icon, size, count, 2, 2, 2)
const pixel = (buf, px, py) => [...buf.subarray((py * size + px) * 4, (py * size + px) * 4 + 4)].join()
check('a solid pixel of the count covers the icon', pixel(out, 2, 2) === '0,0,200,255', pixel(out, 2, 2))
check('a clear pixel of the count leaves the icon as it was', pixel(out, 3, 3) === '100,100,100,255' && pixel(out, 0, 0) === '100,100,100,255')
check('the icon it was given is not changed', pixel(icon, 2, 2) === '100,100,100,255')

finish()
