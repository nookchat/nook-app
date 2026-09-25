import { BUILT_IN_SERVER, serverUrl } from '../backend'
import { deriveRoom } from '../room'
import type { LogEvent } from '../store/log'
import { roomsChanged, ROOMS_CHANGED, type RoomNote } from '../store/notes'
import { PREFS_CHANGED } from '../store/prefs'
import { bookFor, knownServers } from '../store/server-spaces'
import { avatarKnown, loadAvatar } from '../ui/avatar'
import { SpaceRuntime, type OpenSpace } from './runtime'

const ROOMS_CHANGED_DEBOUNCE_MS = 150

class Registry {
  readonly fresh = new Set<(space: SpaceRuntime, events: LogEvent[]) => void>()

  private readonly runningByRoom = new Map<string, SpaceRuntime>()
  private readonly openingByKey = new Map<string, Promise<SpaceRuntime>>()
  private loading: Promise<void> | null = null
  private catching = false
  private changedTimer = 0

  load(): Promise<void> {
    this.loading ??= (async () => {
      const servers = knownServers()
      if (BUILT_IN_SERVER && !servers.includes(BUILT_IN_SERVER)) servers.unshift(BUILT_IN_SERVER)
      const notes = (await Promise.all(servers.map((s) => bookFor(s).list()))).flat()
      await Promise.all(notes.filter((n) => !n.closed && n.server).map((n) => this.startFrom(n)))
      window.addEventListener(ROOMS_CHANGED, () => void this.catchUp())
    })()
    return this.loading
  }

  async catchUp(): Promise<void> {
    if (this.catching) return
    this.catching = true
    try {
      for (const server of knownServers()) {
        for (const note of await bookFor(server).list()) {
          if (!note.closed && note.server && !this.runningByRoom.has(note.room)) await this.startFrom(note)
        }
      }
    } finally {
      this.catching = false
    }
  }

  private startFrom(note: RoomNote): Promise<SpaceRuntime> {
    return this.open({
      secret: note.secret,
      locked: note.locked === true,
      password: note.password ?? '',
      server: note.server ?? '',
    })
  }

  open(open: OpenSpace): Promise<SpaceRuntime> {
    const server = serverUrl(open.server)
    const key = `${server}|${open.secret}|${open.password}`
    let held = this.openingByKey.get(key)
    if (!held) {
      held = this.start({ ...open, server }).finally(() => this.openingByKey.delete(key))
      this.openingByKey.set(key, held)
    }
    return held
  }

  private async start(open: OpenSpace): Promise<SpaceRuntime> {
    const room = await deriveRoom(open.secret, open.password)
    const held = this.runningByRoom.get(room.id)
    if (held) return held
    const space = new SpaceRuntime(open)
    this.runningByRoom.set(room.id, space)
    space.on('fresh', (events) => {
      for (const fn of this.fresh) fn(space, events)
      roomsChanged()
    })
    space.on('changed', () => this.roomsChangedSoon())
    void space.ready.catch((err) => console.error('[nook] a space did not start', err))
    return space
  }

  get(room: string): SpaceRuntime | undefined {
    return this.runningByRoom.get(room)
  }

  all(): SpaceRuntime[] {
    return [...this.runningByRoom.values()]
  }

  myAvatar(): string {
    if (avatarKnown()) return loadAvatar()
    for (const space of this.runningByRoom.values()) {
      const picture = space.chat?.avatarOf(space.chat.me)
      if (picture) return picture
    }
    return ''
  }

  watchMyAvatar(onChange: () => void): () => void {
    const onFresh = (space: SpaceRuntime, events: LogEvent[]): void => {
      if (events.some((e) => e.kind === 'profile' && e.author === space.chat.me)) onChange()
    }
    window.addEventListener(PREFS_CHANGED, onChange)
    this.fresh.add(onFresh)
    return () => {
      window.removeEventListener(PREFS_CHANGED, onChange)
      this.fresh.delete(onFresh)
    }
  }

  drop(room: string): void {
    this.runningByRoom.get(room)?.stop()
    this.runningByRoom.delete(room)
    roomsChanged()
  }

  private roomsChangedSoon(): void {
    window.clearTimeout(this.changedTimer)
    this.changedTimer = window.setTimeout(roomsChanged, ROOMS_CHANGED_DEBOUNCE_MS)
  }
}

export const spaces = new Registry()
