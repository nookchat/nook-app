import { DEFAULT_CHANNEL, DEFAULT_VOICE, MAX_ORDER, MEMBER, PERMISSIONS, cleanChannel, type Level, type Permission } from '../store/log'
import type { RoomChat } from '../store/room-chat'

/**
 * A space made from a Discord server template: its name, its roles as levels, and its channels,
 * with who may see each, in Discord's order. No messages and no people: a template has neither.
 * Discord sends a template to any page that asks, so it comes straight from the browser, and the
 * owner's device writes it into the log as if they had set it all up by hand.
 */

export interface DiscordChannel {
  name: string
  label: string
  topic: string
  /** The levels that may see it. Empty is everybody. */
  levels: string[]
  voice: boolean
  nsfw: boolean
  mediaOnly: boolean
  noTalking: boolean
}

export interface DiscordSetup {
  name: string
  /** Member's powers come from @everyone; every other role is a level of its own. */
  levels: Level[]
  text: DiscordChannel[]
  voice: DiscordChannel[]
}

/** The code in a Discord template link: discord.new/CODE or discord.com/template/CODE. */
export function discordTemplateCode(raw: string): string {
  const found = /(?:discord\.new|discord(?:app)?\.com\/template)\/([A-Za-z0-9]{2,32})/i.exec(raw.trim())
  return found?.[1] ?? ''
}

export class DiscordError extends Error {}

export async function fetchDiscordTemplate(code: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`https://discord.com/api/v10/guilds/templates/${encodeURIComponent(code)}`)
  } catch {
    throw new DiscordError('Discord did not answer. Try again soon.')
  }
  if (res.status === 404) throw new DiscordError('That template link does not work. Make a new one in Discord and try again.')
  if (!res.ok) throw new DiscordError(`Discord said no (${res.status}). Try again soon.`)
  return res.json()
}

const VIEW = 1n << 10n
const SPEAK = 1n << 21n
const ADMINISTRATOR = 1n << 3n
const DISCORD_POWERS: Record<Permission, bigint> = {
  channels: 1n << 4n,
  pin: (1n << 13n) | (1n << 51n),
  delete: 1n << 13n,
  relocate: 1n << 13n,
  remove: (1n << 1n) | (1n << 2n),
  move: 1n << 24n,
  soundboard: 1n << 42n,
  levels: 1n << 28n,
  webhooks: 1n << 29n,
  space: 1n << 5n,
}

const TEXT_TYPES = new Set([0, 5, 15, 16])
const VOICE_TYPES = new Set([2, 13])
const CATEGORY = 4
const MEDIA = 16
const STAGE = 13

interface RawRole {
  id: string
  name: string
  perms: bigint
  colour: string
}

interface RawOverwrite {
  id: string
  allow: bigint
  deny: bigint
}

interface RawChannel {
  id: string
  type: number
  name: string
  topic: string
  position: number
  parent: string
  nsfw: boolean
  overwrites: RawOverwrite[]
}

function bits(raw: unknown): bigint {
  try {
    return BigInt(String(raw ?? '0'))
  } catch {
    return 0n
  }
}

function colourOf(raw: unknown): string {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n <= 0xffffff ? `#${n.toString(16).padStart(6, '0')}` : ''
}

