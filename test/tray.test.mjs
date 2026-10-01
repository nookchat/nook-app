import { createRequire } from 'node:module'
import { check, finish } from './harness.mjs'

// The desktop app's tray icon says what waits for you, as Discord's does: a red dot in the
// corner of the icon, and the count in its tooltip and at the top of its menu.
const { dotPlace, trayMenuItems, trayTooltip, withDot } = createRequire(import.meta.url)('../desktop/tray.cjs')

check('with nothing waiting the tooltip is the name alone', trayTooltip(0) === 'Nook')
check('one waiting is said as one', trayTooltip(1) === 'Nook · 1 new notification', trayTooltip(1))
check('more are counted', trayTooltip(12) === 'Nook · 12 new notifications', trayTooltip(12))

const done = []
const act = { open: () => done.push('open'), quit: () => done.push('quit') }
const label = (items) => items.map((i) => i.label ?? '-').join(' | ')
check('the menu is Open and Quit when nothing waits', label(trayMenuItems(0, act)) === 'Open Nook | - | Quit Nook', label(trayMenuItems(0, act)))
const waiting = trayMenuItems(3, act)
check('with messages waiting, the count comes first', label(waiting) === '3 new notifications | - | Open Nook | - | Quit Nook', label(waiting))
waiting[0].click()
waiting.at(-1).click()
check('the count opens the window, and Quit quits', done.join() === 'open,quit', done.join())

const place = dotPlace(32)
check('the dot sits in the top right corner', place.cx + place.r === 32 && place.cy === place.r && place.r < 8, JSON.stringify(place))

// A grey icon, solid all over, 32 pixels square.
const size = 32
const icon = Buffer.alloc(size * size * 4)
for (let i = 0; i < size * size; i++) icon.set([100, 100, 100, 255], i * 4)
const out = withDot(icon, size)
const pixel = (buf, px, py) => [...buf.subarray((py * size + px) * 4, (py * size + px) * 4 + 4)].join()
const middle = [Math.floor(place.cx), Math.floor(place.cy)]
check('the middle of the dot is Nook red, blue first as Electron keeps it', pixel(out, ...middle) === '72,46,194,255', pixel(out, ...middle))
const ring = [Math.floor(place.cx - place.r - place.gap / 2), Math.floor(place.cy)]
check('a clear ring parts the dot from the icon', pixel(out, ...ring).endsWith(',0'), pixel(out, ...ring))
check('the rest of the icon is as it was', pixel(out, 2, 30) === '100,100,100,255' && pixel(out, 2, 2) === '100,100,100,255')
check('the icon it was given is not changed', pixel(icon, ...middle) === '100,100,100,255')

finish()
