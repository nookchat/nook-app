/**
 * Moving your data between devices.
 *
 * Everything lives on the device that holds it, which is what makes the history
 * survive and also what makes a new laptop start empty. Export writes it all to
 * one file; import reads one back.
 *
 * Import is not a special path. Every event goes through exactly the same
 * verification that an event from a peer does, so a doctored file can no more
 * put words in somebody's mouth than a doctored peer can. That is worth saying
 * plainly: the file is untrusted input.
 */

import { openEvent, type LogEvent } from './log'
import { getRoom, listRooms, loadRoom, noteRoom, putEvents, type RoomNote } from './db'
import { loadIdentity } from './identity'

const FORMAT = 'cathode-export'
const VERSION = 1

export interface Bundle {
  format: string
  version: number
  exportedAt: number
  /** Only present when the person chose to carry their identity across. */
  identity?: { secret: string; name: string }
  spaces: { note: RoomNote; events: LogEvent[] }[]
}

export interface ImportReport {
  spaces: number
  accepted: number
  refused: number
  identity: boolean
}

/** Everything this device holds, as one file. */
export async function exportAll(includeIdentity: boolean): Promise<Bundle> {
  const notes = await listRooms()
  const spaces = []
  for (const note of notes) {
    spaces.push({ note, events: await loadRoom(note.room) })
  }

  const bundle: Bundle = { format: FORMAT, version: VERSION, exportedAt: Date.now(), spaces }
  if (includeIdentity) {
    let secret = ''
    try {
      secret = localStorage.getItem('cathode.identity.v1') ?? ''
    } catch {
      /* private mode: nothing to carry */
    }
    if (secret) bundle.identity = { secret, name: loadIdentity().name }
  }
  return bundle
}

export function download(bundle: Bundle): void {
  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  const day = new Date(bundle.exportedAt).toISOString().slice(0, 10)
  link.download = `cathode-${day}.json`
  document.body.append(link)
  link.click()
  link.remove()
  // Give the browser a moment to start the download before the URL goes.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Read a bundle back in.
 *
 * Events are verified one by one and merged, so importing the same file twice
 * changes nothing and importing somebody else's export adds only what it can
 * prove. Taking the identity is opt in, because it replaces who you are.
 */
export async function importBundle(text: string, takeIdentity: boolean): Promise<ImportReport> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not readable.')
  }
  const bundle = parsed as Partial<Bundle>
  if (bundle?.format !== FORMAT || !Array.isArray(bundle.spaces)) {
    throw new Error('That is not a Cathode export.')
  }

  const report: ImportReport = { spaces: 0, accepted: 0, refused: 0, identity: false }

  for (const space of bundle.spaces) {
    const note = space?.note
    if (!note?.room || typeof note.room !== 'string') continue
    report.spaces += 1

    const good: LogEvent[] = []
    for (const candidate of Array.isArray(space.events) ? space.events : []) {
      const event = await openEvent(candidate, note.room)
      if (event) good.push(event)
      else report.refused += 1
    }
    report.accepted += good.length
    await putEvents(good)
    /*
     * The whole note, not the four fields it is convenient to copy.
     *
     * The room id is derived from the code and the password together, so a
     * locked space imported without its password is a space this device cannot
     * open: the list offers it, the code derives a different, empty room, and
     * the name on the list belongs to a room nobody can reach. Who founded it
     * and whether it was closed matter for the same reason: they decide what
     * the log means, and a note that lost them says something else.
     */
    const known = await getRoom(note.room)
    await noteRoom({
      ...(known ?? {}),
      room: note.room,
      secret: typeof note.secret === 'string' ? note.secret : known?.secret ?? '',
      lastSeen: typeof note.lastSeen === 'number' ? note.lastSeen : Date.now(),
      title: (typeof note.title === 'string' ? note.title : '') || known?.title || '',
      locked: note.locked === true || known?.locked === true ? true : undefined,
      password:
        (typeof note.password === 'string' ? note.password : '') || known?.password || undefined,
      founder: (typeof note.founder === 'string' ? note.founder : '') || known?.founder || '',
      archive: typeof note.archive === 'string' ? note.archive : known?.archive,
      // A cursor counts lines in one machine's copy of one archive. It is this
      // device's place in it, not the exporting device's, so it does not travel.
      archiveAt: known?.archiveAt,
      closed: note.closed === true || known?.closed === true ? true : undefined,
      floor: typeof note.floor === 'number' ? Math.min(note.floor, known?.floor ?? note.floor) : known?.floor,
    })
  }

  if (takeIdentity && bundle.identity && /^[0-9a-f]{64}$/.test(bundle.identity.secret)) {
    try {
      localStorage.setItem('cathode.identity.v1', bundle.identity.secret)
      if (bundle.identity.name) localStorage.setItem('cathode.name.v1', bundle.identity.name)
      report.identity = true
    } catch {
      /* private mode */
    }
  }

  return report
}