function newLevelId(): string {
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function canOf(perms: bigint): Permission[] {
  if (perms & ADMINISTRATOR) return PERMISSIONS.map((p) => p.id)
  return PERMISSIONS.map((p) => p.id).filter((p) => (perms & DISCORD_POWERS[p]) !== 0n)
}

/** Discord's own sum for one role in one channel: @everyone, the role, then each one's overwrite. */
function powersIn(channel: RawChannel, everyone: RawRole, role: RawRole | null): bigint {
  let perms = everyone.perms | (role?.perms ?? 0n)
  if (perms & ADMINISTRATOR) return -1n
  for (const id of role ? [everyone.id, role.id] : [everyone.id]) {
    const over = channel.overwrites.find((o) => o.id === id)
    if (over) perms = (perms & ~over.deny) | over.allow
  }
  return perms
}

export function setupFromTemplate(template: unknown): DiscordSetup {
  const source = (template as { serialized_source_guild?: unknown } | null)?.serialized_source_guild as
    | { name?: unknown; roles?: unknown; channels?: unknown; system_channel_id?: unknown }
    | undefined
  if (!source || !Array.isArray(source.roles) || !Array.isArray(source.channels)) {
    throw new DiscordError('That is not a Discord server template.')
  }
  // A template lists its roles lowest first, @everyone at the bottom.
  const roles: RawRole[] = source.roles.map((r: Record<string, unknown>) => ({
    id: String(r.id),
    name: String(r.name ?? '').slice(0, 24).trim() || 'Role',
    perms: bits(r.permissions),
    colour: colourOf(r.color),
  }))
  const everyone = roles.find((r) => r.name === '@everyone') ?? roles[0] ?? { id: '0', name: '@everyone', perms: 0n, colour: '' }
  const ranked = roles.filter((r) => r !== everyone)

  const levelOf = new Map<string, Level>()
  const levels: Level[] = [{ id: MEMBER, name: 'Member', colour: '', rank: 0, can: canOf(everyone.perms) }]
  ranked.forEach((role, at) => {
    const level = { id: newLevelId(), name: role.name, colour: role.colour, rank: at + 1, can: canOf(everyone.perms | role.perms) }
    levelOf.set(role.id, level)
    levels.push(level)
  })
  const keepers = levels.filter((l) => l.can.includes('channels')).map((l) => l.id)

  const channels: RawChannel[] = source.channels.map((c: Record<string, unknown>) => ({
    id: String(c.id),
    type: Number(c.type),
    name: String(c.name ?? ''),
    topic: typeof c.topic === 'string' ? c.topic : '',
    position: Number(c.position) || 0,
    parent: c.parent_id == null ? '' : String(c.parent_id),
    nsfw: c.nsfw === true,
    overwrites: Array.isArray(c.permission_overwrites)
      ? c.permission_overwrites
          .filter((o: Record<string, unknown>) => Number(o.type ?? 0) === 0)
          .map((o: Record<string, unknown>) => ({ id: String(o.id), allow: bits(o.allow), deny: bits(o.deny) }))
      : [],
  }))

  // Discord's sidebar: what is in no category first, then each category, each by its position.
  const byPlace = (a: RawChannel, b: RawChannel): number => a.position - b.position || Number(a.id) - Number(b.id)
  const categories = channels.filter((c) => c.type === CATEGORY).sort(byPlace)
  const groups = ['', ...categories.map((c) => c.id)]
  const inOrder = (types: Set<number>): RawChannel[] =>
    groups.flatMap((group) => channels.filter((c) => c.parent === group && types.has(c.type)).sort(byPlace))

  /** The levels that may see it, or none when everybody may. */
  const seenBy = (channel: RawChannel): string[] => {
    if (powersIn(channel, everyone, null) & VIEW) return []
    const ids = ranked.filter((role) => powersIn(channel, everyone, role) & VIEW).map((role) => levelOf.get(role.id)!.id)
    // Whoever keeps the channels sees it anyway; with nobody else, it stays kept to them.
    const kept = [...new Set([...ids, ...keepers])]
    return kept.length ? kept : ['nobody']
  }

  const build = (raw: RawChannel[], voice: boolean): DiscordChannel[] => {
    const home = voice ? DEFAULT_VOICE : DEFAULT_CHANNEL
    const made = raw.map((c) => ({
      raw: c,
      channel: {
        name: cleanChannel(c.name) || (voice ? 'voice' : 'channel'),
        label: c.name.slice(0, 32).trim(),
        topic: c.topic.slice(0, 140).trim(),
        levels: seenBy(c),
        voice,
        nsfw: !voice && c.nsfw,
        mediaOnly: !voice && c.type === MEDIA,
        noTalking: voice && (c.type === STAGE || (powersIn(c, everyone, null) & SPEAK) === 0n),
      },
    }))
    // Nook's own general and lounge are always there and open to all, so an open channel stands
    // in for each: one of that name, else Discord's welcome channel, else the first.
    const open = made.filter((m) => m.channel.levels.length === 0)
    const stand =
      open.find((m) => m.channel.name === home) ??
      (voice ? undefined : open.find((m) => m.raw.id === String(source.system_channel_id ?? ''))) ??
      open[0]
    const taken = new Set<string>([home])
    for (const m of made) {
      if (m === stand) {
        m.channel.name = home
        continue
      }
      const base = m.channel.name
      let name = base
      for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 24 - String(n).length - 1)}-${n}`
      taken.add(name)
      m.channel.name = name
    }
    return made.map((m) => m.channel).slice(0, MAX_ORDER)
  }

  return {
    name: String(source.name ?? '').slice(0, 32).trim() || 'From Discord',
    levels,
    text: build(inOrder(TEXT_TYPES), false),
    voice: build(inOrder(VOICE_TYPES), true),
  }
}

/** Writes the setup into a space this person just made. Nook's own Admin and Moderator give way to Discord's roles. */
export async function applyDiscordSetup(chat: RoomChat, setup: DiscordSetup): Promise<void> {
  for (const id of ['admin', 'mod']) await chat.dropLevel(id)
  for (const level of setup.levels) await chat.setLevel(level)
  for (const channel of [...setup.text, ...setup.voice]) await chat.setUpChannel(channel)
  if (setup.text.length) await chat.orderChannels(setup.text.map((c) => c.name))
  if (setup.voice.length) await chat.orderChannels(setup.voice.map((c) => c.name), true)
}
