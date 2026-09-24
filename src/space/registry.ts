/**
 * Every space you are in, running.
 *
 * When the page opens it reads your list of spaces from each of your servers
 * (see store/server-spaces.ts) and starts every one of them, so the rail can
 * show which have something new, Home can list every direct message, and a
 * mention anywhere reaches you. They share one connection per server.
 */

import { BUILT_IN_SERVER, serverUrl } from '../backend'
import { roomsChanged, ROOMS_CHANGED, type RoomNote } from '../store/notes'
import { bookFor, knownServers } from '../store/server-spaces'
import { deriveRoom } from '../room'
import type { LogEvent } from '../store/log'
import { SpaceRuntime, type OpenSpace } from './runtime'

class Registry {
  /** By room id. */
  private readonly running = new Map<string, SpaceRuntime>()
  private loading: Promise<void> | null = null
  /** Told about something new in any space, and which. */
  readonly fresh = new Set<(space: SpaceRuntime, events: LogEvent[]) => void>()

  /** Start every space on your list, once. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const servers = knownServers()
      if (BUILT_IN_SERVER && !servers.includes(BUILT_IN_SERVER)) servers.unshift(BUILT_IN_SERVER)
      const notes = (await Promise.all(servers.map((s) => bookFor(s).list()))).flat()
      await Promise.all(notes.filter((n) => !n.closed && n.server).map((n) => this.startFrom(n)))
      // A record that arrives late, from a server slow to answer, starts its spaces then.
      window.addEventListener(ROOMS_CHANGED, () => void this.catchUp())
    })()
    return this.loading
  }

  private catching = false
  /** Start whatever is on your list and not running yet, as after adding a server. */
  async catchUp(): Promise<void> {
    if (this.catching) return
    this.catching = true
    try {
      for (const server of knownServers()) {
        for (const note of await bookFor(server).list()) {
          if (!note.closed && note.server && !this.running.has(note.room)) await this.startFrom(note)
        }
      }
    } finally {
      this.catching = false
    }
  }

  private async startFrom(note: RoomNote): Promise<SpaceRuntime> {
    return this.open({
      secret: note.secret,
      locked: note.locked === true,
      password: note.password ?? '',
      server: note.server ?? '',
    })
  }

  /** Opens under way, so two asking for one space at once get one space. */
  private readonly opening = new Map<string, Promise<SpaceRuntime>>()

  /** The running space for these details, started if it is not running yet. */
  open(open: OpenSpace): Promise<SpaceRuntime> {
    const server = serverUrl(open.server)
    const key = `${server}|${open.secret}|${open.password}`
    let held = this.opening.get(key)
    if (!held) {
      held = this.start({ ...open, server }).finally(() => this.opening.delete(key))
      this.opening.set(key, held)
    }
    return held
  }

  private async start(open: OpenSpace): Promise<SpaceRuntime> {
    const server = open.server
    const room = await deriveRoom(open.secret, open.password)
    const held = this.running.get(room.id)
    if (held) return held
    const space = new SpaceRuntime({ ...open, server })
    this.running.set(room.id, space)
    space.on('fresh', (events) => {
      for (const fn of this.fresh) fn(space, events)
      roomsChanged()
    })
    space.on('changed', () => this.later())
    void space.ready.catch((err) => console.error('[cathode] a space did not start', err))
    return space
  }

  get(room: string): SpaceRuntime | undefined {
    return this.running.get(room)
  }

  all(): SpaceRuntime[] {
    return [...this.running.values()]
  }

  /** Stop a space you left. Its note goes from your record separately. */
  drop(room: string): void {
    this.running.get(room)?.stop()
    this.running.delete(room)
    roomsChanged()
  }

  private timer = 0
  /** Say that unread counts may have moved, at most a few times a second. */
  private later(): void {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(roomsChanged, 150)
  }
}

export const spaces = new Registry()
