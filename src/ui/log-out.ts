import { closeConnections } from '../net/connection'
import { forgetPush } from '../net/push'
import { spaces } from '../space/registry'
import { wipeCache } from '../store/cache'
import { forgetEverything } from '../store/identity'
import { showBoot } from './boot'
import { THEME_KEY } from './theme'

/** How long a log out waits for the spaces to hear this device takes no more notifications. */
const LOG_OUT_WAIT_MS = 4000

let going = false

/** A log out is under way: the page goes with no question, even from a share. */
export const loggingOut = (): boolean => going

/**
 * Out of every call, no more notifications on this device, and this browser forgets you:
 * the reload lands on the welcome, as on a first start.
 */
export async function logOutHere(): Promise<void> {
  going = true
  showBoot('Logging out')
  for (const space of spaces.all()) space.leaveVoice()
  await Promise.race([
    forgetPush(spaces.all()).catch(() => undefined),
    new Promise((done) => window.setTimeout(done, LOG_OUT_WAIT_MS)),
  ])
  closeConnections()
  forgetEverything([THEME_KEY])
  await Promise.race([wipeCache(), new Promise((done) => window.setTimeout(done, LOG_OUT_WAIT_MS))])
  window.location.replace(window.location.pathname)
}
