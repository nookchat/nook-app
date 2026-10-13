import { createHash } from 'node:crypto'
import { pool } from './db.mjs'
import { ApiError } from './http.mjs'

export const VAULT_ID = /^[0-9a-f]{32}$/
/** A vault holds a key, a name and a few server addresses, sealed: a few kilobytes. */
export const MAX_VAULT = 64 * 1024

const sha256 = (text) => createHash('sha256').update(text).digest()

/** A sealed account that a passkey or a recovery key opens. The server sees only the sealed string. */
export async function vault(id) {
  const { rows } = await pool.query('select blob from vaults where id = $1', [id])
  if (!rows[0]) throw new ApiError(404, 'not_found', 'There is no account kept under that key.')
  return { blob: rows[0].blob }
}

/** The first write claims the vault with a token. Only that token changes or removes it. */
export async function putVault(id, token, blob) {
  if (typeof token !== 'string' || !token) throw new ApiError(403, 'wrong_token', 'A vault needs its write token.')
  if (typeof blob !== 'string' || blob.length === 0 || blob.length > MAX_VAULT) {
    throw new ApiError(413, 'too_large', 'A vault is one sealed string of at most 64 KiB.')
  }
  const { rowCount } = await pool.query(
    `insert into vaults (id, token_hash, blob, updated) values ($1, $2, $3, $4)
     on conflict (id) do update set blob = excluded.blob, updated = excluded.updated
     where vaults.token_hash = excluded.token_hash`,
    [id, sha256(token), blob, Date.now()],
  )
  if (!rowCount) throw new ApiError(403, 'wrong_token', 'That is not the write token this vault was claimed with.')
  return { ok: true }
}

export async function deleteVault(id, token) {
  if (typeof token !== 'string' || !token) throw new ApiError(403, 'wrong_token', 'A vault needs its write token.')
  const { rowCount } = await pool.query('delete from vaults where id = $1 and token_hash = $2', [id, sha256(token)])
  if (!rowCount) throw new ApiError(403, 'wrong_token', 'That is not the write token this vault was claimed with.')
  return { ok: true }
}
