/**
 * Keeping the log small.
 *
 * An append only log grows for ever and a browser will not allow it, so events
 * that add nothing are thrown away and, past a limit, the oldest history is
 * trimmed as well.
 *
 * What "adds nothing" means is not decided here. The log decides, in the same
 * walk that draws the room, and hands the answer over as a set of event ids
 * that had an effect. That is the whole design of this file and it is worth
 * saying why, because the obvious alternative was here first and was wrong.
 *
 * It used to work the rules out for itself: keep the newest edit of each
 * message, the newest pin, the newest reaction from each person. Newest is not
 * the same as counted. An edit from somebody who did not write the message is
 * ignored when the room is drawn, and was the newest edit as far as this file
 * was concerned, so the real edit was thrown away and the ignored one kept.
 * The message quietly reverted. Anybody could do that to anybody, and it only
 * took hold once the log was tidied, long after they had gone.
 *
 * Two places deciding the same question is the bug. There is one now.
 */

import { compare, type LogEvent } from './log'

export interface Limits {
  /** Messages to keep per channel, newest first. */
  perChannel: number
  /** A ceiling on the whole space, whatever the channels do. */
  total: number
}

/**
 * Keep the lot.
 *
 * The usual state of affairs, and it is the default for a reason. Trimming is
 * the one part of this that makes two devices disagree: whoever trimmed is
 * looking at a shorter room than whoever did not, and neither of them knows.
 * A limit that applies whether or not there is any pressure makes that happen
 * to everybody eventually and for no reason at all.
 *
 * So nothing is trimmed while there is room, and the room a browser gives a
 * site is measured in gigabytes against messages measured in hundreds of
 * bytes. Trimming happens when a device is genuinely running out, where it is
 * unavoidable and where at least it is that device's problem rather than
 * everybody's.
 */
export const NO_LIMITS: Limits = { perChannel: Infinity, total: Infinity }

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

/** The kinds that stand on their own, as opposed to hanging off a message. */
const STANDALONE = new Set(['said', 'poll'])

/**
 * Work out what to keep.
 *
 * `effective` comes from RoomLog.effective(): every event that contributed to
 * the room as it is drawn. Anything outside it changed nothing and can go.
 * Anything inside it is kept, unless it is old history past the limit, or
 * hangs off something that is.
 */
export function compact(
  events: LogEvent[],
  limits: Limits,
  effective: Set<string>,
): CompactResult {
  const ordered = [...events].sort(compare)

  // Everything that counted, until the trimming below takes some of it back.
  const keepIds = new Set<string>()
  for (const e of ordered) if (effective.has(e.id)) keepIds.add(e.id)

  /*
   * Trim the oldest messages, per channel and then across the space. This is
   * the only part that loses anything a reader would notice, which is why it
   * happens last and at a generous limit.
   */
  const messages = ordered.filter((e) => keepIds.has(e.id) && STANDALONE.has(e.kind))
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

  const live = new Set(survivors.map((m) => m.id))
  for (const m of messages) if (!live.has(m.id)) keepIds.delete(m.id)

  /*
   * An edit, pin, reaction or vote is only worth keeping while the thing it
   * points at is. A retraction is the exception: it is a tombstone, and a peer
   * will offer the original again on the next sync, so the tombstone is what
   * refuses it. Dropping it would let a retracted message come back.
   */
  for (const e of ordered) {
    if (!keepIds.has(e.id)) continue
    if (STANDALONE.has(e.kind) || e.kind === 'retract') continue
    const target = String(e.body.target ?? '')
    if (target && !live.has(target)) keepIds.delete(e.id)
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
  const used = await storagePressure()
  if (used > 0.9) return TIGHT_LIMITS
  if (used > 0.7) return DEFAULT_LIMITS
  return NO_LIMITS
}

/** True when this device is about to start losing history the others keep. */
export async function trimming(): Promise<boolean> {
  return (await storagePressure()) > 0.7
}
