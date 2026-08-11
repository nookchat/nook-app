/**
 * Keeping the log small.
 *
 * An append only log grows for ever, and a browser will not let it. A busy
 * space would eventually meet the storage quota and start failing writes, so
 * the log is compacted: superseded events are thrown away, and history past a
 * limit is trimmed from the oldest end.
 *
 * Everything here is safe to drop because it changes nothing about what the log
 * says:
 *
 *   profiles    only the newest name a key gave itself can be read, so older
 *               ones are dead weight
 *   edits       only the newest edit of a message is shown
 *   reactions   one per person per emoji per message, last one wins
 *   retracted   a retracted message shows nothing, so the message, its edits
 *               and its reactions all go. The retraction stays, because a peer
 *               will offer the original again on the next backfill and the
 *               tombstone is what refuses it.
 *
 * Trimming old messages does lose history, which is why it happens last and at
 * a generous limit. When the quota is tight the limit tightens with it.
 */

import { compare, type LogEvent } from './log'

export interface Limits {
  /** Messages to keep per channel, newest first. */
  perChannel: number
  /** A ceiling on the whole space, whatever the channels do. */
  total: number
}

export const DEFAULT_LIMITS: Limits = { perChannel: 1500, total: 8000 }
/** What to fall back to when the browser says storage is running out. */
export const TIGHT_LIMITS: Limits = { perChannel: 300, total: 1500 }

export interface CompactResult {
  keep: LogEvent[]
  /** Ids to delete from the store. */
  drop: string[]
}

function channelOf(e: LogEvent): string {
  const raw = String(e.body.channel ?? '')
  return raw || 'general'
}

export function compact(events: LogEvent[], limits: Limits = DEFAULT_LIMITS): CompactResult {
  const ordered = [...events].sort(compare)
  const keepIds = new Set<string>()

  const retracted = new Set<string>()
  const latestProfile = new Map<string, string>()
  const latestChannel = new Map<string, string>()
  const latestEdit = new Map<string, string>()
  const latestReact = new Map<string, string>()
  const messages: LogEvent[] = []

  for (const e of ordered) {
    switch (e.kind) {
      case 'retract':
        retracted.add(String(e.body.target ?? ''))
        keepIds.add(e.id)
        break
      case 'profile':
        latestProfile.set(e.author, e.id)
        break
      case 'channel':
        latestChannel.set(`${e.body.voice === true ? 'v' : 't'}:${String(e.body.name ?? '')}`, e.id)
        break
      case 'edit':
        latestEdit.set(String(e.body.target ?? ''), e.id)
        break
      case 'react':
        latestReact.set(`${e.author}|${e.body.target}|${e.body.emoji}`, e.id)
        break
      case 'said':
        messages.push(e)
        break
      case 'role':
      case 'space':
        // Who is allowed to do what, and what the place is called. Both are
        // worked out by walking the log in order, so none of it can be dropped.
        keepIds.add(e.id)
        break
      default:
        break
    }
  }

  for (const id of latestProfile.values()) keepIds.add(id)
  for (const id of latestChannel.values()) keepIds.add(id)

  // Trim the oldest messages per channel, then across the space as a whole.
  const byChannel = new Map<string, LogEvent[]>()
  for (const m of messages) {
    const list = byChannel.get(channelOf(m)) ?? []
    list.push(m)
    byChannel.set(channelOf(m), list)
  }

  let survivors: LogEvent[] = []
  for (const list of byChannel.values()) {
    survivors.push(...list.slice(Math.max(0, list.length - limits.perChannel)))
  }
  survivors.sort(compare)
  if (survivors.length > limits.total) {
    survivors = survivors.slice(survivors.length - limits.total)
  }

  const liveMessages = new Set<string>()
  for (const m of survivors) {
    if (retracted.has(m.id)) continue
    keepIds.add(m.id)
    liveMessages.add(m.id)
  }

  // Edits and reactions only survive alongside the message they point at.
  for (const [target, id] of latestEdit) if (liveMessages.has(target)) keepIds.add(id)
  for (const [key, id] of latestReact) {
    if (liveMessages.has(key.split('|')[1])) keepIds.add(id)
  }

  const keep = ordered.filter((e) => keepIds.has(e.id))
  const drop = ordered.filter((e) => !keepIds.has(e.id)).map((e) => e.id)
  return { keep, drop }
}

/**
 * How much room is left, as a fraction used.
 *
 * Browsers report an estimate rather than the truth, and some report nothing at
 * all, so a missing answer is treated as plenty of room rather than none.
 */
export async function storagePressure(): Promise<number> {
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (!estimate?.quota || !estimate.usage) return 0
    return estimate.usage / estimate.quota
  } catch {
    return 0
  }
}

export async function limitsForNow(): Promise<Limits> {
  return (await storagePressure()) > 0.8 ? TIGHT_LIMITS : DEFAULT_LIMITS
}
