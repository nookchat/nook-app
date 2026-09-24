/**
 * The Cathode server.
 *
 * A space that runs on a server is kept here, in Postgres: every event, sealed
 * on the device that wrote it with a key made from the space code, which this
 * never sees. Everything a space does goes over one WebSocket per space:
 * history, writes, everybody else's writes the moment they are kept, and the
 * signals that start calls. It also keeps each person's sealed record of which
 * spaces are theirs, hands out TURN credentials for calls, and fetches link
 * cards.
 *
 * Several of these can run as a cluster, each run by somebody different, each
 * with its own database. They pull from one another all the time, so every
 * space is on all of them, and a space outlives any one of them going away.
 *
 * It holds ciphertext and cannot read it, and every event inside is signed and
 * checked by the devices on the way back in, so it cannot forge any either.
 *
 *   node server/server.mjs                      with DATABASE_URL set
 *   docker compose -f server/docker-compose.yml up -d
 *
 * See server/README.md, and GET /api/v1/openapi.json on a running server.
 */

import { createServer } from 'node:http'
import { handle } from './src/api.mjs'
import { startCluster } from './src/cluster.mjs'
import { ANY_ORIGIN, CLUSTERED, HAS_TURN, ORIGINS, PEERS, PORT, TURN_ONLY, TURN_URLS, VERSION } from './src/config.mjs'
import { migrate, pool, ready } from './src/db.mjs'
import { importFiles } from './src/import.mjs'
import { closeAll, upgrade } from './src/sockets.mjs'

await ready()
await migrate()
await importFiles()

const server = createServer((req, res) => void handle(req, res))
server.on('upgrade', upgrade)
// Long polls between servers wait up to 25 seconds; keep their sockets open past that.
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000

server.listen(PORT, () => {
  console.log(
    `[cathode] ${VERSION} on :${PORT}, keeping spaces in Postgres, ` +
      `${HAS_TURN ? `TURN at ${TURN_URLS.join(' ')}${TURN_ONLY ? ' for every call' : ''}` : 'no TURN'}, ` +
      `${ANY_ORIGIN ? 'any page' : `pages from ${ORIGINS.join(' ')}`}, ` +
      `${CLUSTERED ? `cluster of ${PEERS.length + 1}` : 'no cluster'}`,
  )
  startCluster()
})

/*
 * A container is stopped with SIGTERM, and node as the first process ignores
 * it, so docker waits ten seconds and kills it. Close on the signal instead:
 * every write is committed before it is acknowledged, so nothing is lost.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    closeAll()
    server.close(() => void pool.end().finally(() => process.exit(0)))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
