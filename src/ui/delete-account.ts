import { dropVault, records } from '../net/vault'
import { spaces } from '../space/registry'
import { bookFor, knownServers } from '../store/server-spaces'
import { logOutHere } from './log-out'

/** The name a deleted account leaves in every space, beside what it said there. */
export const DELETED_NAME = 'Deleted user'
/** How long the new name has to reach each space before the connections go. */
const ANNOUNCE_WAIT_MS = 1500
/** How long the servers have to answer, before the device logs out all the same. */
const SERVER_WAIT_MS = 8000

const within = <T>(work: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([work, new Promise<undefined>((done) => window.setTimeout(done, ms))])

/**
 * Deletes this account. Your passkeys and recovery keys come off their servers, and your record on
 * every server you know is emptied: it held your list of spaces and your settings. Your other
 * devices see the empty record and log out. Each space then shows the name Deleted user, with no
 * picture or cover, in place of yours. Last, this device forgets you, as a log out does.
 *
 * Throws when no server took the empty record, so nothing was deleted and the person can try again.
 */
export async function deleteAccount(): Promise<void> {
  const servers = knownServers()
  const erased = await within(
    Promise.allSettled([
      ...records().map((record) => dropVault(record)),
      ...servers.map((server) => bookFor(server).erase()),
    ]),
    SERVER_WAIT_MS,
  )
  const emptied = erased?.slice(-servers.length).filter((each) => each.status === 'fulfilled').length ?? 0
  if (servers.length && !emptied) throw new Error('No server could be reached. Check your connection and try again.')

  for (const space of spaces.all()) {
    space.mesh?.setName(DELETED_NAME)
    void space.chat?.announceName(DELETED_NAME, '', '')
  }
  await new Promise((done) => window.setTimeout(done, ANNOUNCE_WAIT_MS))

  await logOutHere('Deleting your account')
}
