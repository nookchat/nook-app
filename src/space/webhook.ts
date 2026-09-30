import { schnorr } from '@noble/curves/secp256k1'
import { fromBase64, fromHex, toBase64, toBase64Url, toHex } from '../bytes'

/**
 * A webhook, as Discord has them: a link another app posts to, and the words land in a channel.
 * The link is `<server>/api/webhooks/<id>/<token>`, and the token holds what the server needs to
 * post for it: the space, its write token, the webhook's own key to seal with, the key it signs
 * with, and its channel. So the server reads what a webhook posts, while it posts it. Nothing
 * else in the space is sealed with the webhook's key, so the link opens nothing else.
 *
 * server/src/webhooks.mjs reads the same token. Change both together.
 */

const TOKEN_VERSION = 1

export interface NewHook {
  id: string
  pub: string
  /** The secret half of `pub`, hex. */
  seed: string
  /** Its own key, base64. */
  key: string
}

/** A webhook's id, from its key: digits, as Discord's are. */
export async function hookId(pub: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pub)))
  let n = 0n
  for (const byte of digest.subarray(0, 8)) n = (n << 8n) | BigInt(byte)
  return String((n % 900_000_000_000_000_000n) + 100_000_000_000_000_000n)
}

export async function makeHook(): Promise<NewHook> {
  const secret = schnorr.utils.randomSecretKey()
  const pub = toHex(schnorr.getPublicKey(secret))
  return { id: await hookId(pub), pub, seed: toHex(secret), key: toBase64(crypto.getRandomValues(new Uint8Array(32))) }
}

export function hookToken(room: string, write: string, hook: { key: string; seed: string; channel: string }): string {
  if (!/^[0-9a-f]{32}$/.test(room) || !/^[0-9a-f]{64}$/.test(write)) throw new Error('That is not a space.')
  const key = fromBase64(hook.key)
  const channel = new TextEncoder().encode(hook.channel)
  const out = new Uint8Array(1 + 16 + 32 + 32 + 32 + channel.length)
  out[0] = TOKEN_VERSION
  out.set(fromHex(room), 1)
  out.set(fromHex(write), 17)
  out.set(key, 49)
  out.set(fromHex(hook.seed), 81)
  out.set(channel, 113)
  return toBase64Url(out)
}

export function hookUrl(server: string, room: string, write: string, hook: { id: string; key: string; seed: string; channel: string }): string {
  return `${server.replace(/\/+$/, '')}/api/webhooks/${hook.id}/${hookToken(room, write, hook)}`
}
