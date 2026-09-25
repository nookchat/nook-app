import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DATA } from './config.mjs'
import { pool } from './db.mjs'
import { append, PERSON, ROOM, takeClaim, takePerson } from './store.mjs'

const MARK = '.imported-to-postgres'
const TOKEN_HASH = /^[0-9a-f]{64}$/
const BATCH = 1000

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
    /* no me/ directory */
  }
  if (rooms.length === 0 && people.length === 0) return
  console.log(`[cathode] moving ${rooms.length} spaces and ${people.length} records from ${DATA} into the database`)

  for (const name of rooms) {
    const room = name.slice(0, -6)
    try {
      const token = (await readFile(join(DATA, `${room}.token`), 'utf8')).trim()
      if (TOKEN_HASH.test(token)) await takeClaim(room, Buffer.from(token, 'hex'))
    } catch {
      /* never claimed */
    }
    let batch = []
    const lines = createInterface({ input: createReadStream(join(DATA, name)), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line) continue
      batch.push(line)
      if (batch.length === BATCH) {
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
      if (typeof record.blob === 'string' && TOKEN_HASH.test(token)) {
        await takePerson(id, Buffer.from(token, 'hex'), record.blob, Math.floor(updated))
      }
    } catch {
      /* a record that cannot be read is left where it is */
    }
  }

  await pool.query(`update lines set origin = '' where origin = 'import'`)
  await writeFile(join(DATA, MARK), new Date().toISOString() + '\n')
  console.log('[cathode] moved')
}
