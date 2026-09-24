/**
 * The old file store, moved into the database once.
 *
 * Before Postgres, a space was a .jsonl file of sealed lines beside a .token
 * file, and a person's record was a .json file under me/. A server upgraded
 * from that finds its files still in CATHODE_DATA; they are read in, in order,
 * and a marker is left so it happens once. The files themselves are left
 * alone, for anybody who wants them back.
 */

import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { DATA } from './config.mjs'
import { pool } from './db.mjs'
import { append, PERSON, ROOM, takeClaim, takePerson } from './store.mjs'

const MARK = '.imported-to-postgres'

export async function importFiles() {
  let names
  try {
    names = await readdir(DATA)
  } catch {
    return
  }
  if (names.includes(MARK)) return
  const rooms = names.filter((n) => n.endsWith('.jsonl') && ROOM.test(n.slice(0, -6)))
  let people = []
  try {
    people = (await readdir(join(DATA, 'me'))).filter((n) => n.endsWith('.json') && PERSON.test(n.slice(0, -5)))
  } catch {
    /* no records */
  }
  if (rooms.length === 0 && people.length === 0) return
  console.log(`[cathode] moving ${rooms.length} spaces and ${people.length} records from ${DATA} into the database`)

  for (const name of rooms) {
    const room = name.slice(0, -6)
    try {
      const token = (await readFile(join(DATA, `${room}.token`), 'utf8')).trim()
      if (/^[0-9a-f]{64}$/.test(token)) await takeClaim(room, Buffer.from(token, 'hex'))
    } catch {
      /* never claimed */
    }
    let batch = []
    const lines = createInterface({ input: createReadStream(join(DATA, name)), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line) continue
      batch.push(line)
      if (batch.length === 1000) {
        await append(room, batch, 'import')
        batch = []
      }
    }
    if (batch.length) await append(room, batch, 'import')
  }

  for (const name of people) {
    const id = name.slice(0, -5)
    try {
      const record = JSON.parse(await readFile(join(DATA, 'me', name), 'utf8'))
      const token = (await readFile(join(DATA, 'me', `${id}.token`), 'utf8')).trim()
      const updated = record.at ?? (await stat(join(DATA, 'me', name))).mtimeMs
      if (typeof record.blob === 'string' && /^[0-9a-f]{64}$/.test(token)) {
        await takePerson(id, Buffer.from(token, 'hex'), record.blob, Math.floor(updated))
      }
    } catch {
      /* a record that cannot be read is left where it is */
    }
  }

  // Lines kept by the import are this server's own from here on.
  await pool.query(`update lines set origin = '' where origin = 'import'`)
  await writeFile(join(DATA, MARK), new Date().toISOString() + '\n')
  console.log('[cathode] moved')
}
