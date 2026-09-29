import { createRequire } from 'node:module'
import { check, finish } from './harness.mjs'

// Where the desktop app's windows go, with made up screens: the main window opens where it
// was, on the screen it was on, and the screen picker opens over the main window.
const { restoreBounds, pickerBounds } = createRequire(import.meta.url)('../desktop/placement.cjs')

const laptop = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } }
const monitor = { id: 2, workArea: { x: 1440, y: -200, width: 2560, height: 1415 } }
const both = [laptop, monitor]
const min = { width: 380, height: 500 }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const onMonitor = { bounds: { x: 2000, y: 100, width: 1280, height: 800 }, displayId: 2, maximized: false }
check('the window opens where it was, on the second screen', same(restoreBounds(onMonitor, both, min), onMonitor.bounds))

check(
  'with the second screen gone, the system picks, as on a first start',
  restoreBounds(onMonitor, [laptop], min) === null,
)

const halfOff = { bounds: { x: 3200, y: 100, width: 1280, height: 800 }, displayId: 2 }
const back = restoreBounds(halfOff, both, min)
check(
  'a window mostly on its screen is brought all the way on',
  back && back.x === 4000 - 1280 && back.width === 1280 && back.y === 100,
  JSON.stringify(back),
)

// The monitor now sits to the left, so the old place is off every screen.
const moved = [laptop, { id: 2, workArea: { x: -2560, y: 0, width: 2560, height: 1415 } }]
const centredBack = restoreBounds(onMonitor, moved, min)
check(
  'a screen that moved still gets the window, in its middle',
  centredBack && centredBack.x === -2560 + (2560 - 1280) / 2 && centredBack.width === 1280,
  JSON.stringify(centredBack),
)

const huge = { bounds: { x: 1440, y: -200, width: 5000, height: 3000 }, displayId: 2 }
const fitted = restoreBounds(huge, both, min)
check('a window bigger than its screen is made to fit it', fitted && fitted.width === 2560 && fitted.height === 1415, JSON.stringify(fitted))

check('nothing saved: the system picks', restoreBounds(null, both, min) === null && restoreBounds({ bounds: { x: 1 } }, both, min) === null)

const tiny = { bounds: { x: 100, y: 100, width: 100, height: 100 }, displayId: 1 }
const grown = restoreBounds(tiny, both, min)
check('never smaller than the window may be', grown && grown.width === 380 && grown.height === 500, JSON.stringify(grown))

// The picker, over a main window on the second screen.
const parent = { x: 2000, y: 100, width: 1280, height: 800 }
const picker = pickerBounds(parent, both, 928, 688)
check(
  'the picker opens in the middle of the main window, on its screen',
  same(picker, { x: 2000 + (1280 - 928) / 2, y: 100 + (800 - 688) / 2, width: 928, height: 688 }),
  JSON.stringify(picker),
)
const small = pickerBounds({ x: 3600, y: 900, width: 400, height: 300 }, both, 928, 688)
check(
  'a small main window at the edge still gets all of the picker on that screen',
  small.x >= 1440 && small.x + small.width <= 4000 && small.y >= -200 && small.y + small.height <= 1215,
  JSON.stringify(small),
)
const onLaptop = pickerBounds({ x: 0, y: 25, width: 1440, height: 875 }, both, 928, 688)
check('on the laptop, it opens on the laptop', onLaptop.x >= 0 && onLaptop.x + onLaptop.width <= 1440, JSON.stringify(onLaptop))

finish()
